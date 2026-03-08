# 同期フロー再設計: Change-Driven Sync

## Context

現在の同期フローは「スナップショット比較モデル」:
```
全ローカルファイル列挙 + 全リモートキャッシュ読込 + 全SyncRecord読込
  → 全件比較 → 差分実行
```

ファイル数が増えると、変更が0件でも IndexedDB からの全レコード読込コストが O(n) かかる。

**目標**: 通常の sync を O(delta) に。フルスキャンは初回・フォールバック時のみ。

## 設計: Change-Driven Sync

**核心**: 「全件読込→全件比較」を「変更検出→変更分だけ処理」に変える。

### 現在のフロー
```
executeSyncOnce():
  localFiles  = localFs.list()       // vault全列挙（高速、メモリ内）
  remoteFiles = remoteFs.list()      // IDBキャッシュ全読込（遅い）
  syncRecords = stateStore.getAll()  // IDB全レコード読込（遅い）
  entities    = buildMixedEntities(localFiles, remoteFiles, syncRecords)  // O(n)
  decisions   = computeDecisions(entities)  // O(n)
  executor.execute(decisions)
```

### 新フロー
```
executeSyncOnce():
  // Phase 1: 変更検出（低コスト）
  localDelta  = detectLocalChanges()   // スナップショット diff or vault イベント
  remoteDelta = detectRemoteChanges()  // フォルダ階層 + changes.list API

  changedPaths = localDelta ∪ remoteDelta

  if changedPaths is empty:
    return "up to date"                // IDB全読込なし、即リターン

  if changedPaths.size > THRESHOLD or deltaUnreliable:
    return fullReconciliation()        // 従来のフルスキャン

  // Phase 2: 変更分だけ処理（O(delta)）
  entities = buildChangedEntities(changedPaths, ...)
  //   内部: localFs.stat(path)  → O(1) メモリ内
  //         remoteDelta のメタデータ or SyncRecord → キャッシュ不要
  //         stateStore.get(path)  → O(1) IDB個別取得

  decisions = computeDecisions(entities)
  executor.execute(decisions)           // ← ここで初めてフルキャッシュをロード
                                        //    (read/write/delete に DriveID が必要)

  // Phase 3: 状態更新
  saveLocalSnapshot()
  saveRemoteToken()
```

### リモート変更検出のキャッシュ不要化

**問題**: 現在の `applyIncrementalChanges()` は `resolvePathFromCache()` でパスを解決するため、
フルキャッシュ（全ファイルの path↔ID マッピング）が必要。

**解決策**: フォルダ階層だけを別途保存し、軽量なパス解決を実現する。

```
全キャッシュ: 10K レコード (ファイル + フォルダ) → IDB 読込 ~100-200ms
フォルダ階層: ~100 レコード → 1 blob として IDB 読込 ~1-5ms
```

**フォルダ階層ストア**:
```typescript
interface FolderHierarchy {
  /** folderId → { name, parentId } */
  folders: Record<string, { n: string; p: string }>;
  rootFolderId: string;
}
```

**パス解決**: parentId チェーンを rootFolderId まで遡ってパスを構築。
`applyIncrementalChanges()` はフォルダ階層のみでパス解決可能:
- フォルダ変更 → 階層を更新
- ファイル変更 → 親フォルダ ID から階層を辿ってパス解決

**デルタ sync での remote FileEntity 構築**:
- リモートで変更されたファイル → `changes.list` の DriveFile メタデータから直接構築
- リモートで変更されていないファイル → `remoteFs.stat()` を呼ばず、SyncRecord の
  `remoteMtime`/`remoteSize`/`backendMeta` を使って「変更なし」を表現
  （`hasRemoteChanged()` が false を返すので正しい）

**フルキャッシュの遅延ロード**:
- 変更検出フェーズ: フォルダ階層のみ使用（フルキャッシュ不要）
- 実行フェーズ: `remoteFs.read()/write()/delete()` が呼ばれた時点で
  `ensureInitialized()` → フルキャッシュを IDB からロード
- 変更なしの場合: フルキャッシュは一切ロードされない

## コンポーネント設計

### 1. LocalChangeDetector（新規: `src/sync/local-change-detector.ts`）

ローカル側の変更検出を担当。2つのモード:

