# Phase 0 実装計画 — 共有抽象の正直化

`plan.md` の Phase 0 を実装レベルに落とした手順書。pCloud を載せる前に、Drive 専用形状の 2 抽象を
**RED 先行・挙動保存**で型に直す。全行は `npm run lint && npm run build && npm test` のゲートを
各ステップ末で green にしてから次へ進む。

## 原則
- **RED 先行**: 先に失敗するテスト（新 API / 新挙動）を書き、実装で green にする。
- **挙動保存**: Drive の既存挙動は不変（md5 経路はそのまま動く）。新規は加算的（sha1 も効く・opaque は明示スキップ）。
- **保存キー互換**: SecretStorage キー形式 `air-sync-${type}-${name}-token` を維持し、既存 Drive
  ユーザーの再接続を不要にする。
- **コミット境界**: Step A 完了で 1 コミット、Step B 完了で 1 コミット（下記「コミット計画」）。

---

## Step A — token-store を不透明な名前付きシークレットへ一般化

**動機**: `StoredTokens={refreshToken, accessToken}` は OAuth ペアを全 backend に強制し、refresh を
持たない pCloud に「ダミー refresh」を作らせる。不透明な名前付きシークレット API へ置換する。

### A1 (RED) 新 API のテスト — `src/fs/token-store.test.ts`（新規）
`test-helpers.ts` 相当の mock secret store（`Map` ベース）で:
- `setBackendSecret(store, "x", "access", "v")` 後に `getBackendSecret(store,"x","access") === "v"`。
- `hasBackendSecret` の true/false。
- `clearBackendSecrets(store,"x",["refresh","access"])` 後に両方空。
- **キー互換**: `setBackendSecret(store,"googledrive","refresh","r")` が
  既存キー `air-sync-googledrive-refresh-token` に書く（古いコードと相互運用）。
- 空文字 value は `setBackendSecret` でスキップ（旧 `storeTokens` の `if (value)` 挙動）。

### A2 (GREEN) 実装 — `src/fs/token-store.ts`（全面置換）
```ts
function secretKey(type: string, name: string): string {
  return `air-sync-${type}-${name}-token`;          // 形式維持＝後方互換
}
export function setBackendSecret(store, type, name, value): void {
  if (value) store.setSecret(secretKey(type, name), value);
}
export function getBackendSecret(store, type, name): string {
  return store.getSecret(secretKey(type, name)) ?? "";
}
export function hasBackendSecret(store, type, name): boolean {
  return !!store.getSecret(secretKey(type, name));
}
export function clearBackendSecrets(store, type, names: string[]): void {
  for (const n of names) store.setSecret(secretKey(type, n), "");
}
```
`StoredTokens` / `storeTokens` / `readTokens` / `hasRefreshToken` / `clearTokens` / `tokenKey` を撤去。

### A3 呼び出し側の移行（Drive: name=`"refresh"`/`"access"`）
- `src/fs/googledrive/provider-base.ts`
  - L17 import を新 API に差し替え。
  - L73 `hasRefreshToken(store, backendType)` → `hasBackendSecret(store, backendType, "refresh")`。
  - L121 `storeTokens(store, backendType, {refreshToken, accessToken})` →
    `setBackendSecret(store, backendType, "refresh", refreshToken)` ＋ `..., "access", accessToken)`。
  - L178 / L247 `const tokens = readTokens(store, type)` →
    `getBackendSecret(store, type, "refresh")` / `..., "access")` を直接使用
    （`tokens.refreshToken` / `tokens.accessToken` 参照箇所を置換）。
  - L198 `hasRefreshToken(store, type) && ...` → `hasBackendSecret(store, type, "refresh") && ...`。
  - L230 `storeTokens(...)` → `setBackendSecret` ×2。
  - L257 `clearTokens(store, type)` → `clearBackendSecrets(store, type, ["refresh","access"])`。
