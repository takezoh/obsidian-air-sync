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
 * What the correspondence does across the commit boundary. A committed
 * `SyncRecord` at path `P` binds remote identity `K1`; a *different* remote
 * object `K2` then occupies `P` while `K1` is alive at another address `Q`.
 * The durable store is keyed by remote identity (`state.ts`,
 * `keyPath: "remoteIdentityKey"` with a unique index over `path`), and every
 * publication is one of exactly two operations: a **rename**, which moves no
 * row and issues no delete, or a **replacement**, which ends the incumbent
 * correspondence with an explicit delete inside the claiming transaction.
 *
 * The split-cycle cases below record the model working rather than a defect:
 * when no fact in a cycle places `K1` anywhere, the correspondence whose
 * address now belongs to another object has ended, the claiming publication
 * observes that end directly, and `K1` is re-acquired whole on the cycle that
 * finally observes `Q`. That cost — a re-keyed row, a re-downloaded object and
 * one unbaselined cycle — is asserted here deliberately.
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
 * (`compareAndPut` / `compareAndDelete` / `compareAndRewritePaths` /
 * `compareAndPutContent`) together with the two record expectations it
 * compared; and every object-store `delete` the transactions actually issue is
 * recorded, so a rename and a replacement are told apart by the store's calls
 * and not only by the image they leave. The store itself still performs every
 * write.
 */

const P = "notes/p.md";
const Q = "notes/q.md";
const K1 = "remote-k1";
const K2 = "remote-k2";
const K1_BODY = "k1 body";
const K2_BODY = "k2 body";
/** `conflict` + `duplicate` names the preserved sibling from the losing bytes. */
const PRESERVED = "notes/p.conflict.md";
/** The remote mock mints a provider identity for the preserved sibling it creates. */
const PRESERVED_KEY = "id:notes/p.conflict.md";

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
	return record ? `${record.path}@${record.remoteIdentityKey}` : "none";
}

/**
 * Every object-store delete the real transactions issue. The spy calls through,
 * so the store still performs every write; only the calls are recorded, and the
 * record is cleared at the start of each cycle, which runs to completion before
 * any other env's does.
 */
const deleteSpy = vi.spyOn(IDBObjectStore.prototype, "delete");
function issuedDeletes(): string[] {
	return deleteSpy.mock.contexts.map((context, index) => {
		const key = deleteSpy.mock.calls[index]?.[0];
		return `${(context as IDBObjectStore).name}:${typeof key === "string" ? key : JSON.stringify(key)}`;
	});
}

