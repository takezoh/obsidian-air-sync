import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { collectChanges } from "./change-detector";
import { LocalChangeTracker } from "./local-tracker";
import { prepareSyncCycleSnapshotForExecution } from "./sync-cycle-planning";
import { admitBatchObservation } from "./plan-admission";
import { executePlan } from "./plan-executor";
import { SyncStateStore } from "./state";
import {
	addFile,
	createMockLocalFs,
	createMockRemoteFs,
	readText,
	type MockFileSystem,
} from "../__mocks__/sync-test-helpers";
import type { RenamePair, SyncRecord } from "./types";

/**
 * Measurement, not a fix. Question: a committed `SyncRecord` at path `P` binds
 * remote identity `K1`; a *different* remote object `K2` then occupies `P` while
 * `K1` is alive at another address `Q`. The durable store is path-keyed
 * (`state.ts:35`, `keyPath: "path"`) and Admission's own record index is
 * path-keyed too (`identity-component-decision.ts:353`). Within one cycle
 * Admission does distinguish the substitution (`:550-551` sets `replacement`).
 * What survives the commit?
 *
 * Unlike the Admission-only measurement in `plan-admission.test.ts`, this one
 * crosses the publication boundary, so it uses the real `SyncStateStore` over
 * the repository's `fake-indexeddb` and drives every cycle through the
 * production entry chain the orchestrator uses
 * (`orchestrator.ts:368-434`): `collectChanges` →
 * `prepareSyncCycleSnapshotForExecution` → `admitBatchObservation` →
 * `executePlan`. Nothing here calls an internal helper to manufacture a result;
 * the only test-side seam is the mock backend's own delta
 * (`IncrementalCheckpoint.getChangedPaths`), which is what decides whether both
 * addresses are observed in one cycle or in two.
 *
 * Instrument: the durable publication routes on the real store are wrapped with
 * pass-through spies, so each cycle yields the commit route *by name*
 * (`compareAndPut` / `compareAndMove` / `compareAndDelete` /
 * `compareAndRewritePaths` / `compareAndPutContent`) together with the record
 * keys and identities it compared. The store itself still performs every write.
 */

const P = "notes/p.md";
const Q = "notes/q.md";
const K1 = "remote-k1";
const K2 = "remote-k2";
const K1_BODY = "k1 body";
const K2_BODY = "k2 body";
/** `conflict` + `duplicate` names the preserved sibling from the losing bytes. */
const PRESERVED = "notes/p.conflict.md";

interface RemoteDelta {
	modified?: string[];
	deleted?: string[];
	renamed?: RenamePair[];
}

interface Env {
	localFs: MockFileSystem;
	remoteFs: MockFileSystem;
	stateStore: SyncStateStore;
	localTracker: LocalChangeTracker;
	commits: string[];
	setDelta(delta: RemoteDelta): void;
}

function recordKey(record: Pick<SyncRecord, "path" | "remoteIdentityKey"> | undefined): string {
	return record ? `${record.path}@${record.remoteIdentityKey ?? "no-identity"}` : "none";
}

/** Pass-through spies: the real store still writes; the route is recorded by name. */
function traceCommits(store: SyncStateStore, commits: string[]): void {
	const put = store.compareAndPut.bind(store);
	vi.spyOn(store, "compareAndPut").mockImplementation(async (expected, record) => {
		const ok = await put(expected, record);
		commits.push(`compareAndPut(destination=${recordKey(expected)}, terminal=${recordKey(record)})=${ok}`);
		return ok;
	});
	const move = store.compareAndMove.bind(store);
	vi.spyOn(store, "compareAndMove").mockImplementation(async (expected, record, destination) => {
		const ok = await move(expected, record, destination);
		commits.push(`compareAndMove(source=${recordKey(expected)}, terminal=${recordKey(record)}, ` +
			`destination=${recordKey(destination)})=${ok}`);
		return ok;
	});
	const remove = store.compareAndDelete.bind(store);
	vi.spyOn(store, "compareAndDelete").mockImplementation(async (path, expected) => {
		const ok = await remove(path, expected);
		commits.push(`compareAndDelete(${path}, expected=${recordKey(expected)})=${ok}`);
		return ok;
	});
	const rewrite = store.compareAndRewritePaths.bind(store);
	vi.spyOn(store, "compareAndRewritePaths").mockImplementation(async (relocations) => {
		const ok = await rewrite(relocations);
		commits.push(`compareAndRewritePaths(${relocations
			.map((item) => `${item.source.path}->${item.terminal.path}`).join(",")})=${ok}`);
		return ok;
	});
	const putContent = store.compareAndPutContent.bind(store);
	vi.spyOn(store, "compareAndPutContent").mockImplementation(async (expected, content) => {
		const ok = await putContent(expected, content);
		commits.push(`compareAndPutContent(${recordKey(expected)}, ` +
			`${new TextDecoder().decode(content)})=${ok}`);
		return ok;
	});
}

