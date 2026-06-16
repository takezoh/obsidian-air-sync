# ADR 0007 — A foreground signal re-syncs only after a real departure

**Status:** Accepted · 2026-06-16
**Context area:** sync pipeline / scheduler
**Related:** [ADR 0004](0004-sync-reruns-are-classified-by-trigger.md) (classifies triggers into signal / vault / rescan; this refines the **signal** path), [ADR 0001](0001-metadata-cache-is-subordinate-to-commit-last.md) (a dropped re-check is never unsafe — it re-converges), [sync-pipeline.md → Sync triggers](../sync-pipeline.md#sync-triggers)

## Context

The **signal** triggers (`focus`, `visibilitychange→visible`, `online`) are content-less "the world may have changed — re-check everything" requests. ADR 0004 drops one only while a sync is *in flight* (`isSyncing`). It does **not** otherwise distinguish a *genuine resume* from a *spurious* foreground signal.

On a **mobile cold start** this produces a redundant full re-scan. Two syncs run for ONE activation, and they do not overlap:

1. the `onLayoutReady` catch-up sync (`main.ts` → `runSync`), and
2. a trailing `focus` that the mobile webview **defers until the first touch**.

Because the first finishes before the second arrives, the `isSyncing` guard can't drop it, and a second WARM full scan runs (visible as a `Syncing…` flash and a duplicate "Everything up to date"). The gap between the two is **unbounded** (the deferred focus fires whenever the user first interacts), so a time window can't separate "redundant startup signal" from "genuine later resume". The real distinction is **structural: did the app actually leave the foreground in between?**

## Decision

**A foreground signal re-syncs only when the app has departed the foreground since the last sync.** The scheduler holds `departed`, and the foreground path (`triggerForegroundSync`, used by `focus` and `visibilitychange→visible`) runs a sync only when `departed` is true, clearing it when it does.

- **Starts `false`.** At cold start the `onLayoutReady` sync already covers the initial foreground, so the trailing deferred `focus` — no departure since — is dropped. No timing window.
- **Set on departure, OR'd across signals:** `blur` **and** `visibilitychange→hidden`. This is required for device coverage, not belt-and-suspenders excess:
  - a **desktop alt-tab** and a **tablet split-view / Stage Manager app-switch** both keep the document `visible`, so only `blur` fires;
  - a **phone/tablet background** fires `visibilitychange→hidden` (window focus is unreliable there).
- **Both return signals stay wired** (`focus` + `visibilitychange→visible`) for the same reason — neither alone covers iOS + Android + desktop + tablet. The cost of a real resume firing both is absorbed: the first clears `departed`, the second is a no-op.
- **`online` is a different axis (network), left ungated** — a reconnect re-checks regardless of foreground state.
- **In-flight:** a foreground signal landing during a sync returns *without* clearing `departed` (that cycle may predate the departure), so a later signal still re-checks.

Per ADR 0001 this is an **efficiency contract, not a safety one**: a dropped or extra re-check only ever costs work, never correctness — the baseline re-converges on the next trigger.

### Why detection is biased toward *over*-reporting departures

The failure modes are asymmetric, so `departed` errs toward `true`:

| | Result |
|---|---|
| **Miss** a departure | a real resume looks like "not departed" → resume suppressed → **stale data (bad)** |
| **Spurious** departure | one extra re-check runs → **harmless** (same as the old every-signal behavior) |

So departure is detected as generously as possible (any of blur / hidden), and `blur` is read at the **window** level — it fires on app focus loss, not on element focus or the soft keyboard — so normal in-app interaction does not mark a spurious departure. One exception is benign: focusing an Obsidian **popout window** (a separate Electron `BrowserWindow`) blurs the main window, so clicking between the popout and the main window marks a departure and runs one extra re-check on return. That is harmless per the efficiency contract (and no worse than the prior every-focus behavior); it is not worth distinguishing from a real app-switch.

## Consequences

- The cold-start redundant re-scan is gone **structurally** (no departure since the catch-up sync), on every device and regardless of when the deferred focus lands.
- A desktop alt-tab, a tablet app-switch, and a phone background→foreground all re-sync correctly (the departure arms the next return).
- Completion notices are naturally correct again — one per *actual* sync — with no separate notice-suppression layer, and no "`Syncing…` with no result" inconsistency.
- **Residual:** a spurious departure during the brief pre-first-touch cold-start window would let the deferred focus run one extra sync. Low probability, cosmetic (one extra "up to date"), never stale — strictly preferable to dropping a signal and risking a missed resume.

**Pinned by tests** (keep green; extend, do not weaken):
- `scheduler.test.ts` → *"departure gating (ADR 0007)"*: a foreground signal with no departure does **not** sync; `departed` clears after the resume sync (a second signal is a no-op); a `blur` departure arms a later `visibilitychange→visible`; a foreground signal dropped mid-sync keeps `departed` set so a later return still syncs (the "never miss a resume" guard — pins the `isSyncing()`-before-clear order).
- `scheduler.test.ts` → *"focus event"* / *"visibility event"*: a sync fires on focus / visibilitychange→visible **after** a departure. *"online event"*: `online` syncs with no departure.
- `scheduler.test.ts` → *"trigger classification (ADR 0004)"*: a departed foreground signal is still dropped while a sync is in flight.
