# pCloud バックエンド実装計画

## 進捗状況

- **Phase 0（共有抽象の正直化）— 完了・`main` へマージ済み**（commits 8bb9326 / 6339a0b / 4276119、
  `pcloud-fs` ブランチに取り込み済み）。token-store の不透明シークレット化、`FileEntity.remoteChecksum`
  昇格、algo-aware checksum 比較が反映済み。
- **Phase 1（pCloud 実装）— コード実装完了・ゲート green・未コミット（`pcloud-fs` ブランチ）**
  （2026-06-06）。`npm run lint && npm run build && npm test` 全 green（778 テスト、うち pcloud 63）。
  ワーカー単体も `tsc -noEmit` green。
  - 実装: `src/fs/pcloud/{types,client,metadata-cache,incremental-sync,index,auth,provider}.ts`（+各 `*.test.ts`）、
    `src/ui/pcloud-settings.ts`、`registry.ts`/`backend-settings.ts` 登録、
    `oauth-worker/src/pcloud.ts`（`/pcloud/callback` + `Env`/`wrangler.toml` 変数）。
    `index.ts` は行数上限 300 内に収めるため delta 計算ヘルパを `incremental-sync.ts` へ分離。
  - 公式ドキュメントで確定し反映済み: 手組み multipart `uploadfile`（filename=part・mtime 秒）、
    `diff`（`entries[]`+top-level `diffid`、baseline=`last=0`、rename 専用イベント無し→`modify*` の
    `parentfolderid`/`name` 差分、delete は id 逆引き）、長寿命 access token（refresh/expiry 無し）。
  - **コードレビュー実施（xhigh・9 angle）**: 確定バグ1件を修正 — `metadata-cache.ts setEntry` が
    別 id による同一パス上書きで旧 id を `idToPath` に残し、後続 delete イベント（id 逆引き）が生きてる
    エントリを削除しうる問題（旧 id を evict・RED テスト追加）。diff ループの cursor 整理＋時系列順
    （並べ替え禁止）コメント、`read()` の `numericIdOf` 統一、64bit hash の JSON 精度欠落（~2⁻⁵³・受容）
    を明記。「`id` 未設定」「folders-first ソート欠落」等の重大候補は公式ドキュメント/設計で棄却。
    フォローアップ: `AbstractMetadataCache`/`withCacheMutex`/nonce ヘルパの Drive 共通化、worker callback
    共通化、`resolveRemoteVault` の folder liveness 検証。
  - **go-live 前に残（ユーザー作業・ライブでのみ確定）**:
    1. 実 `PCLOUD_CLIENT_ID` を `src/fs/pcloud/auth.ts` と `oauth-worker/wrangler.toml` の
       `REPLACE_WITH_PCLOUD_CLIENT_ID` に設定 → `wrangler secret put PCLOUD_CLIENT_SECRET` → ワーカー deploy。
    2. 未検証点（テストは documented 契約を pin 済み・下記「検証」で確定）: 手組み multipart が実 API に
       通るか／認証失敗の正確な `result` コード（`assertOk` の集合を実値で調整）／`diff` のイベント形。
    3. README/プライバシーへの全アカウント scope 開示は **go-live 時に追加**（placeholder client_id の現状は
       接続不可のため先出しは誤誘導と判断し保留。開示要件は `docs/oauth-worker.md` に記載済み）。

## Context（なぜ作るか）

Air Sync は「差し替え可能なバックエンド」設計で、リモート I/O はすべて `IFileSystem` +
`IBackendProvider` を経由する。現在は Google Drive のみが実装されている。本計画は **pCloud**
を 2 つ目のクラウドプロバイダとして追加する。

ただし調査の結果、現状の共有抽象は **Drive 1 つに合わせて作られており、pCloud を載せると
「ダミー refresh token」「型なしの checksum バッグ + 暗黙 MD5 前提」など“無理やり合わせる”歪みが
生じる**ことが判明した。そこで本計画は次の二段構えで進める。