**起動時モード**: 保存済みスナップショットと現在の vault を diff
```typescript
export interface LocalFileSnapshot {
  /** path → { mtime, size } */
  files: Record<string, { m: number; s: number }>;
}

export class LocalChangeDetector {
  private vault: Vault;
  private changedPaths = new Set<string>();
  private tracking = false;
  private snapshot: LocalFileSnapshot | null = null;

  /** 起動時: スナップショットをロードし、vault と diff して変更パスを検出 */
  async detectStartupChanges(): Promise<Set<string> | null> {
    this.snapshot = await this.loadSnapshot();
    if (!this.snapshot) return null;  // スナップショットなし → フルスキャン

    const changes = new Set<string>();
    const currentFiles = new Map<string, { m: number; s: number }>();

    for (const file of this.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFile)) continue;
      currentFiles.set(file.path, { m: file.stat.mtime, s: file.stat.size });

      const prev = this.snapshot.files[file.path];
      if (!prev) {
        changes.add(file.path);  // 新規追加
      } else if (prev.m !== file.stat.mtime || prev.s !== file.stat.size) {
        changes.add(file.path);  // 変更
      }
    }

    // 削除されたファイル
    for (const path of Object.keys(this.snapshot.files)) {
      if (!currentFiles.has(path)) {
        changes.add(path);
      }
    }

    return changes;
  }

  /** ランタイム: vault イベントからの変更追跡 */
  trackChange(path: string): void { ... }
  trackRename(oldPath: string, newPath: string): void { ... }

  /** sync完了後: 現在の vault 状態をスナップショットとして保存 */
  async saveSnapshot(): Promise<void> { ... }

  /** 変更パスを取得してリセット */
  consume(): Set<string> | null { ... }
}
```

**コスト**: `vault.getAllLoadedFiles()` (~1ms) + Map diff (~5ms) + IDB 1レコード読込 (~5ms) ≈ **~10ms**
（従来の `stateStore.getAll()` は ~100-200ms）

### 2. Remote 変更パス抽出（`src/fs/googledrive/incremental-sync.ts` 修正）

`applyIncrementalChanges()` は内部で `updatedRecords` と `deletedPaths` を既にトラッキングしている。
返り値にこれらのパスを追加するだけ:

```typescript
// 現在の返り値
{ newToken: string; needsFullScan: false } | { needsFullScan: true }

// 新しい返り値
{ newToken: string; needsFullScan: false; changedPaths: Set<string> }
| { needsFullScan: true }
```

さらに、フォルダ階層のみでパス解決できるよう `applyIncrementalChanges()` を拡張:
- 現在: `cache.resolvePathFromCache(file)` → フルキャッシュの `idToPath` が必要
- 新規: `folderHierarchy` からパスを解決する軽量版を追加

### 3. GoogleDriveFs の修正（`src/fs/googledrive/index.ts`）

**起動時のインクリメンタル適用**: 現在、最初の `list()` はキャッシュ読込のみでインクリメンタル適用をスキップ。
修正して、キャッシュ読込後にインクリメンタルも適用:

```typescript
async list(): Promise<FileEntity[]> {
  return this.cacheMutex.run(async () => {
    if (!this.initialized) {
      const loaded = await this.loadFromCache();
      if (!loaded) {
        await this.fullScan();
      } else if (this._changesPageToken) {
        await this._applyIncrementalChanges();  // 追加: 起動時も適用
      }
    } else if (this._changesPageToken) {
      await this._applyIncrementalChanges();
    }
    // ...
  });
}
```

**新メソッド**: `getRemoteChangedPaths()` — フルキャッシュ不要の軽量版:
```typescript
/**
 * フォルダ階層のみロードし、インクリメンタル変更を適用して変更パスを返す。
 * フルキャッシュはロードしない（実行フェーズまで遅延）。
 */
async getRemoteChangedPaths(): Promise<{
  changedPaths: Set<string>;
  changedFiles: Map<string, FileEntity>;  // 変更ファイルのメタデータ
} | null> {
  return this.cacheMutex.run(async () => {
    // フォルダ階層 + トークンのみロード（~1-5ms）
    const hierarchy = await this.loadFolderHierarchy();
    if (!hierarchy || !this._changesPageToken) return null;

    // changes.list API → フォルダ階層でパス解決 → 変更パス特定
    const result = await applyIncrementalChangesLightweight(
      this.client, hierarchy, this._changesPageToken, this.logger
    );

    if (result.needsFullScan) return null;

    this._changesPageToken = result.newToken;
    // フォルダ階層の変更を永続化
    if (result.hierarchyChanged) await this.saveFolderHierarchy(hierarchy);

    return {
      changedPaths: result.changedPaths,
      changedFiles: result.changedFiles,  // DriveFile → FileEntity 変換済み
    };
  });
}
```

### 3b. フォルダ階層ストア（`src/fs/googledrive/folder-hierarchy.ts` 新規）

