# pCloud バックエンド — 調査資料

`plan.md` の根拠となる調査メモ。コードベースの抽象契約、Drive 実装の踏襲パターン、pCloud
HTTP API 仕様、設計批評（インターフェイスの歪みと修正方針）をまとめる。

---

## 1. 既存の抽象契約（pCloud が満たすべき contract）

### `IFileSystem`（`src/fs/interface.ts`）
パスは sync root からの相対・`/` 区切り・前後スラッシュ無し。必須 9 メソッド + 任意 2:

| メソッド | 概要 |
|---|---|
| `list(): Promise<FileEntity[]>` | root から再帰全件。`hash` は `""` 可（性能優先） |
| `stat(path): Promise<FileEntity \| null>` | 単一メタ。無ければ null |
| `read(path): Promise<ArrayBuffer>` | 内容取得。無い/ディレクトリは throw |
| `write(path, content, mtime): Promise<FileEntity>` | 作成/上書き。親自動作成。`mtime`=epoch ms |
| `mkdir(path): Promise<FileEntity>` | 親含め作成。冪等 |
| `listDir(path): Promise<FileEntity[]>` | 直下のみ（非再帰）。無ければ `[]` |
| `delete(path): Promise<void>` | ファイル/ディレクトリ再帰削除。冪等。soft-delete 可 |
| `rename(oldPath, newPath): Promise<void>` | 移動/改名。親自動作成。old 不在/new 既存は throw |
| `getChangedPaths?()` | 任意。`{modified, deleted, renamed?}` or null（増分検出） |
| `close?()` | 任意。アンロード時の解放 |

### `FileEntity`（`src/fs/types.ts`）
```ts
interface FileEntity {
  path: string;
  isDirectory: boolean;
  size: number;          // dir は 0
  mtime: number;         // epoch ms。sentinel 0 = unknown
  hash: string;          // SHA-256 hex。sentinel "" = 未計算。dir は常に ""
  backendMeta?: Record<string, unknown>; // Drive id / contentChecksum 等
}
```
※ Phase 0(B) で `remoteChecksum?: { algo, value }` を追加し、checksum を backendMeta から分離する。

### `IBackendProvider`（`src/fs/backend.ts`）
必須: `type` / `displayName` / `auth` / `createFs(app, settings, logger): IFileSystem|null` /
`isConnected(settings)` / `getIdentity(settings): string|null` / `disconnect(settings)`。
任意: `resetTargetState` / `hasCheckpoint` / `readBackendState(fs, commitCheckpoint)` /
`resolveRemoteVault(app, settings, vaultName, logger)`。
`getBackendData<T>(settings, type)` ヘルパで `settings.backendData[type]` を取得。

### `IAuthProvider`（`src/fs/auth.ts`）
```ts
interface IAuthProvider {
  isAuthenticated(backendData): boolean;
  startAuth(backendData): Promise<Record<string, unknown>>;       // 認証開始、保存する state を返す
  completeAuth(input, backendData): Promise<Record<string, unknown>>; // callback で完了
}
```

### レジストリ / 設定 / UI
- `src/fs/registry.ts` — `initRegistry(secretStore)` で provider 配列を構築。pCloud は
  `new PCloudProvider(secretStore)` を追加。`getBackendProvider(type)` / `getAllBackendProviders()`。
- `src/settings.ts` — `AirSyncSettings.backendType: string`（既定 `"googledrive"`）、
  `backendData: Record<string, Record<string, unknown>>`（type 別の永続データ）。
- `src/ui/settings.ts` — `backends.length > 1` のときバックエンド選択 dropdown を表示
  （pCloud 追加で自動的に出る）。選択した type の renderer を `getBackendSettingsRenderer` で取得し描画。
- `src/ui/backend-settings.ts` — `IBackendSettingsRenderer { backendType; render(...) }` と
  `renderers[]` レジストリ。pCloud は `new PCloudSettingsRenderer()` を追加。
- `src/fs/token-store.ts` — トークンは Obsidian SecretStorage に保存（`backendData` には入れない）。
  キー `air-sync-${type}-${name}-token`。※ Phase 0(A) で不透明 API へ一般化。

### バックエンドのライフサイクル（`src/fs/backend-manager.ts`）
```
Connect クリック → startBackendConnect → auth.startAuth(backendData) → ブラウザ OAuth
→ obsidian:// で復帰 → completeBackendConnect(url) → auth.completeAuth(url, backendData)
→ (token は SecretStorage へ) → resolveRemoteVault?() → createFs() → onConnected(remoteFs)
```
`initBackend` は起動時/設定変更時に provider を解決し `createFs`。identity 変化で
`resetTargetState` + `onIdentityChanged`。`readBackendState(fs, commitCheckpoint)` は毎同期後に
backendData へ反映（`commitCheckpoint = (failed===0)`）。