1. **Phase 0 — 共有抽象の正直化（前提リファクタ・RED 先行）**: pCloud を載せる前に、Drive 専用
   形状になっている 2 つの抽象を型で正直にする。Drive の挙動は不変のまま置き換える。
2. **Phase 1 — pCloud 実装**: 綺麗にした抽象の上に pCloud を最小・自然に載せる。

**確定した方針（ユーザー確認済み）:**
- 認証 = OAuth ワーカー経由の **code フロー**（既存 Google Drive(組込) と一貫）。
- リモート変更検出 = 最初から **`diff` 増分同期**（Drive の changes.list 相当）。
- Phase 0 の 2 リファクタ = **(A) token-store を不透明な名前付きシークレットへ一般化**、
  **(B) リモート checksum を型付き `FileEntity.remoteChecksum` へ昇格**。

→ diff 増分のため、pCloud 実装は実質「Drive バックエンドを pCloud API へ移植」になる。pCloud の
`diff` はアカウント全体のイベントを返し metadata が絶対パスを含まないため、**folderid→path の
ID キャッシュが必須**で、アドレッシングも ID ベースが自然（Drive 構成を雛形に踏襲）。

## pCloud と Drive の差分（設計に効く点）

| 観点 | Google Drive | pCloud | 影響 |
|---|---|---|---|
| トークン | access+refresh・期限あり | **長寿命 access のみ・refresh 無し** | リフレッシュ機構不要。Phase 0(A) で token-store を一般化 |
| 変更検出 | `md5Checksum`（ローカル計算可） | メタ `hash`（独自 64bit・ローカル計算**不可**） | Phase 0(B) で algo タグ付き checksum へ |
| アドレッシング | 不透明 file ID のみ | path / id 両可 | ID ベース採用（diff 解決にキャッシュ要） |
| 一覧 | ページネーション | `listfolder?recursive=1` 1 回 | フルスキャン 1 コール |
| 増分 | `changes.list`+token | `diff`+diffid（アカウント全体） | vault サブツリーへ要フィルタ |
| エラー | HTTP ステータス | **HTTP 200 + `result != 0`** | クライアントは `result` 検査で throw |
| リージョン | 単一 | US/EU でホスト別 | authorize 応答の `hostname` を保存し全 API で使用 |
| OAuth scope | `drive.file`（アプリ作成分のみ） | **全アカウント** | diff に無関係ファイルも来る→要フィルタ。privacy/docs に明記 |

---

## Phase 0 — 共有抽象の正直化（前提リファクタ）

> Drive の外形的挙動・保存キーは不変。各リファクタは RED 先行（`it.fails`／既存テスト書換）。

### (A) token-store を不透明な名前付きシークレットへ一般化
**動機**: `StoredTokens={refreshToken, accessToken}` は OAuth ペアを全 backend に強制する。pCloud は
refresh token を持たないため「ダミー refresh」を作る歪みが出る。

**変更** `src/fs/token-store.ts`:
- 一次プリミティブを不透明 API に: `setBackendSecret(store, type, name, value)` /
  `getBackendSecret(store, type, name)` / `hasBackendSecret(store, type, name)` /
  `clearBackendSecrets(store, type, names[])`。
- **保存キーは現行 `air-sync-${type}-${name}-token` を維持**（既存 Drive ユーザーの保存トークンを
  失わせない＝再接続不要。SecretStorage 由来でマイグレーション不可のため互換が要件）。
- `StoredTokens` / `storeTokens` / `readTokens` / `hasRefreshToken` / `clearTokens` を撤去し、
  呼び出し側（Drive の `provider-base.ts` createFs/readBackendState/resolveRemoteVault/disconnect、
  `auth.ts`）を不透明 API へ置換。Drive: name=`"refresh"`/`"access"`。
- テスト更新（`test-helpers.ts` の mock secret store はそのまま流用可）。

