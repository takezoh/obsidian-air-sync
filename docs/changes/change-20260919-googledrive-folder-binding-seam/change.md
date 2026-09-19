---
id: change-20260919-googledrive-folder-binding-seam
kind: change
title: Validate Google Drive folder binding through one usability seam
status: draft
created: '2026-09-19'
profile: sdd@1
intent: Every Google Drive binding path decides whether a folder is usable through one seam,
  and the custom-OAuth hand-typed folder id is validated at the connect boundary instead
  of being bound as an arbitrary string. Today the same "is this folder bindable" question
  is answered in four places that share nothing (assertRootAlive, fetchCurrentFile,
  resolveLinked, completeWebFolderPick), while the custom settings field and the path
  display answer it nowhere — so a folder in Trash is silently bound and rendered as an
  ordinary location. trashed is already in FILE_FIELDS, so this is placement, not cost.
outcomes:
- A Drive folder is classified as usable / not_found / inaccessible / not_folder / trashed
  in exactly one place (inspectGoogleDriveFolder), and every binding path — Picker, cached-id
  rebind, default folder, custom typed id, settings display — reads that decision.
- The custom-OAuth typed folder id is validated against Drive after auth and before a
  filesystem is created; a bad or trashed id fails the connect with a user-facing notice and
  returns the session to disconnected, so the id field is editable again and no later
  initBackend/runSync can rebuild the rejected target.
- A target that becomes trashed after a successful connect, or while the plugin is closed,
  is caught by the existing sync-time assertRootAlive, which re-observes every cycle and
  recovers automatically once the folder is restored (no stopped-state branch is added).
- The settings panel no longer renders a trashed bound folder as a normal path — the field
  shows the path with a Trash warning, from the same single getFile the path walk already does.
- Non-404/403 failures (auth, rate-limit, server) are rethrown unchanged from the seam, so
  existing error classification and retry behaviour are preserved at every site. A genuine 403
  permission failure is inaccessible; a 403 rate limit is not, and it fails open at connect.
scope:
- src/fs/googledrive/folder-usability.ts — new seam module owning inspectGoogleDriveFolder and the
  pure classifyFetchedGoogleDriveFolder; the single place the trashed/mimeType/access decision is made.
- src/fs/googledrive/types.ts — the one isGoogleDriveTrashed predicate, on the leaf type module so
  the delta mapper and the seam share it without a cycle.
- src/fs/googledrive/folder-usability.test.ts — unit coverage for every classified problem
  and for the rethrow of unclassified failures.
- src/fs/googledrive/provider-base.ts — completeWebFolderPick routes through the seam;
  validateRemoteVault implements connect-boundary validation (fails open on transient failures);
  getRemoteVaultDisplayPath returns the backend-neutral { path, warning? } and phrases every
  non-usable fetched problem via an exhaustive switch.
- src/fs/googledrive/remote-vault.ts — resolveLinked routes through the seam while keeping
  its "Failed to access remote vault folder" wrapping ("… folder … is in Trash" added) and wording.
- src/fs/googledrive/index.ts — assertRootAlive routes through the seam (rethrowing the
  original 404/403 to preserve classification); fetchCurrentFile uses isGoogleDriveTrashed.
- src/fs/googledrive/folder-path.ts — resolveFolderPath classifies its already-fetched file
  through the seam's pure classifier and returns { path, problem? } | null; no extra request.
- src/fs/backend.ts — optional IBackendProvider.validateRemoteVault (throw only on a definite
  verdict, fail open on transient), the backend-neutral RemoteVaultDisplay { path, warning? }
  type, and getRemoteVaultDisplayPath's widened return.
- src/fs/backend-manager.ts — completeBackendConnect validates before createFs; a rejection
  notifies "Folder selection failed" and runs the shared teardown (provider.disconnect +
  clearPluginSecrets + onDisconnected) so the session is disconnected with no FS.
- src/ui/backend-settings-ui.ts — renderBoundFolderField takes a RemoteVaultDisplay and
  replaces the description with its warning.