---

## 2. Google Drive 実装（pCloud の雛形）

ディレクトリ `src/fs/googledrive/`:
- `index.ts` — `GoogleDriveFs implements IFileSystem`。`cacheMutex` で直列化、`ensureInitialized`→
  `fullScan`（**listing 前に** `getChangesStartToken` でカーソル先取り）→ `DriveMetadataCache` 構築。
  `list()` は cache から、`stat/read` は cache 解決した id で。`write` は親 `ensureFolder`→`uploadFile`、
  応答から `FileEntity`（`backendMeta:{ driveId, contentChecksum: md5Checksum }`）。`getChangedPaths` は
  `changes.list` 増分→`{modified, deleted, renamed}`、カーソル失効(410)で `fullScanWithDelta`。
- `metadata-cache.ts` — `DriveMetadataCache`。path↔id・親子・`removeTree`/`rewriteChildPaths`/
  `driveFileToEntity`。
- `incremental-sync.ts` — `applyIncrementalChanges` で changes をキャッシュへ適用。
- `client.ts` — REST ラッパ。`requestUrl()` のみ使用（`fetch` 禁止）。
- `auth.ts` — `GoogleAuthBase`（token 保存/refresh 重複排除/CSRF state/revoke）。組込 `GoogleAuth` は
  token 交換をワーカー(`auth-airsync.takezo.dev/google/...`)に委譲。`/google/token/refresh` で更新。
- `provider-base.ts` / `provider.ts` — provider 実装。`createFs` は `readTokens`→`DriveClient`→
  `MetadataStore<DriveFile>`(`${vaultId}-${remoteVaultFolderId}`, prefix `air-sync-drive`)→`GoogleDriveFs`。
  `readBackendState` は成功時のみ `changesStartPageToken` をコミット、refreshed token を SecretStorage へ。
- UI: `src/ui/googledrive-settings.ts`（接続状態＋Connect/Disconnect）。

### 変更検出のメカニクス（重要）
`src/sync/change-compare.ts` `hasRemoteChanged(file, record)`:
- `mtime>0 && record.remoteMtime>0`: mtime+size 一致→未変更（hash 両在で確認）。差分→
  `contentChecksum`（今回 vs 前回）で判定、無ければ changed。
- それ以外: `contentChecksum`→`hash` の順でフォールバック。
- **→ `backendMeta.contentChecksum` は「同一サイドの時系列比較」用**。内容同一なら安定であれば良く、
  ローカル計算可能である必要はない。pCloud のメタ `hash` がそのまま使える理由。

`src/sync/change-detector.ts` `enrichHashesForInitialMatch`（`~237-268`）:
- 初回（baseline 無し）で local/remote 両在・hash 空・size 一致・`backendMeta.contentChecksum` あり、の
  候補に対し **`md5(content) === contentChecksum`** を判定し、一致すれば両者に SHA-256 を付与
  （= cross-side dedup で無駄な conflict を防ぐ）。
- **MD5 決め打ち**。pCloud `hash` は MD5 でないため不発（安全側に落ちるだけ）。Phase 0(B) で algo
  タグ判定に一般化する。

`contentChecksum` を読む箇所: `change-compare.ts:38-39`、`change-detector.ts:245,256`、
`conflict.ts:326-327`、`state-committer.ts`（`SyncRecord.backendMeta` へ保存）、`sync/types.ts:18`。

---

## 3. pCloud HTTP JSON API（docs.pcloud.com・要点）

> 認証コール時に `result != 0` を必ず検査（HTTP は 200 でも論理エラーを返す）。

### リージョン / ホスト
- US `api.pcloud.com` / EU `eapi.pcloud.com`。**authorize リダイレクト**に `locationid`(1=US,2=EU) と
  `hostname` が乗る（`oauth2_token` 応答には**乗らない**）。→ callback で `hostname` を取得して保存し、
  以降の全 API で使う。
  出典: https://docs.pcloud.com/methods/oauth_2.0/authorize.html

### OAuth2（2 フロー: code / token-implicit）— PKCE は無い（2026-06-06 再調査・Playwright）
pCloud は OAuth で 2 フローを提供する。**PKCE は非対応**（authorize / oauth2_token / authentication の
いずれにも `code_challenge`/`code_verifier` が無いことを一次情報で確認）。
- **Code フロー**（現行実装）: authorize `?response_type=code` → リダイレクトで
  `code`/`state`/`locationid`/`hostname`（query）→ `POST https://{hostname}/oauth2_token`
  （**`client_id`+`client_secret`+`code` が必須**）→ `{ result:0, access_token, token_type:"bearer", uid }`。
  secret が要るので **worker 等のサーバ側交換が前提**。
