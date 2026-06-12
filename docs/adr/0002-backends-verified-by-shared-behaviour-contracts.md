# ADR 0002 — Every backend is verified by shared behaviour contracts, run against the real FS over faithful fakes

**Status:** Accepted · 2026-06-09
**Context area:** testing / `fs/` backends (multi-FS foundation)
**Related:** [ADR 0001](0001-metadata-cache-is-subordinate-to-commit-last.md) (the crash-safety contract pins it), [ADR 0003](0003-opt-in-e2e-validates-fakes-against-real-backends.md) (the opt-in e2e that backstops fake fidelity against the live APIs), [ARCHITECTURE.md](../../ARCHITECTURE.md) (principle 2: a backend changes nothing outside `fs/`), [code-enforcement.md](../code-enforcement.md)

## Context

The sync pipeline is written against `IFileSystem` + `IBackendProvider` and **nothing
else** (ARCHITECTURE principle 2). So "is the engine correct for backend X?" reduces to
"does X honour the `IFileSystem` semantics the pipeline assumes?" — path normalization,
a rename that does not clobber its destination, a moved folder that stays a folder, a
`read()` that returns a detached copy, a `remoteChecksum` that actually tracks content.

A backend that diverges on any of these breaks sync in ways that are **invisible to a
per-backend unit test written against a hand-rolled mock** — that test exercises the
mock, not the contract. The failure surfaces only at runtime as data loss (a dropped
remote deletion), an infinite re-sync (change detection always "changed"), or a hard
error mid-cycle ("is a file" when writing into a renamed folder). We now drive **five**
backends — the in-memory `createMockFs` double, the real `LocalFs` (over an Obsidian
Vault), `GoogleDriveFs`, `DropboxFs`, and `PCloudFs` — and re-deriving the same ~46
behaviours by hand for each is both wasteful and unreliable: the hand-written sets drift
apart, and the subtle case is exactly the one a given backend's author forgets.

Two concrete failure modes we hit **while building this harness** motivate the decision,
because they are the ways a contract can look green and still be worthless:

1. **A fake that is more generous than the real client masks a real bug.** The fake
   `DropboxClient.move` returned a `.tag`-stamped entry, but the real
   `DropboxClient.move` returns bare `move_v2` metadata with **no** `.tag` (unlike
   `upload`/`createFolder`, which the real client *does* re-stamp). So
   `DropboxFs.rename`'s load-bearing `.tag` re-stamp — the line that keeps a moved folder
   classified as a folder — was **dead against the fake**: deleting it left the contract
   green. Found in code review; the fake was corrected to return untagged metadata. (This
   review-only catch is exactly what the opt-in real-cloud e2e in [ADR 0003](0003-opt-in-e2e-validates-fakes-against-real-backends.md)
   now backstops — the same contract, run against the live API, fails on a drifted fake.)

2. **An assertion that is not load-bearing gives false confidence.** The shared
   rename-directory case only checked `exists("renamed")`, and `exists()` is defined as
   `stat(path) !== null` — **true for a file too**. So a backend that re-typed a moved
   folder as a file passed every assertion. Pinning `stat("renamed").isDirectory` **and**
   a `write()` into the renamed folder, then **mutation-testing** it (drop the `.tag`
   re-stamp ⇒ the case goes red), made it actually guard the invariant.

The payoff, when the harness is right: adopting `DropboxFs` and `PCloudFs` onto the
shared `CachingRemoteFs` base required **zero production changes** to pass the contracts —
running them was the *proof* the rebase had adopted the foundation correctly, not a
chore bolted on afterward.

## Decision

1. **Every backend the engine drives is verified by SHARED, parameterized behaviour
   contracts** — not per-backend mock unit tests. The contracts live in `fs/`, and a new
   backend runs each in **one line**. Three families, split by concern:
   - **`runIFileSystemContract`** (`fs/ifilesystem-contract.ts` + `…-writes.ts`) — the
     synchronous CRUD/rename/stat/read/list/listDir surface, path normalization, and
     snapshot isolation (buffers are copied in and out, never aliased).
   - **`runCachingRemoteFsContract`** (`fs/caching/remote-fs-contract.ts`) — the ADR 0001
     crash-safety / **path-1** convergence guarantees of the `CachingRemoteFs` base:
     cursor co-located with the cache, re-report an un-pulled remote deletion after a
     crash, the "does NOT self-heal in-session" boundary, `resetCheckpoint`.
   - **`runRemoteChangeDetectionContract`** (`fs/remote-change-detection-contract.ts`) —
     temporal change detection through `mtime`/`size`/`remoteChecksum` (the `checksumBased`
     opt makes the checksum load-bearing via a metadata-only touch).

2. **Assert ONLY through the public interface** (`IFileSystem` / `IBackendProvider`),
   never a backend's private store or cache (`fs.files`, the metadata cache, …). The
   single sanctioned backend-class knob is **`computesHashOnStat`** — local-storage
   backends fill `hash` on `stat()`; remotes return `hash:""` plus a `remoteChecksum`
   (see `IFileSystem.stat`). That is an intrinsic interface-level difference, **not** an
   opt-out of a behaviour.

3. **Run the contract against the REAL FS** over a fake at its **I/O boundary** — the
   typed client (`GoogleDriveClient`/`DropboxClient`/`PCloudClient`), the mock `Vault` for
   `LocalFs`, or, where the change-detection contract needs it, the raw transport
   (`requestUrl`). Never against a re-implementation of the FS itself.

