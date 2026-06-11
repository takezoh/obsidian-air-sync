# ADR 0003 — Fake fidelity is backstopped by an opt-in e2e that runs the IFileSystem contract against the real backends

**Status:** Accepted · 2026-06-10
**Context area:** testing / `fs/` backends (multi-FS foundation)
**Related:** [ADR 0002](0002-backends-verified-by-shared-behaviour-contracts.md) (the contracts this reuses; the fake-fidelity rule this automates), [docs/e2e-testing.md](../e2e-testing.md) (how to run it), [code-enforcement.md](../code-enforcement.md), [ARCHITECTURE.md](../../ARCHITECTURE.md) (principle 2)

## Context

ADR 0002 verifies every backend by running the shared `runIFileSystemContract` against the
**real FS** over a **faithful fake** at the typed-client boundary
(`DriveClient`/`DropboxClient`). It is fast and CI-friendly, but it has one structural blind
spot, named in that ADR's rule 4: **"the fake MUST be faithful to the boundary it
replaces."** Nothing *enforces* that. Both concrete failure modes ADR 0002 records were
caught by **human code review** — the Dropbox `move` `.tag` divergence was literally "Found
in code review." When a fake quietly drifts from the real API (a field the real client omits,
an error it actually returns, a timestamp it truncates), every contract stays green and the
divergence ships.

We want the same contract — the one source of truth for `IFileSystem` semantics — to also be
runnable against the **live** Google Drive and Dropbox APIs, so a fake that has drifted from
reality fails a test instead of waiting for a reviewer to notice. This must not become a CI
gate: real cloud calls need credentials, hit quota, are slow, and flake on the network. So it
is **opt-in**.

## Decision

1. **Reuse `runIFileSystemContract` verbatim against the real clients.** A new
   `GoogleDriveFs`/`DropboxFs` built over a *real* `DriveClient`/`DropboxClient` (authenticated
   from a stored refresh token) is driven through the exact same contract the fakes run. No
   parallel e2e assertions — drift surfaces as the shared contract going red against the live
   API. The harness lives in a top-level `e2e/` dir; the contract and FS/clients/auth come
   from `src/` unchanged.

2. **Opt-in, local/manual only — never CI.** A separate vitest config
   (`e2e/vitest.e2e.config.ts`) and script (`npm run test:e2e`), never the default `npm test`
   nor the lint workflow. e2e files are named `*.e2e.ts` (outside both the default
   `src/**/*.test.ts` include and lint's scope).

3. **Absent credentials → warn and skip, never fail.** Each backend reads its refresh token
   from the environment (or a gitignored `.env.e2e`); if missing, the suite `console.warn`s and
   `describe.skip`s. A run with no credentials passes (exit 0) — so an accidental invocation
   can never break anything.

4. **Reuse the shipped auth; store only a refresh token.** The harness authenticates through
   the production auth code (`GoogleAuthDirect` / `GoogleAuth`, `DropboxAuth`), seeded with a
   refresh token obtained once via `npm run e2e:bootstrap`. The bootstrap captures the OAuth
   redirect on a **localhost loopback** server (no copy-paste) and writes the token to
   `.env.e2e`. Because the built-in Google auth server returns tokens to `obsidian://` — which
   a loopback can't capture — the Google bootstrap uses the developer's **own** GCP OAuth
   client (`GoogleAuthDirect` with a loopback redirect), and the Google e2e refreshes with that
   same client; with only a refresh token and no client id/secret it falls back to the built-in
   `GoogleAuth`. Dropbox uses the public PKCE client id with a loopback redirect URI registered
   on the app. The exact auth path is incidental to what this e2e validates (the real
   `DriveClient`/`DropboxClient` CRUD surface vs. the fakes), so a custom Google client is fine.

5. **The real `requestUrl` is the only swapped seam.** The shipped `obsidian` test mock rejects
   every `requestUrl`; the e2e config aliases `obsidian` to a shim whose `requestUrl` performs
   real HTTP over `fetch`. Everything else (`Notice`, `Platform`, …) stays the mock. The shim
   and its `fetch`-based transport live in `e2e/` (lint-ignored) because `fetch`/Node APIs are
   banned in shipped `src/`.

6. **Per-test isolation by a fresh remote folder.** Because the contract assumes an empty FS per
   `makeFs()` but exposes no cleanup hook, the harness creates one throwaway parent folder per
   run and a fresh child folder per test, deleting the parent recursively in `afterAll`.

7. **A sanctioned `preservesWrittenMtime` knob models the one timestamp divergence.** The
   contract pins exact mtime round-trips, but the real `DropboxFs` reports `server_modified`
   (the upload wall-clock, the canonical remote timestamp) as `mtime`, so a written value does
   not round-trip at all — whereas the Dropbox fake echoes the written value back (ADR 0002,
   "Documented intentional divergences"). Rather than weaken the contract, a second
   backend-class knob — alongside `computesHashOnStat` — drops the mtime-equality assertions to
   "a plausible (finite, positive) timestamp" when set `false` (the real Dropbox); mock/
   LocalFs/Drive and all fakes keep the default `true`. This knob *replaced* an initial
   `mtimePrecisionMs` guess (that Dropbox merely truncated the written mtime to seconds) — the
   e2e proved the real value is the server's clock, not the written one rounded, so a
   precision relaxation could never have matched. mtime is not Dropbox's change-detection
   signal (that is the content-hash `remoteChecksum`), so nothing load-bearing is relaxed.

## Consequences

- **The fake-fidelity rule of ADR 0002 now has an automated backstop**, run on demand instead
  of relying solely on review. A real drift (over-generous fake shape, swallowed error, missing
  field) fails the live contract — exactly the failures ADR 0002 says a green-but-worthless fake
  hides. A failure is **a divergence to fix in the fake or backend**, never a reason to relax the
  e2e.

- **It is deliberately not a CI gate.** Credentials, quota, network flake, and runtime make it
  unsuitable for every push; it backstops, it does not replace, the fast fake-based contracts.

- **`preservesWrittenMtime` is the second sanctioned backend-class knob** (after `computesHashOnStat`).
  Like that one, it encodes an intrinsic interface-level difference, not an opt-out of a behaviour
  — it drops only the mtime *value* check (never the assertion's intent), and only at the
  non-default `false`.

- **Adding a new backend extends the e2e in one block**, mirroring its fake-based contract call:
  authenticate a real client, create/clean an isolated folder, run `runIFileSystemContract` with
  the right `computesHashOnStat`/`preservesWrittenMtime`.
