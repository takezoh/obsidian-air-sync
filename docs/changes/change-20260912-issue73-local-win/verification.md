---
change: change-20260912-issue73-local-win
role: verification
---

<!-- lifecycle is owned by change.md -->

# Verification

## T0 — pure and focused contracts

- Settings tests: Prefer local round-trip; Auto merge default; `ask -> duplicate`; unknown -> Auto merge; label-description association.
- Proof table: non-empty common SHA-256 baseline; all three inequalities; empty/missing baseline; missing/opaque/different-algorithm checksum; byte-read SHA fallback; equal current bytes; identity/mtime/size/record-existence non-proof.
- Admission table: binary `local_win_allowed | preservation_required` for Prefer-local conflicts; simple proven edit/edit; uncertain simple collision; existing match, local/remote edit-delete survivor, and compound paths; fatal missing/invalid disposition on a Prefer-local conflict.
- Read accounting: additional reads are K qualified Prefer-local candidates; Auto merge and Duplicate are exactly zero.
- Carrier boundary: hash enrichment may consume a body to fill `FileEntity.hash`, but BatchObservation and Admission expose no `ArrayBuffer` or exact snapshot field; resolver/executor acquire and revalidate exact snapshots at application time.

## T1 — composed behavior and failures

- Map UAC-001..018 directly to settings, Admission, resolver/executor and convergence assertions. In particular prove ordinary push/pull/create (002..005), proven local bytes/no copy (006), uncertain Duplicate placement (007..008), survivor (009), compound success/failure (010/016), strategy compatibility (011..013/017..018), equal-content match (014), and preservation failure safety (015).
- Run equivalent complete-fact fixtures through COLD, WARM, and HOT and require the same disposition/effects.
- Inject local/remote read failure and endpoint mutation. Under Prefer local required capture becomes non-clean with no destructive suffix, SyncRecord or checkpoint. Under Auto merge/Duplicate the new read is never invoked and existing outcomes/failure surfaces remain unchanged.
- Interrupt after preservation and after one original effect; require terminal proof before file publication, wholly-clean cycle before checkpoint, attempt abort after siblings settle, and fresh current-facts classification on retry.
- Run Admission authority, fact-only carrier, single-route, and sync-state ownership/publication guards.

## T2 — repository gate

```bash
npm run lint
npm run lint:bot-repro
npm run build
npm run test:coverage
```

All four commands, every UAC assertion, read-count/failure injection, and ownership guard must be green. Any failure leaves the change unclosable; tests or rules may not be disabled. Credential-gated live E2E is not required because this design changes no provider contract, but any existing opted-in run must observe the same public outcomes.
