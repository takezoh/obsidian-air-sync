# ADR 0005 — Change detection prefers free fingerprints; the local content hash is an I/O trade-off

**Status:** Accepted · 2026-06-14
**Context area:** sync pipeline / change detection (`sync/change-compare.ts`)
**Related:** [ADR 0001](0001-metadata-cache-is-subordinate-to-commit-last.md) (convergence — a missed/extra detection is an efficiency bug, not a correctness one), [ADR 0002](0002-backends-verified-by-shared-behaviour-contracts.md) (the remote change-detection contract), [`change-compare.ts`](../../src/sync/change-compare.ts), [`content-identity.ts`](../../src/sync/content-identity.ts), [`remote-change-detection-contract.ts`](../../src/fs/remote-change-detection-contract.ts)

## Context

`hasChanged` (local) and `hasRemoteChanged` (remote) answer one question — *has this file
changed since the last sync?* — from three possible signals:

| Signal | Cost to obtain | Where it comes from |
|---|---|---|
| **content hash** (`FileEntity.hash`, sha256) | **expensive** — a full file READ | local only, via `LocalFs.stat()` |
| **backend checksum** (`remoteChecksum`: md5 / quickXor / Dropbox content-hash) | **free** — already in listing metadata | remote only, server-computed |
| **mtime + size** | **free** — already in listing metadata | both sides |

The decisive fact is an **asymmetry in how a content fingerprint is obtained**, not a
preference for speed:

- **Locally there is no free fingerprint.** `LocalFs.list()` returns `hash: ""` on purpose —
  computing a hash means reading the file, and a full-vault listing must stay I/O-free.
  A real local hash exists only after `LocalFs.stat()` has read and sha256'd the content.
- **Remotely the fingerprint is free.** Cached remote entries always carry `hash === ""`;
  their content fingerprint is `remoteChecksum`, which the backend returns in the same
  listing/metadata response — no download. (It can be `undefined` for items a backend
  doesn't checksum, e.g. Google-native docs; that is handled as "not comparable".)

A naive "always compare content hashes" rule would force a read of **every file on every
scan**, defeating delta-first sync (Principle #3). The whole point of leading with
mtime+size is to decide "unchanged" for the overwhelming majority of files **without ever
reading them**.

## Decision

1. **Never read a file just to detect a change.** Change detection consumes only what is
   already on hand. The local content hash is spent deliberately and sparingly — on the
   bounded HOT/dirty set (where `stat()` reads anyway) and on initial-match enrichment —
   never across a full-vault scan.

2. **A content fingerprint is authoritative when both sides have one; otherwise fall back
   to free metadata; otherwise be conservative.** Concretely:
   - `hasChanged` (local): if both sides have a `hash` (the stat path), compare hashes —
     this both ignores a same-content/bumped-mtime touch and catches a same-mtime+size
     edit. Otherwise (the list path, hash-less) compare mtime+size. Neither available ⇒
     assume changed.
   - `hasRemoteChanged` (remote): the fingerprint is `remoteChecksum`, not `hash`. If
     mtime+size agree, treat as unchanged; if they differ, trust the checksum when both
     sides expose the **same** algorithm, else assume changed. A metadata-only touch
     (mtime drifts, content identical) is correctly reported UNCHANGED **because** the
     checksum is compared on the differ path — the property the remote contract pins.

3. **The remote fingerprint lives in `remoteChecksum`, never `hash`.** Remote `hash` is
   always `""`; the `hash` comparison inside `hasRemoteChanged` is inert defensive
   symmetry for a hypothetical hash-supplying caller and never fires in production.

4. **Same-algorithm-only checksum comparison.** A backend uses one checksum algorithm per
   vault, so a differing/absent algorithm means "not comparable" — fall through rather
   than risk a cross-algorithm verdict (owned by `content-identity.ts`).

## Consequences

- **WARM / COLD scans never read file bodies.** They list (mtime+size locally,
  mtime+size+`remoteChecksum` remotely) and diff against the baseline `SyncRecord`. Only
  the HOT path reads, and only its dirty files.

- **Both functions are logically "fingerprint-authoritative-when-present, else
  metadata, else conservative."** `hasChanged` is written in exactly that order so the
  intent is visible; `hasRemoteChanged` keeps mtime+size outermost because its free
  fingerprint (the checksum) is consulted on the path that needs it (mtime drift).

- **Accepted blind spot.** A local edit that preserves BOTH mtime and size while changing
  content is reported unchanged *when no hash is on hand* (the list path). This is not a
  real scenario for vault writes (they bump mtime), and ADR 0001's convergence guarantee
  means even a missed detection self-heals on a later cold reconcile — it is an efficiency
  edge, not a correctness hole. When a hash *is* on hand (HOT/stat), the edit is caught.

- **Prohibited:** comparing content hashes in a way that forces a read across a
  full-vault scan; treating remote `hash` as a content signal (it is always `""` — use
  `remoteChecksum`); comparing checksums across differing algorithms.

**Pinned by tests** (keep green; extend, don't weaken):
- `change-compare.test.ts` — the local hash-vs-metadata fallback matrix, incl. "same
  mtime+size but differing hash ⇒ changed" and "mtime bumped, hash equal ⇒ unchanged".
- `remote-change-detection-contract.ts` — written→unchanged, content-edit→changed, and
  (for checksum-based backends) **metadata-only touch ⇒ unchanged**, which is only
  possible if `hasRemoteChanged` consults `remoteChecksum`.
