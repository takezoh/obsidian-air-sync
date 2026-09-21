# Requirements — backend capability-tiered conditional mutation

## Context

The Backend Module API declared version-bound reads and "no unversioned overwrite", but
the three adapters compared a version locally and then issued an unconditional provider
operation. `review-verdict-all-backends-concurrency` recorded this as a boundary
mismatch, not a OneDrive defect. A provider-side compare-and-set exists for Dropbox
content writes and all OneDrive mutations, but not for Google Drive v3 at all.

## Functional requirements (EARS)

- **Ubiquitous** The adapter boundary shall declare, per provider,
  `exclusiveCreate`, `conditionalContentUpdate` (`all` | `none`),
  `conditionalMetadataMutation`, and `versionBoundRead` (`revision` | `reobserve`).
- **Event-driven** When `updateFile` carries an `ExpectedVersion` and
  `conditionalContentUpdate` is `all`, the adapter shall carry that version to the
  provider operation.
- **Event-driven** When `createFile` runs and `exclusiveCreate` is true, the adapter
  shall request a create the provider rejects when the destination is occupied.
- **Event-driven** When `move`/`delete` carries an `ExpectedVersion` and
  `conditionalMetadataMutation` is true, the adapter shall send it; every adapter shall
  reject an `expected` whose `id` differs from the object being mutated.
- **State-driven** While `read(input)` runs, `content` shall be returned only when the
  bytes are proven to belong to `input.versionToken`; otherwise `target_changed` or
  `unverifiable`.
- **Unwanted** If a provider has no precondition for an operation, the adapter shall
  compare before mutating, fail closed on an observed mismatch, and not advertise the
  precondition as enforced.
- **Ubiquitous** Google Drive version evidence shall be the provider's monotonic
  `version` for files and directories, so a metadata-only change is a version change.

## Acceptance scenarios

1. Given a Dropbox update whose expected rev no longer matches, when the adapter writes,
   then Dropbox returns `path/conflict` and the adapter reports `target_changed`; the
   concurrent bytes survive.
2. Given a Dropbox create at an occupied path, when the adapter creates, then it
   reports `target_changed` and the existing bytes survive.
3. Given an OneDrive update whose expected eTag no longer matches, when the adapter
   writes, then the compare-before-mutate rejects it (`conditionalContentUpdate` is
   `none`) and the concurrent bytes survive.
4. Given a OneDrive create at an occupied name, when the adapter creates, then Graph
   returns 412 and the existing bytes survive.
5. Given an OneDrive create at an occupied name, when the adapter creates, then
   `conflictBehavior=fail` rejects it; content updates have no provider precondition that
   binds the commit, and a zero-byte write conditions its mtime PATCH on its own PUT's
   eTag.
6. Given a Google Drive read whose `version` advances between observation and download,
   when the adapter reads, then it reports `target_changed`.
7. Given a Dropbox read, when the adapter returns content, then it downloaded the exact
   requested revision.

## Non-functional requirements

- **Compatibility** The five shared managed contracts stay green; no new persistent
  state, migration, or recovery marker is introduced.
- **Observability** Capability is a declared, testable property; the Google Drive
  residual check-to-use race is recorded, not hidden.

## Non-goals

- A provider-side CAS for Google Drive.
- Changing the sync engine's Admission or fresh-state reconciliation.
- Persisting operation intent, retry instructions, or recovery markers.
