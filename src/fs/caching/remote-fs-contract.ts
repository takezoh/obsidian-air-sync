import { describe, it, expect } from "vitest";
import type { MetadataStore } from "../../store/metadata-store";
import type { CachingRemoteFs } from "./remote-fs";

/**
 * What a backend provides so the shared crash-safety contract can drive it without
 * knowing its file shape. The harness owns a single in-memory "remote" that every
 * FS it builds reads from, plus a real (fake-indexeddb) persistent store.
 */
export interface CachingRemoteFsHarness<TFile> {
	/** A fresh persistent store keyed by `id`. Use a unique id per case. */
	makeStore(id: string): MetadataStore<TFile>;
	/** Build an FS bound to `store`, reading the shared remote. */
	makeFs(store: MetadataStore<TFile>): CachingRemoteFs<TFile>;
	/** Add a file to the remote baseline (visible to a full list). */
	seedFile(path: string): void;
	/** Stage a remote deletion of `path` that the next delta will report. */
	stageRemoteDelete(path: string): void;
}

/**
 * The crash-safety / convergence contract for {@link CachingRemoteFs}, parameterized
 * over a backend harness. It pins the ADR 0001 invariants at the *base* level so any
 * backend that inherits the base inherits the guarantees too (and a new backend
 * verifies them in one line).
 *
 * **Scope — read this before relying on it for a new backend.** ADR 0001 has *two*
 * convergence paths and this contract covers them asymmetrically, on purpose:
 *
 * - **Path 1 (crash ⇒ fresh FS object replays from the committed cursor)** is fully
 *   guaranteed here — it is entirely an FS property, so the contract asserts it.
 * - **Path 2 (same-session failure ⇒ state C)** is NOT, and cannot be, closed by the
 *   FS alone: a live FS that already advanced its in-memory cursor past un-committed
 *   work will not re-surface it (the `does NOT self-heal` test below pins exactly this
 *   FS-observable boundary). Recovery is the orchestrator's job via
 *   `recoverViaColdScan` (force the next cycle cold). So a backend that runs this
 *   contract gets path-1 coverage for free but MUST ALSO be exercised at the
 *   orchestrator level for path-2 — see `orchestrator.test.ts` "forces a cold
 *   reconcile on the cycle after a failure" and ADR 0001 (state C). Parameterizing
 *   that orchestrator-level test by backend is the B3 follow-up.
 */
export function runCachingRemoteFsContract<TFile>(
	name: string,
	makeHarness: () => CachingRemoteFsHarness<TFile>,
): void {
	describe(`CachingRemoteFs crash-safety contract — ${name}`, () => {
		it("a fresh store is no checkpoint: full-scans and warrants no replay", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-fresh");
			const fs = h.makeFs(store);

			expect(await fs.hasCheckpoint()).toBe(false);
			// Initial sync: a fresh full scan captured "now", so there is no delta.
			expect(await fs.getChangedPaths()).toBeNull();
			// The fresh scan acquired a cursor, committed atomically only at checkpoint —
			// but the in-memory cursor now makes hasCheckpoint() true.
			expect(await fs.hasCheckpoint()).toBe(true);
			await store.close();
		});

		it("a committed checkpoint survives a restart (cursor co-located with the cache)", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-restart");

			const fs1 = h.makeFs(store);
			await fs1.list();
			await fs1.commitCheckpoint();

			// A brand-new FS over the same store sees the committed checkpoint with no
			// network re-list — the cursor was persisted in the same transaction as the cache.
			const fs2 = h.makeFs(store);
			expect(await fs2.hasCheckpoint()).toBe(true);
			await store.close();
		});

		it("re-reports an un-pulled remote DELETION after a crash", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-crash-del");

			// Session 1: baseline committed at the initial cursor.
			const fs1 = h.makeFs(store);
			await fs1.list();
			await fs1.commitCheckpoint();

			// A remote deletion advances the IN-MEMORY cursor — but the cycle is "killed"
			// before commitCheckpoint, so the committed cache still holds a.md.
			h.stageRemoteDelete("a.md");
			const d1 = await fs1.getChangedPaths();
			expect(d1?.deleted).toContain("a.md");

			// Session 2 (restart) over the same store: the replay restarts from the
			// COMMITTED cursor, so the deletion is re-detected. Under eager cache persist
			// it would be lost — the cache would already have dropped a.md and the replay
			// would early-return on the now-absent path.
			const fs2 = h.makeFs(store);
			const d2 = await fs2.getChangedPaths();
			expect(d2?.deleted).toContain("a.md");
			await store.close();
		});

		it("does NOT self-heal an un-committed change in-session (path 2 is the orchestrator's job)", async () => {
			// The flip side of the crash test, and the reason `recoverViaColdScan` exists.
			// A live FS that detected a change advanced its IN-MEMORY cursor past it (state
			// C). Without a commit, a SECOND pass on the SAME FS does not re-surface it —
			// the FS cannot self-recover in-session. So an orchestrator that re-ran only
			// the live FS after a failed cycle would silently drop the work; that gap is
			// closed at the orchestrator level (force-cold next cycle), NOT here. Pinning
			// this FS-observable boundary keeps a new backend from assuming the contract
			// covers path 2.
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-no-self-heal");

			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();

			h.stageRemoteDelete("a.md");
			const first = await fs.getChangedPaths();
			expect(first?.deleted).toContain("a.md"); // detected once; in-memory cursor advanced

			// No commit ⇒ committed cursor still behind. The live FS does NOT re-report it.
			const second = await fs.getChangedPaths();
			expect(second?.deleted ?? []).not.toContain("a.md");
			expect(await fs.hasCheckpoint()).toBe(true); // in-memory cursor present, unchanged
			await store.close();
		});

		it("resetCheckpoint discards the committed checkpoint", async () => {
			const h = makeHarness();
			h.seedFile("a.md");
			const store = h.makeStore("contract-reset");

			const fs = h.makeFs(store);
			await fs.list();
			await fs.commitCheckpoint();
			expect(await fs.hasCheckpoint()).toBe(true);

			await fs.resetCheckpoint();
			expect(await fs.hasCheckpoint()).toBe(false);
			await store.close();
		});
	});
}