- **Token(implicit) フロー**: authorize `?response_type=token` → bearer token を **URI フラグメント**
  (`#access_token=…&token_type=bearer&uid=…&state=…&locationid=…&hostname=…`) で直接返す。
  **secret も二次呼び出しも不要**だが、フラグメントはサーバに送られず OS のプロトコルハンドラも確実に
  渡さないため、**client-side の中継ページ（`pages/`）でフラグメント→`obsidian://` 変換が事実上必須**。
- **refresh token 無し・access token は時間失効しない**（pCloud 公式 SDK の oauth.md が「OAuth 発行トークンは
  expire しない」と明記。一般トークンモデルの `expire`/`expire_inactive` は持つが OAuth では実質非失効）。
  → リフレッシュ機構は不要。失効はリアクティブに扱う。
- **scope は常に全アカウント**（縮小不可。`permissions` の追加は `manageshares` のみ）。Dropbox の
  App Folder のような限定は無い。
- redirect_uri は **アプリ設定で事前登録必須**（未登録は "redirect_uri not authorized"）。カスタムスキームは
  ネイティブ向けに許容（Swift SDK 等が登録）だが、上記フラグメント問題のため `obsidian://` 直接受けは非推奨。
  出典: docs.pcloud.com の authorize / oauth2_token / intro-authentication、pCloud 公式 SDK
  https://github.com/pCloud/pcloud-sdk-js/blob/master/docs/oauth.md 。

### 認証付き呼び出し
- 全メソッドで **`auth=<access_token>` クエリ**（Bearer ヘッダではない）。root は `folderid=0`。
  全エンドポイントが `path=/abs/...` か `fileid`/`folderid` のどちらでも可。
  出典: https://docs.pcloud.com/methods/intro/authentication.html

### メタデータ（`src/structures/metadata`）
- 共通: `id`("d"/"f"接頭)/`name`/`parentfolderid`/`isfolder`/`created`/`modified`。
- ファイル: `fileid`/`size`/`contenttype`/`hash`(64bit 整数・**content 変化検出用、暗号学的でない**)/`category`。
- フォルダ: `folderid`/`contents[]`。
- `modified` は datetime（要 epoch 換算）。**`contenthash` フィールドは無い**。`hash` は変更検出/重複検出向け。
  出典: https://docs.pcloud.com/structures/metadata.html

### 主要メソッド
| 用途 | メソッド | 要点 |
|---|---|---|
| 一覧 | `listfolder` | `folderid`/`path`、`recursive`/`nofiles`。`metadata.contents[]` |
| メタ | `stat` | `fileid`/`path` |
| チェックサム | `checksumfile` | SHA1=US/EU 共通、MD5=US のみ、SHA256=EU のみ |
| DL リンク | `getfilelink` | `{hosts[], path, expires}` → `https://{hosts[0]}{path}` を GET |
| アップロード | `uploadfile` | multipart POST。`folderid`/`path`+ファイル part。`mtime`(epoch 秒)で更新時刻設定。応答 `metadata[]` |
| フォルダ作成 | `createfolder` / `createfolderifnotexists` | `folderid`+`name` 推奨。後者は冪等 |
| 削除 | `deletefile` / `deletefolder`(空のみ) / `deletefolderrecursive` | 後者は `{deletedfiles, deletedfolders}` |
| 改名/移動 | `renamefile` / `renamefolder` | `toname`/`tofolderid`/`topath`。1 コールで改名+移動可 |
| 増分 | `diff` | `diffid`/`last`/`block`/`limit`。`{diffid, entries:[{diffid,time,type,metadata}]}` |

- ダウンロードは `getfilelink`→別ホストへ GET（api ホストではない）。
- `diff` は **アカウント全体**のイベント。`block=1` で長ポーリング可（本計画は非ブロッキング）。
  state が 6 ヶ月超古いと再取得推奨（→ 失効時フルスキャン）。
  出典: listfolder/stat/checksumfile/getfilelink/uploadfile/createfolder(ifnotexists)/deletefile/
  deletefolder(recursive)/renamefile/renamefolder/diff の各 docs.pcloud.com ページ。

### 実装前に実 API で検証する点（推測で固めない）
- `uploadfile` の multipart を Obsidian `requestUrl`（FormData 非対応）でどう送るか（boundary 手組み）。
- `diff` の正確なイベント名、rename/move の表現、**delete イベントの metadata 形**（パスを含まない→
  キャッシュで逆引き）、baseline diffid の取得法（`diff?last=1` 応答の top-level `diffid`）。
- 認証/失効系の `result` コード（例 1000/2000/2094/2095）と file/folder not found（2009/2005 等）。

---

## 4. 設計批評 — インターフェイスの歪みと修正方針

