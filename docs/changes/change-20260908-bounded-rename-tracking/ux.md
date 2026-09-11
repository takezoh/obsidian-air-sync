---
change: change-20260908-bounded-rename-tracking
role: ux
---

<!-- lifecycle is owned by change.md -->

# Conservative convergence for ambiguous relations

## Goal

Air Sync shall not turn an unprovable rename relation into a permanent stopped state when existing observations can still preserve every readable current version. A unique relation keeps native rename. Positively separate exact paths sync normally. A collision positively exposed by current exact, alias, or provider-resolved facts becomes one deterministic preservation cover.

Air Sync does not guess case-folding, Unicode, or provider normalization and does not choose a winning original. The user-visible success condition is that every distinct exact byte version is verified at an included sibling on both sides and repeated sync creates nothing further; originals may remain asymmetric.

## Primary flow

1. The user runs ordinary sync; there is no recovery command, prompt, or new mode.
2. Observation collects current facts through existing list/stat/read behavior.
3. Admission keeps one uniquely proven rename, otherwise chooses ordinary exact-path actions or one cover only from affirmative current collision facts.
4. Execution validates each destination with authoritative stat immediately before its write. A newly exposed occupant stops that effect and leaves checkpoint unchanged.
5. The next ordinary sync starts from fresh facts. If current alias resolution now exposes the collision, it chooses `P` as the minimum UTF-8 bytes of those resolved paths and creates or reuses exactly one `insertConflictSuffix(P, fullSha256)` sibling per byte version.
6. A wholly clean cycle publishes the checkpoint last. The next unchanged run reports `up_to_date`.

## Observable states

- `conflict`: one observed collision component, regardless of the number of cover children.
- `partial_error`: a pre-write collision, capture/effect/proof/publication failure, or unavailable required occurrence; successful published prefix remains.
- `up_to_date`: every cover obligation is two-sided and terminal, eligible stale records are gone, and no ordinary work remains.

History is audit output only. It does not instruct a later cycle.

## Acceptance scenarios

### UAC-BRT-001 — Distinct paths abandon only the relation

**Given** `Old.md:R` and `New.md:L` are positively observed as separate exact/provider occurrences but their rename relation is ambiguous
**When** sync runs
**Then** existing ordinary path actions preserve both and no cover is created.

### UAC-BRT-002 — Three exact versions receive one cover each

**Given** current exact/alias facts expose one collision containing bytes A, B, and C
**When** sync completes
**Then** one conflict reports three `insertConflictSuffix(P, fullSha256)` children using the same minimum-UTF-8 anchor `P`, each is verified on both sides, and a repeated run creates no sibling.

### UAC-BRT-003 — Equal bytes consolidate only inside the collision

**Given** three occurrences in one observed collision contain identical bytes A
**When** sync completes
**Then** one full-digest A sibling is created or reused; equal bytes at positively distinct exact paths remain distinct ordinary files.

### UAC-BRT-004 — One candidate either covers or blocks

**Given** `insertConflictSuffix(P, fullDigestA)` already contains A
**And** `insertConflictSuffix(P, fullDigestB)` contains foreign bytes
**And** unrelated conflict-looking files also exist
**When** Admission builds once
**Then** it absorbs the A candidate and unions its endpoint facts
**And** it leaves the B occupant and unrelated files as independent ordinary components
**And** the cover reports `preservation_destination_unavailable` for B without choosing an alternate name.

### UAC-BRT-005 — Published prefix survives interruption

**Given** A and B children are terminal and published but C fails
**When** the user retries normal sync
**Then** A and B are reused and only C is attempted; the failed cycle did not advance the checkpoint.

### UAC-BRT-006 — Unobservable duplicates remain a real error

**Given** a provider exposes multiple objects at one path but cannot enumerate and address each object independently
**When** sync observes that component
**Then** it reports a non-clean observation failure and mutates no original.

### UAC-BRT-007 — Asymmetric originals can be clean

**Given** every distinct byte version has a verified two-sided sibling while an original spelling exists only on one side
**When** eligible abandoned records are removed by exact CAS
**Then** the cycle may be clean and later runs neither recreate the original nor derive a delete from record absence.

### UAC-BRT-008 — Existing controls remain unchanged

**Given** current facts prove a unique rename, an ordinary same-path conflict, an unrelated conflict-looking file, or an excluded/unavailable generated destination
**When** sync runs
**Then** existing native behavior applies, cover logic connects only the single same-byte candidate, and foreign occupancy or unavailable required destination scope reports `preservation_destination_unavailable` without an alternate.

### UAC-BRT-009 — Latent collision converges through a fresh cycle

**Given** cycle 1 admits an ordinary write from its frozen facts
**And** authoritative stat immediately before the write exposes an unexpected exact-path occupant or an alias/cross-path occupant
**When** the write is reached
**Then** no effect occurs at that destination, the prior successful component prefix is retained, the suffix is blocked, and the checkpoint remains unchanged
**When** cycle 2 runs from fresh facts
**Then** a foreign-byte occupant at the same exact path uses the existing same-path conflict flow and creates no preservation cover
**And** only a different path positively joined by fresh current-cycle alias resolution becomes a preservation cover
**And** an occurrence that still cannot be independently observed remains an observation failure
**And** after the selected preservation flow completes a third unchanged sync is `up_to_date`.

## Counterexamples

- Lowercasing or Unicode-normalizing paths to predict a provider collision is invalid.
- Overwriting the newly discovered pre-write occupant is invalid.
- Converting an admitted ordinary action to a cover or another suffix in the same cycle is invalid.
- Claiming preservation of provider duplicates that cannot each be enumerated/read is invalid.
- Selecting newest content, deleting an original before cover proof, or using history as retry authority is invalid.