async function makeEnv(name: string): Promise<Env> {
	const localFs = createMockLocalFs();
	const remoteFs = createMockRemoteFs("actual_resolved");
	const stateStore = new SyncStateStore(`${name}-${Math.random()}`);
	await stateStore.open();
	const commits: string[] = [];
	traceCommits(stateStore, commits);
	let delta: RemoteDelta = { modified: [], deleted: [] };
	const checkpoint = remoteFs.checkpoint;
	if (!checkpoint) throw new Error("mock remote must expose a checkpoint");
	checkpoint.getChangedPaths = () => Promise.resolve({
		modified: [...delta.modified ?? []],
		deleted: [...delta.deleted ?? []],
		renamed: delta.renamed ? [...delta.renamed] : undefined,
	});
	return {
		localFs, remoteFs, stateStore, commits,
		localTracker: new LocalChangeTracker(),
		setDelta: (next) => { delta = next; },
	};
}

interface CycleReport {
	temperature: string;
	failures: Array<{ paths: string[]; reasons: string[] }>;
	/** Admitted action kind, address, and the two durable publication keys. */
	actions: string[];
	commits: string[];
	outcomes: { succeeded: string[]; failed: string[]; blocked: number };
}

/** One production cycle: collect → scope/capture → admit → execute → publish. */
async function runCycle(
	env: Env,
	opts: { forceFullScan?: boolean; enableThreeWayMerge?: boolean } = {},
): Promise<CycleReport> {
	env.commits.length = 0;
	const snapshot = env.localTracker.snapshot();
	const changeSet = await collectChanges({
		localFs: env.localFs,
		remoteFs: env.remoteFs,
		stateStore: env.stateStore,
		changes: snapshot,
	}, { forceFullScan: opts.forceFullScan });
	const planning = await prepareSyncCycleSnapshotForExecution(
		changeSet, "rekey-measurement", { excludeSystemJunk: true }, "duplicate",
		env.localFs, env.remoteFs,
	);
	const admission = admitBatchObservation(planning.snapshot, "duplicate");
	const result = await executePlan(admission.executable, {
		localFs: env.localFs,
		remoteFs: env.remoteFs,
		committer: {
			stateStore: env.stateStore,
			localFs: env.localFs,
			enableThreeWayMerge: opts.enableThreeWayMerge ?? true,
		},
	});
	env.localTracker.acknowledge(snapshot);
	return {
		temperature: changeSet.temperature,
		failures: admission.failures.map((item) => ({ paths: [...item.paths], reasons: [...item.reasons] })),
		actions: admission.executable.actions.map((action) =>
			`${action.action} ${"oldPath" in action ? `${action.oldPath}->` : ""}${action.path} ` +
			`publication(source=${recordKey(action.publication?.source)}, ` +
			`destination=${recordKey(action.publication?.destination)})`),
		commits: [...env.commits],
		outcomes: {
			succeeded: result.succeeded.map((item) => `${item.action.action} ${item.action.path}`),
			failed: result.failed.map((item) => `${item.action.action} ${item.action.path}`),
			blocked: result.blocked.length,
		},
	};
}

/** Durable image: every record key, the identity it binds, and its merge base. */
async function storeImage(env: Env): Promise<string[]> {
	const records = await env.stateStore.getAll();
	const lines: string[] = [];
	for (const record of [...records].sort((a, b) => (a.path < b.path ? -1 : 1))) {
		const base = await env.stateStore.getContent(record.path);
		lines.push(`${recordKey(record)} mergeBase=${base === undefined ? "absent" : new TextDecoder().decode(base)}`);
	}
	return lines;
}