4. **The fake MUST be faithful to the boundary it replaces.** It returns exactly what the
   real thing returns at that boundary, **including the warts** (`DropboxClient.move`
   returns untagged metadata; `upload`/`createFolder` are re-stamped). A fake more
   generous than the real client silently disables the production code that exists to
   compensate for the real shape. Where a contract deliberately does **not** exercise a
   dimension, model it as an explicit no-op and say why — e.g. the IFileSystem fakes make
   the delta feed a **no-op** (`list_folder/continue` / `diff` return nothing) because
   that contract covers only the CRUD surface; delta correctness is the crash-safety
   contract's job.

5. **Every assertion must be load-bearing.** Before trusting one, confirm it goes **red**
   when the invariant breaks — RED-first for new behaviour, or mutation-test an existing
   path. An `exists()`-style check that passes for the wrong type is not an assertion of
   type.

6. **A new backend ADOPTS the contracts; it does not re-implement them.** One line per
   contract plus a faithful fake. **Zero production change to pass = proof** the backend
   adopted the foundation correctly. A **failure = a real divergence to FIX in the
   backend**, never a reason to opt that backend out of the case.

## Consequences

**Documented intentional divergences.** The Dropbox CRUD fake sets `server_modified` to
the **written `mtime`** so a write round-trips exactly, even though the real `DropboxFs`
reports `server_modified` — the **upload wall-clock**, the canonical remote timestamp (see
`dropbox/types.ts`) — which is unrelated to the value written. (Google Drive genuinely does
preserve the written `modifiedTime` at full ms.) This is on purpose: the IFileSystem
contract tests **FS-layer fidelity** (the FS does not mangle the time the backend reports),
and the fake supplies a deterministic, checkable timestamp for that. A divergence like this
is allowed only when it is written down at the fake and does not weaken what the contract is
*for*. The opt-in real-cloud e2e
([ADR 0003](0003-opt-in-e2e-validates-fakes-against-real-backends.md)) runs this same
contract against the live backends, where `server_modified` is the real upload time; the
`preservesWrittenMtime` opt — a second sanctioned backend-class knob alongside
`computesHashOnStat` — drops the mtime-equality assertions to "a plausible (finite,
positive) timestamp" for the real Dropbox (`false`), while mock/LocalFs/Google Drive and all the
fakes keep the default (`true`). This empirically surfaced the fake's generosity: an earlier
`mtimePrecisionMs` knob (assuming Dropbox merely *truncated* the written mtime to seconds)
was wrong — the real value is the server's clock, not the written one rounded — and the e2e
caught it. mtime is **not** Dropbox's change-detection signal anyway; that is the
content-hash `remoteChecksum` (the change-detection contract is `checksumBased`).

A second divergence the e2e surfaced the same way: the **Google Drive** CRUD fake leaves
`modifiedTime` untouched on a rename/move, but the real `files.update` **bumps it to
"now"** (a metadata write counts as a modification). So mtime survives a rename only on
local-storage backends; the rename test pins exact mtime-through-rename when
`computesHashOnStat` (mock/LocalFs) and only requires a finite timestamp otherwise. (Google Drive
still preserves the written `modifiedTime` on a plain *write* — that is unaffected.)

**The orchestrator-level convergence path is deliberately out of the FS contracts.** ADR
0001 **path 2** (state C — a live FS whose in-memory cursor overtook the committed one
after a failure) cannot be closed by the FS alone; it is the orchestrator's job
(`recoverViaColdScan`). So `runCachingRemoteFsContract` pins only path 1 and the
FS-observable boundary ("the live FS does **not** self-heal in-session"), and path 2 is
pinned **generically** by `orchestrator.test.ts` over a `createMockFs` double. Because the
orchestrator's force-cold logic is backend-agnostic and each backend's FS-boundary
behaviour is already pinned by its crash-safety contract, per-backend orchestrator
parameterization is **optional belt-and-suspenders**, not a coverage gap.

**Prohibited patterns** (each is a way to make a contract green and worthless):
- a per-backend unit test that re-asserts a shared-contract behaviour against the
  backend's **private** store instead of running the shared contract through the public
  interface;
- a fake that returns data the real client/transport **does not** (over-generous shape,
  swallowed error, missing field) — it disables the production code that handles the real
  shape;
- adding an assertion **without confirming it is load-bearing** (RED-first or mutation);
- **opting a backend out** of a contract case because it "doesn't apply" — if the engine
  drives that backend through `IFileSystem`, the case applies; FIX the backend (as Google Drive
  was hardened for path normalization / `read(dir)` / `validateRename`), do not relax the
  contract.

**Pinned by tests** (keep green; extend, do not weaken):
- `fs/ifilesystem-contract.ts` (+ `…-writes.ts`) → run by `__mocks__/mock-fs.test.ts`,
  `fs/local/local-fs.contract.test.ts`, `fs/googledrive/ifilesystem-contract.test.ts`,
  `fs/dropbox/ifilesystem-contract.test.ts` (and `fs/pcloud/ifilesystem-contract.test.ts`
  on the `pcloud-fs` branch). Includes *"renames a directory … stays a directory and is
  writable"* (the mutation-pinned case above).
- `fs/caching/remote-fs-contract.ts` → run by `fs/caching/remote-fs.contract.test.ts` (a
  generic `MockRemoteFs`), `fs/googledrive/crash-safety-contract.test.ts`,
  `fs/dropbox/crash-safety-contract.test.ts` (and pCloud's on its branch). Pins ADR 0001.
- `fs/remote-change-detection-contract.ts` → run by `__mocks__/mock-remote-change-detection.test.ts`,
  `fs/googledrive/remote-change-detection.test.ts`, `fs/dropbox/remote-change-detection.test.ts`
  (and pCloud's on its branch).