### (B) リモート checksum を型付き `FileEntity.remoteChecksum` へ昇格
**動機**: `FileEntity.hash` は「SHA-256」と謳うのにリモートは `hash:""` を返し、変更検出の実体を
型なしの `backendMeta.contentChecksum` に密輸している。消費側は `as string` キャスト多数、
`enrichHashesForInitialMatch` は **`md5(content)===contentChecksum` と MD5 を決め打ち**。
pCloud の `hash` は MD5 でないためこの最適化が静かに不発になり、設計の嘘が表面化する。

**変更**:
- `src/fs/types.ts`: `type ChecksumAlgo = "md5" | "sha1" | "sha256" | "opaque"` と
  `FileEntity.remoteChecksum?: { algo: ChecksumAlgo; value: string }` を追加（`opaque`=
  バックエンド内部値・ローカル計算不可）。`backendMeta` は「sync が覗かない backend 私物」へ純化。
- `src/sync/types.ts`: `SyncRecord.remoteChecksum?` を追加（永続化）。`backendMeta` は id 等の保持に残す。
- `src/sync/change-compare.ts` `hasRemoteChanged`: `backendMeta.contentChecksum` →
  `remoteChecksum.value` の時系列比較（algo 非依存）。
- `src/sync/change-detector.ts` `enrichHashesForInitialMatch`: 候補条件を
  `remoteChecksum && isLocallyComputable(algo)`（md5/sha1/sha256）に一般化し、
  `digest(content, algo)===value` で判定。`opaque` は対象外（理由をコメント明文化）。
- `src/sync/conflict.ts` (`326-327`): `a.hash || a.remoteChecksum?.value || ""`。
- `src/sync/state-committer.ts`: `remoteChecksum` を `SyncRecord` に保存。
- `src/utils/hash.ts`: `sha1()` と `digest(content, algo)` ディスパッチャを追加（`md5`/`sha256` は既存）。
- Drive `src/fs/googledrive/{index,metadata-cache}.ts`: `backendMeta.contentChecksum` の代わりに
  `remoteChecksum:{ algo:"md5", value: md5Checksum }` を出す。`backendMeta:{ driveId }` は維持。
- テスト更新: `decision-engine.test.ts`・`change-compare.test.ts`・`change-detector.test.ts`・
  `state-committer.test.ts`・Drive 系を `remoteChecksum` へ。

---

## Phase 1 — pCloud 実装

### 設計判断
1. **アドレッシング & キャッシュ**: `remoteVaultFolderId`(folderid) を root に、`PCloudMetadataCache`
   が path↔{id,isfolder,hash,size,modified,parentfolderid} とツリー所属を保持。初回
   `listfolder?folderid=<root>&recursive=1` で構築、`diff` で維持。`MetadataStore<PCloudEntry>` で
   IndexedDB 永続化（cold-start 復帰）。read/write/delete/rename は id で叩く。
2. **増分 `diff`**: カーソル `diffId` を backendData 保持、**全同期成功時のみ**コミット
   （`readBackendState` の `commitCheckpoint` 連動）。初回フルスキャン**前**に baseline diffid 取得。
   毎サイクル `diff?diffid=<cursor>` を非ブロッキング取得しキャッシュへ適用、応答 `diffid` を新カーソルに。
   **vault サブツリー所属イベントのみ**採用（delete はパス無しのためキャッシュで逆引き）。diffid 失効の
   `result` でフルスキャンへフォールバック。**要実 API 検証**: イベント名・rename/move 表現・delete の
   metadata 形・baseline 取得法（推測で固めない）。
3. **変更検出**: Phase 0(B) 後、pCloud は `remoteChecksum:{ algo:"opaque", value:String(entry.hash) }`
   を出す。`hash` は内容同一なら安定で listfolder/stat/diff に無料で乗る→時系列比較に最適。
   `FileEntity.hash` は `""`。
4. **認証**: pCloud code フローは refresh も `expires_in` も返さない長寿命 access token。
   `setBackendSecret(store,"pcloud","access",token)` で **access のみ**保存（ダミー refresh を作らない）。
   `isAuthenticated`/`isConnected` は `hasBackendSecret(store,"pcloud","access")` で判定。API は毎回
   `auth=<token>` クエリ。失効はリアクティブ（認証系 `result`→`AuthError(401)`→再接続促し）。