```typescript
export interface FolderHierarchy {
  folders: Map<string, { name: string; parentId: string }>;
  rootFolderId: string;
}

/** フォルダ ID チェーンを辿ってパスを解決 */
export function resolvePathFromHierarchy(
  hierarchy: FolderHierarchy,
  parentId: string,
  fileName: string,
): string | null {
  const parts: string[] = [fileName];
  let currentId = parentId;
  while (currentId !== hierarchy.rootFolderId) {
    const folder = hierarchy.folders.get(currentId);
    if (!folder) return null;  // 不明なフォルダ → 解決不能
    parts.unshift(folder.name);
    currentId = folder.parentId;
  }
  return parts.join("/");
}
```

フォルダ階層は既存 `MetadataStore` の meta エントリとして保存:
- キー: `folderHierarchy`
- 値: JSON blob (~5KB for 100 folders)
- `fullScan()` と `applyIncrementalChanges()` の完了時に更新

### 4. SyncStateStore の拡張（`src/sync/state.ts`）

```typescript
/** 複数パスのレコードを1トランザクションで取得 */
async getMany(paths: string[]): Promise<SyncRecord[]> {
  return this.helper.runTransaction(STORE_NAME, "readonly", (tx) => {
    const store = tx.objectStore(STORE_NAME);
    const requests = paths.map(p => store.get(p));
    return () => requests
      .map(r => r.result as SyncRecord | undefined)
      .filter((r): r is SyncRecord => r !== undefined);
  });
}

/** ローカルスナップショットの保存/読込 */
async saveLocalSnapshot(snapshot: LocalFileSnapshot): Promise<void> { ... }
async loadLocalSnapshot(): Promise<LocalFileSnapshot | null> { ... }
```

スナップショットは CONTENT_STORE_NAME に特殊キー `__localSnapshot` で保存。
10K ファイルで ~400KB JSON。1レコードなので読込は高速。

### 5. Sync Engine の拡張（`src/sync/engine.ts`）

```typescript
/**
 * 変更パスのみの MixedEntity を構築（O(delta)）。
 * remoteFs.stat() は呼ばない — リモートデルタのメタデータ or SyncRecord を使う。
 */
export async function buildChangedEntities(
  changedPaths: Set<string>,
  localFs: IFileSystem,
  remoteChangedFiles: Map<string, FileEntity>,  // リモートデルタのメタデータ
  stateStore: SyncStateStore,
): Promise<MixedEntity[]> {
  const paths = Array.from(changedPaths);
  const syncRecords = await stateStore.getMany(paths);
  const recordMap = new Map(syncRecords.map(r => [r.path, r]));

  const entities: MixedEntity[] = [];
  for (const path of paths) {
    const local = await localFs.stat(path);  // O(1) メモリ内
    const prevSync = recordMap.get(path);

    const entity: MixedEntity = { path };
    if (local && !local.isDirectory) entity.local = local;

    // リモート: デルタにあればそのメタデータ、なければ SyncRecord から構築
    const remoteFromDelta = remoteChangedFiles.get(path);
    if (remoteFromDelta) {
      entity.remote = remoteFromDelta;
    } else if (prevSync) {
      // リモート未変更 → SyncRecord のリモート情報を「現在のリモート状態」として使う
      // hasRemoteChanged() が false を返すので正しい
      entity.remote = {
        path,
        isDirectory: false,
        size: prevSync.remoteSize,
        mtime: prevSync.remoteMtime,
        hash: prevSync.hash,
        backendMeta: prevSync.backendMeta,
      };
    }
    // remote が null = リモートに存在しない（削除された or 未作成）

    entity.prevSync = prevSync;
    entities.push(entity);
  }

  return entities;
}
```

`computeDecisions()` は変更不要（同じ 3-state ロジック）。

### 6. SyncService のオーケストレーション（`src/sync/service.ts`）

```typescript
private async executeSyncOnce(): Promise<SyncResult> {
  const localFs = this.deps.localFs();
  const remoteFs = this.deps.remoteFs();

  // デルタ検出を試行
  const localDelta = this.changeDetector.consume();
  const remoteDelta = await this.getRemoteDelta(remoteFs);

  const canDoDeltaSync = localDelta !== null && remoteDelta !== null;
  const changedPaths = canDoDeltaSync
    ? union(localDelta, remoteDelta)
    : null;

  let entities: MixedEntity[];

  if (changedPaths !== null && changedPaths.size === 0) {
    // 変更なし → 即リターン
    this.deps.notify("Everything up to date");
    return emptyResult();
  }

  if (changedPaths !== null && changedPaths.size <= DELTA_THRESHOLD) {
    // デルタ sync
    entities = await buildChangedEntities(changedPaths, localFs, remoteFs, this.stateStore);
  } else {
    // フルスキャン（従来通り）
    entities = await buildMixedEntities(localFs, remoteFs, this.stateStore);
  }

  // 以降は現在と同じ: filter → resolveEmptyHashes → computeDecisions → execute
  // ...

  // sync完了後: スナップショット保存 + tracker起動
  await this.changeDetector.saveSnapshot();
  this.changeDetector.activate();
}
```