- src/ui/googledrive-settings.ts — the built-in bound-folder field passes the provider display.
- src/ui/backend-settings-ui.test.ts, src/fs/backend-manager.test.ts, src/fs/googledrive/*.test.ts
  — tests for the warning display, the connect-boundary validation, and the display state.
- docs/google-drive-backend.md — Remote vault resolution, custom provider and display sections
  name the seam and the connect-time validation.
non_goals:
- Any new persisted state, recovery marker or cross-cycle field. The seam is a stateless
  classifier; nothing is stored beyond the existing settings and checkpoint.
- Caching the validation result. Each binding/display path reads current facts through the
  same seam; a cached verdict would be a second owner of "is this folder usable".
- Validating the custom id on every keystroke or before auth. A token does not exist until
  auth completes, so validation is placed at the connect boundary (completeBackendConnect),
  not in the field's onChange.
- Re-observing the bound target on every initBackend/startup. That would turn a local lifecycle
  step into a network one (blocking onload, duplicating the Picker's check, and stopping
  auto-recovery). Sync-time assertRootAlive already re-observes every cycle without a
  stopped-state branch.
- A backend-specific display-state flag. getRemoteVaultDisplayPath returns the neutral
  { path, warning? }, so Dropbox and OneDrive stay unchanged in shape (they return { path }).
- Changing the four shared filesystem contracts or the live E2E, which cover sync behaviour
  rather than folder binding.
change_classes:
- behavior
- boundary
- internal_design
tags:
- google-drive
- remote-vault
- binding
owners: []
relations: []
source_paths:
- src/fs/googledrive/folder-usability.ts
- src/fs/googledrive/folder-usability.test.ts
- src/fs/googledrive/provider-base.ts
- src/fs/googledrive/remote-vault.ts
- src/fs/googledrive/index.ts
- src/fs/googledrive/folder-path.ts
- src/fs/backend.ts
- src/fs/backend-manager.ts
- src/ui/backend-settings-ui.ts
- src/ui/googledrive-settings.ts
- docs/google-drive-backend.md
promotion: []
unresolved_decisions:
- 'Display vocabulary — the provider returns a neutral warning string ("This folder is in
  Google Drive''s Trash.") and the renderer shows it in place of the field description. No
  icon/style is introduced; a distinct warning treatment is a later UI decision.'
- 'Custom-field trashed warning — the custom id field shows the raw id, not a path, and does
  not resolve the display on every render (that would walk the whole parent chain for a
  warning). Its trashed state is caught at connect validation; after a successful connect the
  built-in path display carries the warning. A lightweight per-field status check can be added
  later if a post-connect trashed custom folder needs an inline warning.'
governance:
  gate: auto
  reasons: []
summary: Google Drive のフォルダ binding 判定を folder-usability の1つの seam に集約し、custom
  の手入力 id を connect 境界で検証、Trash 内フォルダを設定画面で通常パスとして見せない。
members:
- role: requirements
  path: changes/change-20260919-googledrive-folder-binding-seam/requirements.md
  required: true
- role: implementation
  path: changes/change-20260919-googledrive-folder-binding-seam/implementation.md
  required: true
- role: verification
  path: changes/change-20260919-googledrive-folder-binding-seam/verification.md
  required: true
---

## Summary

Google Drive には「このフォルダを bind できるか」という同じ問いが、互いに何も共有しない
4 箇所（`assertRootAlive` / `fetchCurrentFile` / `resolveLinked` / `completeWebFolderPick`）
で別々に答えており、custom OAuth の手入力欄と設定画面の表示はどこでも答えていない。
`trashed` はすでに `FILE_FIELDS` で取得済みなので、これはコストの問題ではなく配置の問題である。

この change は `folder-usability.ts` に唯一の判定 seam を置き、classify だけを所有させる。
各呼び出し側は「どう見せるか（throw の文言 / `null` に落とす）」を引き続き所有し、文脈差
（Picker は re-pick 文言、rebind は "Failed to access…"）を壊さない。404/403 は問題として
`cause` を保持し、それ以外の失敗はそのまま rethrow して分類と retry を維持する。

custom OAuth の手入力 id は token が無いと検証できないため、connect 境界
（`completeAuth` 後・`createFs` 前）に `validateRemoteVault` を置く。失敗は
"Folder selection failed" として通知し、FS を作らない。既に bind 済みの target が切断中に
Trash へ移された場合もここで検出される。

設定画面は `resolveFolderPath` が同じ `getFile` から返す `trashed` を
`getRemoteVaultDisplayState` で受け取り、通常パスではなく Trash 警告として表示する。
追加リクエストはゼロ。

## Closure Notes

Implementation complete and gated. `npm run lint && npm run lint:bot-repro && npm run build
&& npm run test:coverage` all green. The four binding sites, the custom connect validation and
the trashed display are all covered by unit tests.