- `src/fs/googledrive/provider-custom.ts` L12/L146 `clearTokens` →
  `clearBackendSecrets(store, type, ["refresh","access"])`。

### A4 ゲート → コミット
`npm run lint && npm run build && npm test` green。Drive のトークン保存/読込/接続判定/切断が不変なことを確認。

---

## Step B — リモート checksum を型付き `FileEntity.remoteChecksum` へ昇格

**動機**: `FileEntity.hash`（"SHA-256"と明記）はリモートで `""`、変更検出の実体は型なしの
`backendMeta.contentChecksum`。`enrichHashesForInitialMatch` は `md5(content)===contentChecksum` と
**MD5 決め打ち**で、ローカル計算不可な pCloud `hash` では静かに不発。型付き・algo タグ付きへ昇格する。

### B1 型の追加
- `src/fs/types.ts`:
  ```ts
  export type ChecksumAlgo = "md5" | "sha1" | "sha256" | "opaque";
  export interface RemoteChecksum { algo: ChecksumAlgo; value: string; }
  ```
  `FileEntity` に `remoteChecksum?: RemoteChecksum;` を追加。L25 の `backendMeta` doc から
  "contentChecksum" を削除し「sync が覗かない backend 私物」と明記。
- `src/sync/types.ts`: `SyncRecord` に `remoteChecksum?: RemoteChecksum;` を追加（L17-18 の doc 更新）。

### B2 (RED→GREEN) ハッシュユーティリティ — `src/utils/hash.ts`
- `sha1(data: ArrayBuffer): Promise<string>` を追加（`crypto.subtle.digest("SHA-1", ...)`、`sha256` と同形）。
- `digest(data, algo: ChecksumAlgo): Promise<string>` ディスパッチャ:
  `md5`→`md5(data)`（`../utils/md5` は同期、Promise でラップ）/`sha1`→`sha1`/`sha256`→`sha256`/
  `opaque`→throw（ローカル計算不可）。
- `isLocallyComputable(algo): boolean` = `algo !== "opaque"`。
- `src/utils/hash.test.ts` に sha1 既知ベクタと digest 分岐のテスト（RED 先行）。

### B3 (RED→GREEN) 消費側を remoteChecksum へ
- `src/sync/change-compare.ts` `hasRemoteChanged`（L38-39,57）:
  `file.backendMeta?.contentChecksum` → `file.remoteChecksum?.value`、record 側も同様。`typeof string`
  ガードは不要（型で string 保証）。コメント L34/57 更新。
- `src/sync/change-detector.ts` `enrichHashesForInitialMatch`（L237-268）:
  候補条件を `e.remote.remoteChecksum && isLocallyComputable(e.remote.remoteChecksum.algo)` に。
  判定を `await digest(content, algo) === e.remote.remoteChecksum.value` に一般化。`opaque` は候補外
  （理由をコメント明文化）。L6 の `md5` import は digest 経由に集約可。コメント L234 更新。
- `src/sync/conflict.ts` L326-327: `a.hash || a.remoteChecksum?.value || ""`（b も）。コメント L118/321 更新。
- `src/sync/state-committer.ts` `buildSyncRecord`（L26 付近）: `remoteChecksum: remote?.remoteChecksum`
  を record に追加（`backendMeta: remote?.backendMeta` は id 保持のため維持）。

### B4 Drive 発生側を remoteChecksum へ
- `src/fs/googledrive/metadata-cache.ts` `driveFileToEntity`（L303-306）:
  `backendMeta: { driveId }` ＋ `remoteChecksum: driveFile.md5Checksum ? { algo:"md5", value: driveFile.md5Checksum } : undefined`。コメント L288 更新。
- `src/fs/googledrive/index.ts` `write`（L361）: 同様に `backendMeta:{driveId}` ＋
  `remoteChecksum: md5 ? {algo:"md5",value:md5} : undefined`。コメント L284 更新。
- `src/fs/interface.ts` L29 の doc を `remoteChecksum` 参照に更新。