/** Merge base at addresses that may hold one with no record of their own. */
async function mergeBaseAt(env: Env, path: string): Promise<string> {
	const base = await env.stateStore.getContent(path);
	return base === undefined ? "absent" : new TextDecoder().decode(base);
}

function texts(fs: MockFileSystem): string[] {
	return [...fs.files.keys()]
		.filter((path) => fs.files.get(path)?.entity.isDirectory === false)
		.sort()
		.map((path) => `${path}=${readText(fs, path)}`);
}

/** Committed baseline: local and remote agree at P, bound to remote identity K1. */
async function baselineAtP(name: string): Promise<Env> {
	const env = await makeEnv(name);
	addFile(env.localFs, P, K1_BODY, 1000);
	addFile(env.remoteFs, P, K1_BODY, 1000).identityKey = K1;
	// HOT stats both sides, so the first cycle resolves the identical pair to a
	// real `match` and publishes a genuine committed baseline plus merge base
	// (convergence.test.ts uses the same initialization to get both hashes).
	env.localTracker.acknowledge(env.localTracker.snapshot());
	env.localTracker.markDirty(P);
	const first = await runCycle(env);
	expect(first.failures).toEqual([]);
	expect(first.actions).toEqual([
		`match ${P} publication(source=none, destination=none)`,
	]);
	expect(first.commits).toEqual([
		`compareAndPut(destination=none, terminal=${P}@${K1})=true`,
		`compareAndPutContent(${P}@${K1}, ${K1_BODY})=true`,
	]);
	expect(await storeImage(env)).toEqual([`${P}@${K1} mergeBase=${K1_BODY}`]);
	return env;
}

/** The provider mutation under measurement: K1 moves P→Q, a new K2 lands on P. */
async function moveK1AndCreateK2(env: Env): Promise<void> {
	await env.remoteFs.rename(P, Q);
	addFile(env.remoteFs, P, K2_BODY, 3000).identityKey = K2;
}