/** Pass-through spies: the real store still writes; the route is recorded by name. */
function traceCommits(store: SyncStateStore, commits: string[]): void {
	const put = store.compareAndPut.bind(store);
	vi.spyOn(store, "compareAndPut").mockImplementation(async (expectedRow, record, expectedOccupant) => {
		const ok = await put(expectedRow, record, expectedOccupant);
		commits.push(`compareAndPut(row=${recordKey(expectedRow)}, terminal=${recordKey(record)}, ` +
			`occupant=${recordKey(expectedOccupant)})=${ok}`);
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
	/** The store's calls, not its image: which rows a transaction actually removed. */
	deletes: string[];
	outcomes: { succeeded: string[]; failed: string[]; blocked: number };
}

/** One production cycle: collect → scope/capture → admit → execute → publish. */
async function runCycle(
	env: Env,
	opts: { forceFullScan?: boolean; enableThreeWayMerge?: boolean } = {},
): Promise<CycleReport> {
	env.commits.length = 0;
	deleteSpy.mockClear();
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
		deletes: issuedDeletes(),
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
		const base = await env.stateStore.getContent(record.remoteIdentityKey);
		lines.push(`${recordKey(record)} mergeBase=${base === undefined ? "absent" : new TextDecoder().decode(base)}`);
	}
	return lines;
}

/** Merge base for one remote identity, which may hold one with no record of its own. */
async function mergeBaseFor(env: Env, remoteIdentityKey: string): Promise<string> {
	const base = await env.stateStore.getContent(remoteIdentityKey);
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
		`compareAndPut(row=none, terminal=${P}@${K1}, occupant=none)=true`,
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


describe("a different remote object at a baselined address, across the commit boundary", () => {
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
		// A rename: one put, no delete at all, and the identically keyed base stays put.
		expect(cycle.commits).toEqual([
			`compareAndPut(row=${P}@${K1}, terminal=${Q}@${K1}, occupant=none)=true`,
			`compareAndPutContent(${Q}@${K1}, ${K1_BODY})=true`,
		]);
		expect(cycle.deletes).toEqual([]);
		expect(cycle.outcomes).toEqual({ succeeded: [`rename_local ${Q}`], failed: [], blocked: 0 });
		expect(await storeImage(env)).toEqual([`${Q}@${K1} mergeBase=${K1_BODY}`]);
		expect(texts(env.localFs)).toEqual([`${Q}=${K1_BODY}`]);
	});

	it("shape 1, same cycle: K1's baseline is NOT lost — its row relocates P→Q as one put", async () => {
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
		// K1's publication carries its own row to a new address, so it is one put; K2's
		// claims a now-vacant address, so it is another. Neither is a replacement: no
		// record row is deleted, and the single delete is the invalidation predicate
		// clearing K2's (empty) base slot because its publication continues no row.
		expect(cycle.commits).toEqual([
			`compareAndPut(row=${P}@${K1}, terminal=${Q}@${K1}, occupant=none)=true`,
			`compareAndPutContent(${Q}@${K1}, ${K1_BODY})=true`,
			`compareAndPut(row=none, terminal=${P}@${K2}, occupant=none)=true`,
			`compareAndPutContent(${P}@${K2}, ${K1_BODY})=true`,
		]);
		expect(cycle.deletes).toEqual([`sync-content:${K2}`]);
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
			`compareAndPut(row=${P}@${K1}, terminal=${Q}@${K1}, occupant=none)=true`,
			`compareAndPutContent(${Q}@${K1}, ${K1_BODY})=true`,
			`compareAndPut(row=none, terminal=${P}@${K2}, occupant=none)=true`,
			`compareAndPutContent(${P}@${K2}, ${K1_BODY})=true`,
		]);
		expect(cycle.deletes).toEqual([`sync-content:${K2}`]);
		expect(await storeImage(env)).toEqual([
			`${P}@${K2} mergeBase=${K1_BODY}`,
			`${Q}@${K1} mergeBase=${K1_BODY}`,
		]);
	});

	it("shape 2, split across cycles: cycle 1 ends K1's correspondence with an explicit delete", async () => {
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
		// `replacement = true`. A replacement continues no row, so it publishes
		// `{source: undefined, destination: expected}`: the incumbent is the occupant of
		// the claimed address and nothing else.
		expect(cycle.actions).toEqual([
			`conflict ${P} publication(source=none, destination=${P}@${K1})`,
		]);
		expect(cycle.commits).toEqual([
			`compareAndPut(row=none, terminal=${P}@${K2}, occupant=${P}@${K1})=true`,
			`compareAndPutContent(${P}@${K2}, ${K1_BODY})=true`,
		]);
		// The incumbent's removal is an explicit delete inside the transaction that
		// claims the address — the operation, not a side effect of the put. K2's own
		// base row is cleared by the invalidation predicate before it is rewritten.
		expect(cycle.deletes).toEqual([
			`sync-records:${K1}`, `sync-content:${K1}`, `sync-content:${K2}`,
		]);
		expect(cycle.outcomes).toEqual({ succeeded: [`conflict ${P}`], failed: [], blocked: 0 });
		// K1's correspondence has ended: no row binds K1 and no merge base survives for
		// it. Exactly one row holds P, and it is K2's.
		expect(await storeImage(env)).toEqual([`${P}@${K2} mergeBase=${K1_BODY}`]);
		expect(await mergeBaseFor(env, K1)).toBe("absent");
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
			`compareAndPut(row=none, terminal=${PRESERVED}@${PRESERVED_KEY}, occupant=none)=true`,
			`compareAndPut(row=none, terminal=${Q}@${K1}, occupant=none)=true`,
			`compareAndPutContent(${PRESERVED}@${PRESERVED_KEY}, ${K2_BODY})=true`,
			`compareAndPutContent(${Q}@${K1}, ${K1_BODY})=true`,
		]);
		// The durable end state is the SAME as the same-cycle shape. The ended
		// correspondence costs a re-keyed row, a re-downloaded object and one
		// unbaselined cycle — it does not steer either side to a different result.
		expect(await storeImage(env)).toEqual([
			`${PRESERVED}@${PRESERVED_KEY} mergeBase=${K2_BODY}`,
			`${P}@${K2} mergeBase=${K1_BODY}`,
			`${Q}@${K1} mergeBase=${K1_BODY}`,
		]);
		expect(texts(env.localFs)).toEqual([
			`${PRESERVED}=${K2_BODY}`, `${P}=${K1_BODY}`, `${Q}=${K1_BODY}`,
		]);
	});

	it("merge base: a replacement ends K1's base with its row; a rename keeps it", async () => {
		// `maybeStoreMergeBase` re-derives a base for every record it commits, which
		// would mask the store's own predicates. Running the measured cycle with
		// three-way merge off (a setting the user can toggle between cycles) leaves
		// only `state.ts`'s delete behaviour observable.
		const split = await baselineAtP("mergebase-split");
		expect(await mergeBaseFor(split, K1)).toBe(K1_BODY);
		await moveK1AndCreateK2(split);
		split.setDelta({ modified: [P], deleted: [] });

		const first = await runCycle(split, { enableThreeWayMerge: false });

		// The replacement ends K1's correspondence outright — its row and the base keyed
		// with it go together — and K2's own base is invalidated because this
		// publication continues no row (`!expectedRow`). Nothing is inherited.
		expect(first.commits).toEqual([
			`compareAndPut(row=none, terminal=${P}@${K2}, occupant=${P}@${K1})=true`,
		]);
		expect(first.deletes).toEqual([
			`sync-records:${K1}`, `sync-content:${K1}`, `sync-content:${K2}`,
		]);
		expect(await storeImage(split)).toEqual([`${P}@${K2} mergeBase=absent`]);

		// A rename does not move the row, so it does not move the base either: the
		// record relocates P→Q with nothing else writing at P, the bytes never change,
		// and the invalidation predicate therefore leaves K1's base exactly where it is.
		const relocation = await baselineAtP("mergebase-relocation");
		await relocation.remoteFs.rename(P, Q);
		relocation.setDelta({ modified: [], deleted: [], renamed: [{ oldPath: P, newPath: Q }] });

		const moved = await runCycle(relocation, { enableThreeWayMerge: false });

		expect(moved.commits).toEqual([
			`compareAndPut(row=${P}@${K1}, terminal=${Q}@${K1}, occupant=none)=true`,
		]);
		expect(moved.deletes).toEqual([]);
		expect(await mergeBaseFor(relocation, K1)).toBe(K1_BODY);
		expect(await storeImage(relocation)).toEqual([`${Q}@${K1} mergeBase=${K1_BODY}`]);

		// Same cycle with the substitution: K1's row relocates and keeps its base, while
		// K2 arrives at a vacant address with none of its own.
		const same = await baselineAtP("mergebase-same");
		await moveK1AndCreateK2(same);
		same.setDelta({ modified: [P, Q], deleted: [] });

		const cycle = await runCycle(same, { enableThreeWayMerge: false });

		expect(cycle.commits).toEqual([
			`compareAndPut(row=${P}@${K1}, terminal=${Q}@${K1}, occupant=none)=true`,
			`compareAndPut(row=none, terminal=${P}@${K2}, occupant=none)=true`,
		]);
		expect(cycle.deletes).toEqual([`sync-content:${K2}`]);
		expect(await storeImage(same)).toEqual([
			`${P}@${K2} mergeBase=absent`,
			`${Q}@${K1} mergeBase=${K1_BODY}`,
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
			`conflict ${P} publication(source=none, destination=${P}@${K1})`,
		]);
		expect(cycle.commits).toEqual([
			`compareAndPut(row=none, terminal=${P}@${K2}, occupant=${P}@${K1})=true`,
			`compareAndPutContent(${P}@${K2}, ${K2_BODY})=true`,
		]);
		expect(cycle.deletes).toEqual([
			`sync-records:${K1}`, `sync-content:${K1}`, `sync-content:${K2}`,
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