pCloud を Drive 形状の抽象へ載せると 2 箇所で「無理やり合わせる」歪みが出る。いずれも
**ダミー値で押し込まず、型・名前で正直に一般化する**方針（ユーザー確認済み）。

### (A) token-store の `{refreshToken, accessToken}` は OAuth ペアを強制
- pCloud は refresh を持たないため「ダミー refresh」を作る誘惑が生じる（=却下）。
- → 不透明な名前付きシークレット API（`setBackendSecret`/`getBackendSecret`/`hasBackendSecret`/
  `clearBackendSecrets`）へ一般化。Drive=`refresh`/`access`、pCloud=`access` のみ。保存キー形式は
  維持し既存 Drive ユーザーの再接続を不要にする。

### (B) リモート checksum が型なしバッグ + 暗黙 MD5 前提
- `FileEntity.hash`("SHA-256"と明記) はリモートで `""`、実体は `backendMeta.contentChecksum`
  （型なし・`as string` 多用）。`enrichHashesForInitialMatch` は MD5 決め打ち。
- pCloud `hash` は MD5 でなく**ローカル計算不可**→ 最適化が静かに不発になり設計の嘘が露呈。
- → `FileEntity.remoteChecksum?: { algo:"md5"|"sha1"|"sha256"|"opaque"; value }` へ昇格。
  時系列比較は `value`（algo 非依存）、cross-side dedup は `algo` がローカル計算可能なときのみ。
  pCloud=`opaque`（明示的にスキップ）。将来 `checksumfile` の SHA-1 を `algo:"sha1"` で出せば
  dedup も自動で有効化（受け皿だけ先に用意）。

### (C) 認証フローの選択 — worker/secret は要るか（再検討・2026-06-06）
Dropbox 計画で「PKCE により secret を持たず token も履歴に出さない」を両立できたため、pCloud も
同様に secretless 化できるか再検討した。**結論: pCloud では両立できない**（PKCE が無いため）。

- pCloud で secretless にできるのは **implicit フロー一択**。それは強力なトークンを
  **pages ドメインのブラウザ履歴（フラグメント）に乗せる**（`history.replaceState` で初回後はスクラブ可だが、
  初回ナビゲーション時点では URL に載る）。
- pCloud のトークンは **非失効・全アカウント権限**と特に強力。これを履歴に出す implicit のコストは、
  Dropbox の App Folder・短命トークンより**重い**。
- 現行 **Code フロー**は、履歴に乗るのは使い捨ての `code` のみで、強力トークンは worker のサーバ側交換に
  閉じ最終 `obsidian://` href にしか現れない（履歴に残らない）。secret 1 個の管理コストと引き換えに
  トークン取り扱いが堅い。
- **評価（推奨）: pCloud は Code フロー＋worker secret を維持**。secret を 1 個消すために非失効・全アカウント
  トークンの取り扱いを緩めるのは割に合わない。Dropbox(=PKCE 無シークレット) とは**バックエンドごとに最適が
  異なる**という結論。役割分担は worker=「confidential 経路（Google 組込の refresh + pCloud の code 交換）」、
  pages/callback=「無シークレット経路（Google custom / Dropbox PKCE）」。

### 軽微（opportunistic）
- `IAuthProvider.isAuthenticated(backendData)` の `backendData` は Drive/pCloud とも未使用
  （真実源は SecretStorage）。シグネチャが形骸化。
- Drive の `parseAuthCallbackParams` は Drive 専用。pCloud は `hostname` も要るため別実装で良い
  （無理な共通化はしない）。

---

## 5. 主要ファイル索引

| 対象 | パス |
|---|---|
| FS 契約 | `src/fs/interface.ts` / `src/fs/types.ts` |
| Backend/Auth 契約 | `src/fs/backend.ts` / `src/fs/auth.ts` |
| レジストリ | `src/fs/registry.ts` |
| token-store | `src/fs/token-store.ts` |
| backend-manager | `src/fs/backend-manager.ts` |
| Drive 実装 | `src/fs/googledrive/{index,metadata-cache,incremental-sync,client,auth,provider,provider-base,types}.ts` |
| 変更検出 | `src/sync/{change-compare,change-detector,conflict,state-committer,types}.ts` |
| remote-vault 定数 | `src/sync/remote-vault.ts`（`REMOTE_VAULT_ROOT`, `INTERNAL_METADATA_PATH`） |
| contract テスト | `src/fs/remote-change-detection-contract.ts` |
| 設定/UI | `src/settings.ts` / `src/ui/{settings,backend-settings,googledrive-settings}.ts` |
| OAuth ワーカー | `oauth-worker/src/{index,oauth,types}.ts` / `oauth-worker/wrangler.toml` |
| OAuth ページ | `pages/callback/index.html` / `docs/oauth-worker.md` |