## ファイル変更一覧

| ファイル | 変更内容 | 新規/修正 |
|----------|----------|-----------|
| `src/sync/local-change-detector.ts` | LocalChangeDetector クラス | 新規 |
| `src/fs/googledrive/folder-hierarchy.ts` | FolderHierarchy + `resolvePathFromHierarchy()` | 新規 |
| `src/sync/engine.ts` | `buildChangedEntities()` 追加 | 修正 |
| `src/sync/service.ts` | デルタ/フル分岐ロジック | 修正 |
| `src/sync/state.ts` | `getMany()`, snapshot 保存/読込 | 修正 |
| `src/fs/googledrive/index.ts` | 起動時インクリメンタル + `getRemoteChangedPaths()` + フォルダ階層管理 | 修正 |
| `src/fs/googledrive/incremental-sync.ts` | 返り値に `changedPaths` 追加 + 軽量版(階層のみ)追加 | 修正 |
| `src/main.ts` | LocalChangeDetector 配線 | 修正 |

## コスト比較

### 変更なしの場合（最も頻繁なケース）
| | 現在 | 新設計 |
|--|------|--------|
| ローカル | `vault.getAllLoadedFiles()` ~1ms | スナップショット diff ~10ms |
| リモート | IDB全キャッシュ読込 ~100-200ms | フォルダ階層読込 ~1-5ms + API 1回 |
| SyncRecord | `getAll()` ~100-200ms | **スキップ** |
| 合計 | **~200-400ms** | **~15-20ms + API latency** |

### 少数変更の場合（5ファイル）
| | 現在 | 新設計 |
|--|------|--------|
| ローカル | 同上 ~1ms | スナップショット diff ~10ms |
| リモート | 同上 ~100-200ms | フォルダ階層 ~1-5ms + API |
| SyncRecord | `getAll()` ~100-200ms | `getMany(5)` ~5ms |
| Entity構築 | 全件 O(n) | 5件のみ O(delta) |
| 合計 | **~200-400ms** | **~20-25ms + API latency** |

### フォールバック時（デルタ不可）
従来と同じフルスキャン。追加コストはスナップショット diff の ~10ms のみ。

## トレードオフ分析

### メリット
- **変更なしケースで ~10-20x 高速化**: IDB 全読込を完全スキップ
- **リモートフルキャッシュの遅延ロード**: 変更なしならフルキャッシュは一切ロードしない
- **コードパスの統一**: 起動時もランタイムも同じデルタ処理フロー（変更検出方法が違うだけ）
- **フォールバック安全**: デルタが信頼できない/大きすぎる場合は従来のフルスキャンに自動切替
- **既存ロジック温存**: `computeDecisions()` と `SyncExecutor` は変更不要

### デメリット・リスク
- **フォルダ階層の整合性**: フォルダ構造がキャッシュと乖離する可能性 → フォルダのリネーム/移動がパス解決ミスを起こす → `null` 返却でフルスキャンにフォールバック
- **スナップショットの整合性**: sync 中断時にスナップショットが古いまま → 余分なパスがデルタに含まれるが、安全側（見逃しなし）
- **2つのインクリメンタル sync パス**: 軽量版(`applyIncrementalChangesLightweight`)と通常版(`applyIncrementalChanges`)の保守コスト
- **`getMany()` のコスト**: 1トランザクション内の個別 `get()` × N。N > 数百件で `getAll()` より遅くなる可能性 → `DELTA_THRESHOLD` で制御
- **API コール追加**: 起動時にリモートインクリメンタル API を呼ぶ。オフライン時は `null` → フルスキャンフォールバック
- **実装の複雑さ**: フォルダ階層管理 + 軽量インクリメンタル + スナップショット管理で新規コード量が多い

## 検証

- `npm run lint && npm run build && npm test`
- 新規テスト: `LocalChangeDetector`, `buildChangedEntities`, `getMany`
- 手動テスト: 大きな vault で起動時 sync 時間を計測（before/after）
- 手動テスト: 1ファイル編集後の sync でデルタパスのみ処理されることをログ確認
- エッジケース: sync中断後の再起動、オフライン起動、スナップショット破損