### B5 スキーマ版数 bump（cold-start）
`SyncRecord` 形状変更に伴い `src/sync/state.ts` `DB_VERSION` を **3 → 4**。CLAUDE.md「マイグレーション
無し＝スキーマ変更で全 store を drop し再生成」に従う。結果: 既存ユーザーは次回同期が一度だけフル
cold 再照合（hash 再計算・record 再生成）になるが**データ損失は無い**（baseline キャッシュのみ破棄）。

### B6 モック/ヘルパ更新
- `src/__mocks__/sync-test-helpers.ts` L18 コメント、`backendMeta.contentChecksum` を付ける補助があれば
  `remoteChecksum` へ。
- `src/__mocks__/mock-remote-change-detection.test.ts` L11 コメント更新（mock は非 checksumBased のまま）。

### B7 ゲート → コミット
`npm run lint && npm run build && npm test` green。

---

## テスト更新インベントリ（既存テストの書換＝挙動保存の担保）
`backendMeta: { contentChecksum: X }` → `remoteChecksum: { algo:"md5", value: X }` へ機械的置換。
`Partial<FileEntity>`/`Partial<SyncRecord>` overrides 経由なのでヘルパ自体の変更は不要。
- `src/sync/change-compare.test.ts`（L112-185）。L165-173「非 string contentChecksum は無効」系は
  「remoteChecksum 未指定→hash へフォールバック」に意味を読み替えて書換。
- `src/sync/change-detector.test.ts`（L92-143）。md5 一致で enrich は維持。**新規 RED**:
  `algo:"sha1"` でも enrich する／`algo:"opaque"` は enrich しない、を追加（一般化の証明）。
- `src/sync/decision-engine.test.ts`（L341-397）。
- `src/fs/googledrive/index.test.ts`（L79-134）: `result.backendMeta?.contentChecksum` →
  `result.remoteChecksum?.value`、欠落ケースは `result.remoteChecksum` を `toBeUndefined`。
- `src/fs/googledrive/metadata-cache.test.ts`（L398）: `entity.remoteChecksum?.value` を検証。
- `src/fs/googledrive/remote-change-detection.test.ts`: コメント＋ checksum 注入を `remoteChecksum` へ。
- `src/sync/state-committer.test.ts`（L12,21）: `backendMeta:{id}` は維持。`remoteChecksum` の往復 assertion を追加。
- 新規: `src/fs/token-store.test.ts`、`src/utils/hash.test.ts`（sha1/digest）。

## ゲート（必須・各 Step 末）
`npm run lint && npm run build && npm test` を全 green。lint は `eslint-plugin-obsidianmd` と設計ガード
（ファイル ~200-300 行・`fetch` 禁止・`getAllLoadedFiles` 制限）を含む。ルール無効化ではなくコードを直す。

## 検証（Phase 0 完了時）
1. 既存 Drive アカウントで同期 → **再接続不要**で接続維持（Step A 互換）。
2. 初回同期が一度だけフル cold 再照合になり（DB_VERSION bump）、以降は従来通り差分検出。
3. mtime ドリフト時に `remoteChecksum.value` で「未変更」判定が効く（Drive md5 経路の不変）。
4. `npm test` 全 green（新規 token-store/hash テスト含む）。

## コミット計画
- Step A 完了: `refactor: generalize token-store to opaque named backend secrets`
  （pCloud のような refresh-token を持たない backend がダミー値無しで載るようにする旨を本文に）。
- Step B 完了: `refactor: promote remote content checksum to a typed FileEntity.remoteChecksum`
  （暗黙 MD5 前提を algo タグで解消・cold-start のため DB_VERSION を 4 に上げる旨を本文に）。

## 非該当（Phase 0 では触らない）
pCloud 実装本体（`src/fs/pcloud/`・UI・ワーカー）は Phase 1。SHA-1 cross-side dedup の有効化は
受け皿のみ用意し、algo 切替は後続課題。