describe("a different remote object at a path-keyed baseline, across the commit boundary", () => {
	it("control: K1 alone moves P→Q — the record relocates and the local file is renamed", async () => {
		const env = await baselineAtP("control");
		await env.remoteFs.rename(P, Q);
		env.setDelta({ modified: [], deleted: [], renamed: [{ oldPath: P, newPath: Q }] });

		const cycle = await runCycle(env);

		expect(cycle.failures).toEqual([]);
		// `bindFiles` resolves the baseline's identity to its *current* address
		// (identity-component-decision.ts:408-409) and, with P now vacant, keeps the
		// move (`recreated` is false at :444), so not a byte is transferred.
		expect(cycle.actions).toEqual([
			`rename_local ${P}->${Q} publication(source=${P}@${K1}, destination=none)`,
		]);
		expect(cycle.commits).toEqual([
			`compareAndMove(source=${P}@${K1}, terminal=${Q}@${K1}, destination=none)=true`,
			`compareAndPutContent(${Q}@${K1}, ${K1_BODY})=true`,
		]);
		expect(cycle.outcomes).toEqual({ succeeded: [`rename_local ${Q}`], failed: [], blocked: 0 });
		expect(await storeImage(env)).toEqual([`${Q}@${K1} mergeBase=${K1_BODY}`]);
		expect(texts(env.localFs)).toEqual([`${Q}=${K1_BODY}`]);
	});

	it("shape 1, same cycle: K1's baseline is NOT lost — it relocates P→Q via compareAndMove", async () => {
		const env = await baselineAtP("shape1-reported");
		await moveK1AndCreateK2(env);
		expect(await storeImage(env)).toEqual([`${P}@${K1} mergeBase=${K1_BODY}`]);
		// The provider reports the move; WARM also stats P, where K2 now lives.
		env.setDelta({ modified: [P], deleted: [], renamed: [{ oldPath: P, newPath: Q }] });

		const cycle = await runCycle(env);

		expect(cycle.temperature).toBe("warm");
		expect(cycle.failures).toEqual([]);
		// Two facts save the baseline, and neither is a property of the durable store:
		//  1. P and Q are decided as ONE Admission component. Three independent,
		//     mutually redundant facts assert that union here — the provider's rename
		//     report, the `stable_identity` evidence that `identity-evidence.ts:53-72`
		//     derives from the record's `remoteIdentityKey` plus K1's current
		//     occurrence, and the `identityPaths` edge in `plan-admission-graph.ts:38-50`.
		//  2. `identity-component-decision.ts:386,408-409` binds that baseline by
		//     `currentByIdentity.get(baseline.remoteIdentityKey)` — K1 at Q — not by
		//     the record's own path, and emits `publication.source = baseline` (:460),
		//     which is the record's OLD key.
		// The K2 address is left to the exact-path owner with NO baseline (`relocated`
		// at :469 → `expected = undefined` at :506), so P is decided as a fresh pair.
		expect(cycle.actions).toEqual([
			`pull ${Q} publication(source=${P}@${K1}, destination=none)`,
			`conflict ${P} publication(source=none, destination=none)`,
		]);
		// `state-committer.ts:116-122`: a publication whose source key differs from the
		// action path is compound, so the record MOVES rather than being put.
		expect(cycle.commits).toEqual([
			`compareAndMove(source=${P}@${K1}, terminal=${Q}@${K1}, destination=none)=true`,
			`compareAndPutContent(${Q}@${K1}, ${K1_BODY})=true`,
			`compareAndPut(destination=none, terminal=${P}@${K2})=true`,
			`compareAndPutContent(${P}@${K2}, ${K1_BODY})=true`,
		]);
		expect(cycle.outcomes).toEqual({
			succeeded: [`pull ${Q}`, `conflict ${P}`], failed: [], blocked: 0,
		});
		// K1 still has a record. It is keyed by its new address, its bound identity is
		// unchanged, and the record at P now belongs to K2.
		expect(await storeImage(env)).toEqual([
			`${P}@${K2} mergeBase=${K1_BODY}`,
			`${Q}@${K1} mergeBase=${K1_BODY}`,
		]);
		// The surviving baseline buys the record, not the transfer: K1's local copy is
		// NOT renamed P→Q the way the control renames it — it is downloaded again, and
		// the stale copy left at P becomes a conflict against K2.
		expect(texts(env.localFs)).toEqual([
			`${PRESERVED}=${K2_BODY}`, `${P}=${K1_BODY}`, `${Q}=${K1_BODY}`,
		]);
		expect(texts(env.remoteFs)).toEqual([
			`${PRESERVED}=${K2_BODY}`, `${P}=${K1_BODY}`, `${Q}=${K1_BODY}`,
		]);
	});

	it("shape 1b, same cycle via full rescan with no rename pair: the same relocation", async () => {
		const env = await baselineAtP("shape1-rescan");
		await moveK1AndCreateK2(env);
		env.setDelta({ modified: [], deleted: [] });

		// COLD: both sides listed in full, and no rename pair was produced.
		const cycle = await runCycle(env, { forceFullScan: true });

		expect(cycle.temperature).toBe("cold");
		expect(cycle.failures).toEqual([]);
		// Identical outcome with zero rename evidence: the component union and the
		// identity-keyed binding do the work, not the provider's report.
		expect(cycle.actions).toEqual([
			`pull ${Q} publication(source=${P}@${K1}, destination=none)`,
			`conflict ${P} publication(source=none, destination=none)`,
		]);
		expect(cycle.commits).toEqual([
			`compareAndMove(source=${P}@${K1}, terminal=${Q}@${K1}, destination=none)=true`,
			`compareAndPutContent(${Q}@${K1}, ${K1_BODY})=true`,
			`compareAndPut(destination=none, terminal=${P}@${K2})=true`,
			`compareAndPutContent(${P}@${K2}, ${K1_BODY})=true`,
		]);
		expect(await storeImage(env)).toEqual([
			`${P}@${K2} mergeBase=${K1_BODY}`,
			`${Q}@${K1} mergeBase=${K1_BODY}`,
		]);
	});

	it("shape 2, split across cycles: cycle 1 overwrites K1's baseline at P", async () => {
		const env = await baselineAtP("shape2-cycle1");
		await moveK1AndCreateK2(env);
		expect(await storeImage(env)).toEqual([`${P}@${K1} mergeBase=${K1_BODY}`]);
		// The delta names only P. Q is never observed, so no fact in this cycle places
		// K1 anywhere, and `currentByIdentity` (identity-component-decision.ts:386)
		// cannot resolve it.
		env.setDelta({ modified: [P], deleted: [] });

		const cycle = await runCycle(env);

		expect(cycle.temperature).toBe("warm");
		expect(cycle.failures).toEqual([]);
		// With no current occurrence of K1, the baseline falls through to the
		// exact-path owner, which decides P with `expected` = K1's record and
		// `replacement = true` (identity-component-decision.ts:541-555) and publishes
		// `{source: expected, destination: expected}` — a same-key replacement.
		expect(cycle.actions).toEqual([
			`conflict ${P} publication(source=${P}@${K1}, destination=${P}@${K1})`,
		]);
		// One durable record write, and it is a same-key `compareAndPut`: K1's row is
		// the CAS expectation and K2's record is what lands on it.
		expect(cycle.commits).toEqual([
			`compareAndPut(destination=${P}@${K1}, terminal=${P}@${K2})=true`,
			`compareAndPutContent(${P}@${K2}, ${K1_BODY})=true`,
		]);
		expect(cycle.outcomes).toEqual({ succeeded: [`conflict ${P}`], failed: [], blocked: 0 });
		// K1's baseline no longer exists anywhere in the store: no row binds K1, and Q
		// has neither a record nor a merge base.
		expect(await storeImage(env)).toEqual([`${P}@${K2} mergeBase=${K1_BODY}`]);
		expect(await mergeBaseAt(env, Q)).toBe("absent");
		expect((await env.stateStore.getAll()).map((record) => record.remoteIdentityKey))
			.toEqual([K2]);
	});

	it("shape 2, split across cycles: cycle 2 then treats K1 as brand new", async () => {
		const env = await baselineAtP("shape2-cycle2");
		await moveK1AndCreateK2(env);
		env.setDelta({ modified: [P], deleted: [] });
		await runCycle(env);
		expect(await storeImage(env)).toEqual([`${P}@${K2} mergeBase=${K1_BODY}`]);

		// Q finally surfaces. There is no record for K1 and none for Q.
		env.setDelta({ modified: [Q], deleted: [] });
		const cycle = await runCycle(env);

		expect(cycle.failures).toEqual([]);
		// No baseline anywhere, so `decision-engine.ts:23` (`!local && remote`) yields
		// an unbaselined `pull` — a full re-download of K1's bytes — and a fresh
		// `compareAndPut` against an empty destination.
		expect(cycle.actions).toEqual([
			`match ${PRESERVED} publication(source=none, destination=none)`,
			`pull ${Q} publication(source=none, destination=none)`,
		]);
		// Both are independent singletons (plan-executor.ts:148-155), so they settle
		// in a pool and only the set of commit routes is ordered here.
		expect([...cycle.commits].sort()).toEqual([
			`compareAndPut(destination=none, terminal=${PRESERVED}@no-identity)=true`,
			`compareAndPut(destination=none, terminal=${Q}@${K1})=true`,
			`compareAndPutContent(${PRESERVED}@no-identity, ${K2_BODY})=true`,
			`compareAndPutContent(${Q}@${K1}, ${K1_BODY})=true`,
		]);
		// The durable end state is the SAME as the same-cycle shape. The lost baseline
		// costs a re-keyed row, a re-downloaded object and one unbaselined cycle — it
		// does not steer either side to a different result.
		expect(await storeImage(env)).toEqual([
			`${PRESERVED}@no-identity mergeBase=${K2_BODY}`,
			`${P}@${K2} mergeBase=${K1_BODY}`,
			`${Q}@${K1} mergeBase=${K1_BODY}`,
		]);
		expect(texts(env.localFs)).toEqual([
			`${PRESERVED}=${K2_BODY}`, `${P}=${K1_BODY}`, `${Q}=${K1_BODY}`,
		]);
	});

	it("merge base: K1's base at P is dropped by both publication routes, never carried", async () => {
		// `maybeStoreMergeBase` re-derives a base for every record it commits, which
		// would mask the store's own predicates. Running the measured cycle with
		// three-way merge off (a setting the user can toggle between cycles) leaves
		// only `state.ts`'s delete behaviour observable.
		const split = await baselineAtP("mergebase-split");
		expect(await mergeBaseAt(split, P)).toBe(K1_BODY);
		await moveK1AndCreateK2(split);
		split.setDelta({ modified: [P], deleted: [] });

		const first = await runCycle(split, { enableThreeWayMerge: false });

		// `state.ts:104-108`: the identity clause of `compareAndPut`'s predicate fires
		// (K1 ≠ K2) even though hash and localSize are unchanged, so K1's merge base
		// at P is deleted rather than inherited by K2's record.
		expect(first.commits).toEqual([
			`compareAndPut(destination=${P}@${K1}, terminal=${P}@${K2})=true`,
		]);
		expect(await storeImage(split)).toEqual([`${P}@${K2} mergeBase=absent`]);

		// `compareAndMove` deletes the base at BOTH keys unconditionally
		// (`state.ts:132-133`). The control isolates that: the record relocates P→Q
		// with nothing else writing at P, and K1's base is gone from both keys even
		// though the bytes never changed.
		const relocation = await baselineAtP("mergebase-relocation");
		await relocation.remoteFs.rename(P, Q);
		relocation.setDelta({ modified: [], deleted: [], renamed: [{ oldPath: P, newPath: Q }] });

		const moved = await runCycle(relocation, { enableThreeWayMerge: false });

		expect(moved.commits).toEqual([
			`compareAndMove(source=${P}@${K1}, terminal=${Q}@${K1}, destination=none)=true`,
		]);
		expect(await mergeBaseAt(relocation, P)).toBe("absent");
		expect(await storeImage(relocation)).toEqual([`${Q}@${K1} mergeBase=absent`]);

		// Same cycle with the substitution: neither route carries K1's base to Q.
		const same = await baselineAtP("mergebase-same");
		await moveK1AndCreateK2(same);
		same.setDelta({ modified: [P, Q], deleted: [] });

		const cycle = await runCycle(same, { enableThreeWayMerge: false });

		expect(cycle.commits).toEqual([
			`compareAndMove(source=${P}@${K1}, terminal=${Q}@${K1}, destination=none)=true`,
			`compareAndPut(destination=none, terminal=${P}@${K2})=true`,
		]);
		expect(await storeImage(same)).toEqual([
			`${P}@${K2} mergeBase=absent`,
			`${Q}@${K1} mergeBase=absent`,
		]);
	});

	it("a local deletion under the substituted path is a conflict, never a delete of K2", async () => {
		// The sharpest wrong-operation candidate for a path-keyed store: the user
		// deletes the local copy of K1, and the record at P — still the K1 record —
		// meets a remote object it never synced.
		const env = await baselineAtP("local-delete");
		await moveK1AndCreateK2(env);
		await env.localFs.delete(P);
		env.setDelta({ modified: [P], deleted: [] });

		const cycle = await runCycle(env);

		// `decision-engine.ts:19` reads the remote at P as changed relative to the K1
		// record, so the local absence yields `conflict`, not `delete_remote`. K2's
		// object is preserved and materialized locally instead of being deleted.
		expect(cycle.actions).toEqual([
			`conflict ${P} publication(source=${P}@${K1}, destination=${P}@${K1})`,
		]);
		expect(cycle.commits).toEqual([
			`compareAndPut(destination=${P}@${K1}, terminal=${P}@${K2})=true`,
			`compareAndPutContent(${P}@${K2}, ${K2_BODY})=true`,
		]);
		expect(texts(env.remoteFs)).toEqual([`${P}=${K2_BODY}`, `${Q}=${K1_BODY}`]);
		expect(texts(env.localFs)).toEqual([`${P}=${K2_BODY}`]);
		expect(await storeImage(env)).toEqual([`${P}@${K2} mergeBase=${K2_BODY}`]);

		// K1 is then re-acquired whole on the cycle that finally observes Q.
		env.setDelta({ modified: [Q], deleted: [] });
		const second = await runCycle(env);
		expect(second.actions).toEqual([`pull ${Q} publication(source=none, destination=none)`]);
		expect(await storeImage(env)).toEqual([
			`${P}@${K2} mergeBase=${K2_BODY}`,
			`${Q}@${K1} mergeBase=${K1_BODY}`,
		]);
	});
});