### 新規 `src/fs/pcloud/`（Drive `src/fs/googledrive/` を雛形に）
- **`types.ts`** — `PCloudEntry`・token/diff レスポンス型・`assertOk()`（`result!=0` で throw、
  認証コード→`AuthError`）。
- **`client.ts`** — `PCloudClient`（`requestUrl()` のみ・`fetch` 禁止）。`(getToken, apiHost, logger)`。
  `listFolder`/`stat`/`getFileLink`(→`hosts[0]+path` を GET)/`uploadFile`(**multipart を手組みして
  ArrayBuffer body・`mtime` 設定・要疎通確認**)/`createFolder`/`createFolderIfNotExists`/
  `deleteFile`/`deleteFolderRecursive`/`renameFile`/`renameFolder`/`getDiffBaseline`/`listDiff`。
  HTTP 失敗と `result!=0` を `pCloud API <op> failed: ...` でラップ。
- **`metadata-cache.ts`** — `PCloudMetadataCache`（Drive `DriveMetadataCache` 相当）。
  `pcloudEntryToEntity` は `hash:""`, `remoteChecksum:{algo:"opaque",value:String(hash)}`,
  `backendMeta:{ pcloudId }`。
- **`incremental-sync.ts`** — `applyDiff(cache, client, diffId)`→`{changedPaths, renamedPaths,
  newDiffId, needsFullScan}`（Drive `incremental-sync.ts` 同型）。
- **`index.ts`** — `PCloudFs implements IFileSystem`(`name="pcloud"`)。Drive `index.ts` 踏襲
  （`cacheMutex`+`ensureInitialized`+`fullScan`(baseline 先取り)+`getChangedPaths`(diff)+9 メソッド+
  `ensureFolder`+`close`、`diffId` getter/setter）。`rename` は `validateRename()`（`src/utils/path.ts`）。
- **`auth.ts`** — `PCloudAuthProvider implements IAuthProvider`。
  `startAuth`: `my.pcloud.com/oauth2/authorize?...&response_type=code&redirect_uri=<worker>/pcloud/callback&state=<csrf>`。
  `completeAuth`: `obsidian://air-sync-auth?access_token=...&hostname=...&state=...` を parse・CSRF 検証・
  `setBackendSecret(...,"access",token)`・`{ apiHost:hostname, pendingAuthState:"" }` を返す。
- **`provider.ts`** — `PCloudProvider implements IBackendProvider`(`type="pcloud"`,
  `displayName="pCloud"`, `PCloudBackendData={remoteVaultFolderId,lastKnownVaultName,apiHost,diffId,
  pendingAuthState}`)。`createFs`(folderid を直接 root・`MetadataStore` 生成・`fs.diffId=data.diffId`)・
  `isConnected`(`hasBackendSecret && !!remoteVaultFolderId`)・`getIdentity`(`pcloud:${id}`)・
  `resolveRemoteVault`(`createFolderIfNotExists("/{REMOTE_VAULT_ROOT}/{vaultName}")`→`{remoteVaultFolderId,
  lastKnownVaultName}`、`REMOTE_VAULT_ROOT` は `src/sync/remote-vault.ts` 再利用)・`hasCheckpoint`(`!!diffId`)・
  `readBackendState`(成功時のみ `diffId` コミット)・`resetTargetState`(diffId 削除)・
  `disconnect`(任意で `/logout`→`clearBackendSecrets`→既定 data)。

### 新規 `src/ui/pcloud-settings.ts`
- `PCloudSettingsRenderer implements IBackendSettingsRenderer`(`backendType="pcloud"`)。Drive の
  `src/ui/googledrive-settings.ts` 雛形で接続状態＋「Connect to pCloud / Disconnect」。

