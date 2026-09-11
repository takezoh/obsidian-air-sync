---
change: change-20260910-terminal-publication-exclusivity
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## Root-cause evidence

Personal debug logs show the first-push transfer and `SyncRecord` publication succeeded,
then optional merge-base storage alone warned because `Untitled 3.md` no longer existed.
They separately show an `a.md` publication succeeded immediately before a conflict at
the same key rejected its stale publication expectation. The latter CAS is correct;
its exact generating alias/report snapshot is no longer available.

## RED/GREEN regressions

- `state-committer.test.ts` reproduces a completed push whose local source has moved.
  Before the fix no merge base is stored; after the fix the proved bytes are stored
  without a warning.
- `convergence.test.ts` exercises the same behavior through transfer execution with
  three-way merge enabled.
- `admission-action-uniqueness.test.ts` reproduces a closed rename component that
  previously emitted two conflict publishers at `B.md`; after symmetric occurrence
  claiming it emits exactly one.
- Existing executor, fact-first, Admission, and convergence tests retain strict source,
  terminal, conflict-preservation, and CAS controls.

## Gate

- `npm run lint`: passed.
- `npm run lint:bot-repro`: passed (55 guard tests).
- `npm run build`: passed.
- `npm run test:coverage`: passed (96 files, 1985 tests; 85.31% statements,
  81.58% branches, 84.59% functions, and 86.78% lines).
- Personal artifact parity: deployed source and installed `main.js` both have SHA-256
  `e3076dc03cd3b6bee8f4bcc905f4ac95fbfe1309f65347ccdf4c9b7fe52678ec`.

## Evidence boundary

`dev-evidence` observed the declared change surface and reported only two out-of-scope
untracked files: `.claude/settings.local.json` and
`src/fs/oauth-disconnect-isolation.test.ts`. Both pre-existed this fix, remain untouched,
and are excluded from staging. The exact historical alias/report snapshot that produced
the Personal `a.md` duplicate publication is unavailable, so the regression proves and
fixes the structurally valid duplicate-owner state without claiming byte-for-byte replay
of that lost snapshot.