### 既存ファイルへの登録（各 1 行）
- `src/fs/registry.ts` → `initRegistry` に `new PCloudProvider(secretStore)`。
- `src/ui/backend-settings.ts` → `renderers` に `new PCloudSettingsRenderer()`。
- `main.ts`/`sync/` は無変更（ドロップダウンは `backends.length>1` で自動表示）。

### OAuth ワーカー（`oauth-worker/`）— code フロー
- `wrangler.toml`: `PCLOUD_CLIENT_ID`/`PCLOUD_REDIRECT_URI` を `[vars]`、`PCLOUD_CLIENT_SECRET` は
  `wrangler secret put`。
- `src/types.ts`: `Env` に `PCLOUD_*`。
- `src/index.ts`: `GET /pcloud/callback`（`/token/refresh` 不要）。
- `src/oauth.ts`(or 新規 `pcloud.ts`): `handlePCloudCallback` — `code`/`state`/`hostname`/`locationid` を受け
  `https://{hostname}/oauth2_token` で交換、`obsidian://air-sync-auth?access_token=...&hostname=...&state=...`
  へ `redirectPage`。`ALLOWED_APPS` は `obsidian-plugin` 再利用（識別はルート）。
- `pages/` 変更不要。`docs/oauth-worker.md` に `/pcloud/callback`、privacy/README に全アカウント scope を明記。

## テスト（vitest・RED 先行）
- Phase 0: 上記の既存 sync/Drive テストを `remoteChecksum`／不透明シークレット API へ書換（挙動不変を担保）。
- Phase 1 `src/fs/pcloud/*.test.ts`（Drive パターン踏襲）:
  `client.test.ts`（`spyRequestUrl`/`mockRes` 流用、`result!=0`→throw、認証コード→`AuthError`、エンコード、
  multipart）／`metadata-cache.test.ts`（ツリー・removeTree・rewriteChildPaths・entity 変換）／
  `incremental-sync.test.ts`・`index.test.ts`（フルスキャン→diff 適用、folder rename 子パス書換、
  サブツリー外イベント無視、write→list 往復）／`remote-change-detection.test.ts`
  （`runRemoteChangeDetectionContract("pcloud", makeHarness, { checksumBased:true })`）。

## ゲート（必須）
`npm run lint && npm run build && npm test` を全 green に。lint は `eslint-plugin-obsidianmd`
（提出 bot 同一）と設計ガード（ファイル ~200-300 行上限・`fetch` 禁止＝`requestUrl` のみ・
`getAllLoadedFiles` 制限）を含む。ルール無効化ではなくコードを直す。client/index/metadata-cache/
incremental-sync は分割。

## 検証（エンドツーエンド）
1. pCloud 開発者コンソールで OAuth アプリ作成→client_id/secret 取得、redirect_uri
   `https://auth-airsync.takezo.dev/pcloud/callback` 登録、ワーカーに secret 投入。
2. `npm run dev`→テスト vault の `.obsidian/plugins/air-sync/` へ成果物配置。
3. 設定で Remote backend = pCloud→Connect→ブラウザ認証→`obsidian://` 復帰で「Connected to pCloud」、
   `apiHost` が EU/US で正しく切替わること。
4. 作成→同期→pCloud Web 確認。pCloud 側で編集/リネーム/削除→**再同期で `diff` 増分が取り込む**
   （初回後はフルリストせず差分のみ）。日本語名・サブフォルダ確認。
5. 同期途中中断→再開で diffId が前回成功値から再開し取りこぼさない（`commitCheckpoint`）。
6. **Phase 0 回帰**: 既存 Drive 同期が無変更で動く（再接続不要・変更検出が `remoteChecksum` で従来通り）。
7. `npm test` の contract/incremental テスト green。

## 後続課題（本計画では実装しない）
- `checksumfile` の SHA-1 を `remoteChecksum:{algo:"sha1"}` で出し、初回 cross-side dedup を有効化
  （Phase 0(B) で受け皿は完成済み＝algo 切替のみ）。
- 大容量ファイルのチャンクアップロード（pCloud `upload_create`/`upload_write`）。
- `diff?block=1` 長ポーリングによるニアリアルタイム同期。
