import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { collectChanges } from "./change-detector";
import { LocalChangeTracker } from "./local-tracker";
import { prepareSyncCycleSnapshotForExecution } from "./sync-cycle-planning";
import { type IdentityComponent } from "./plan-admission-graph";
import { decideIdentityComponent } from "./identity-component-decision";
import { selectReportFamily } from "./identity-component-report-family";
import type { FileEntity } from "../fs/types";
import type { IdentityEvidence, PathObservation, ScopeProjection, SyncActionType } from "./types";
import { admitBatchObservation } from "./plan-admission";
import { executePlan, type ExecutionContext } from "./plan-executor";
import { SyncStateStore } from "./state";
import { createChecksumRegistry } from "../fs/modules/checksum-registry";
import { sha256 } from "../utils/hash";
import { addFile, createMockLocalFs, createMockRemoteFs } from "../__mocks__/sync-test-helpers";
import type { SyncRecord } from "./types";

const registry = createChecksumRegistry();
const hashOf = (text: string): Promise<string> =>
	sha256(new TextEncoder().encode(text).buffer);

function record(path: string, identityKey: string, text: string, hash: string): SyncRecord {
	const size = new TextEncoder().encode(text).byteLength;
	return {
		path, remoteIdentityKey: identityKey, hash,
		localMtime: 1000, remoteMtime: 1000, localSize: size, remoteSize: size, syncedAt: 1,
	};
}

const A = "dev-skills/a.md";
const C = "dev-skills/a.conflict-id-1lddhmfgDKlg07Oxpl_Jlp90aq8EcsOMQ.md";
const U = "Untitled/a.md";
const R_X = "1lddhmfgDKlg07Oxpl_Jlp90aq8EcsOMQ";
const R_NEW = "1Je6y2ckR5fRSDteWYhoNQpnXvr1kkSz0";
const R_OLD = "1OLD0000000000000000000000000000000000";

/**
 * A committed row whose object is a live current endpoint at a new address, with that
 * identity unobserved at its stored path. This is the shape a namespace repair whose
 * cycle never committed its checkpoint leaves behind: the durable correspondence is
 * keyed by provider identity, while the cycle's facts are keyed by address.
 */
async function scenario(
	getChangedPaths: () => Promise<{ modified: string[]; deleted: string[]; renamed?: { oldPath: string; newPath: string }[] }>,
	options: {
		forceFullScan?: boolean; dirty?: string[]; renameReport?: boolean;
		localRenames?: ReadonlyArray<readonly [newPath: string, oldPath: string]>;
		peers?: { local?: ReadonlyArray<readonly [path: string, text: string]>;
			remote?: ReadonlyArray<readonly [path: string, text: string, identity: string]> };
		stored?: string; endpoint?: string; storedIdentity?: string; newIdentity?: string;
	} = {},
) {
	const storedPath = options.stored ?? A;
	const endpointPath = options.endpoint ?? C;
	const storedIdentity = options.storedIdentity ?? R_X;
	const newIdentity = options.newIdentity ?? R_NEW;
	const localFs = createMockLocalFs();
	const remoteFs = createMockRemoteFs("actual_resolved");
	const store = new SyncStateStore(`moved-baseline-${Math.random()}`);
	await store.open();

	const atC = addFile(remoteFs, endpointPath, "abc", 1000);
	atC.identityKey = storedIdentity;
	// The provider reports a reproducible checksum, as Google Drive does; the engine
	// uses it to prove the moved candidate's local bytes without downloading.
	atC.remoteChecksum = {
		algo: "md5",
		value: await registry.compute(new TextEncoder().encode("abc").buffer, "md5"),
	};
	const atA = addFile(remoteFs, storedPath, "zzz", 1000);
	atA.identityKey = newIdentity;
	const atU = addFile(remoteFs, U, "a", 1000);
	atU.identityKey = R_OLD;
	addFile(localFs, endpointPath, "abc", 1000);
	addFile(localFs, storedPath, "abc", 1000);
	addFile(localFs, U, "a", 1000);
	for (const [path, text] of options.peers?.local ?? []) addFile(localFs, path, text, 1000);
	for (const [path, text, identity] of options.peers?.remote ?? []) {
		addFile(remoteFs, path, text, 1000).identityKey = identity;
	}

	await store.put(record(storedPath, storedIdentity, "abc", await hashOf("abc")));
	await store.put(record(U, R_OLD, "a", await hashOf("a")));
	remoteFs.checkpoint!.getChangedPaths = options.renameReport
		? () => Promise.resolve({ modified: [], deleted: [],
			renamed: [{ oldPath: storedPath, newPath: endpointPath, isFolder: false, identityKey: storedIdentity }] })
		: getChangedPaths;

	const tracker = new LocalChangeTracker();
	if (options.dirty || options.localRenames) {
		tracker.acknowledge(tracker.snapshot());
		for (const path of options.dirty ?? []) tracker.markDirty(path);
		for (const [newPath, oldPath] of options.localRenames ?? []) tracker.markRenamed(newPath, oldPath);
	}
	const changeSet = await collectChanges(
		{ localFs, remoteFs, stateStore: store, checksumRegistry: registry,
			changes: tracker.snapshot() },
		{ forceFullScan: options.forceFullScan },
	);
	const planning = await prepareSyncCycleSnapshotForExecution(
		changeSet, "moved-baseline", { excludeSystemJunk: true }, "duplicate", localFs, remoteFs, registry,
	);
	const admission = admitBatchObservation(planning.snapshot, "duplicate");
	const ctx: ExecutionContext = {
		localFs, remoteFs, checksumRegistry: registry,
		committer: { stateStore: store, localFs, enableThreeWayMerge: false },
	};
	const result = await executePlan(admission.executable, ctx);
	const rows = (await store.getAll()).map((row) => `${row.path}@${row.remoteIdentityKey}`);
	await store.close();
	return { admission, result, rows };
}

const noCasFailure = (result: Awaited<ReturnType<typeof scenario>>["result"]) =>
	expect(result.failed.map((failure) => failure.error.message)).toEqual([]);

describe("a committed row binds to its identity's current endpoint across an unobserved move", () => {
	it("continues the row at the endpoint instead of publishing an insert", async () => {
		const { admission, result, rows } = await scenario(() =>
			Promise.resolve({ modified: [], deleted: [] }));

		noCasFailure(result);
		// The row is continued at the identity's current address, not left at the stale one.
		expect(rows).toContain(`${C}@${R_X}`);
		expect(rows).not.toContain(`${A}@${R_X}`);
		// Some admitted action at the endpoint continues the committed row (source A).
		const endpoint = admission.executable.actions.find((action) => action.path === C);
		expect(endpoint).toBeDefined();
		expect(endpoint!.publication?.source?.path).toBe(A);
	});

	it("reaches the same continuation when the remote delta names the stored path", async () => {
		const { result, rows } = await scenario(() => Promise.resolve({ modified: [A], deleted: [] }));
		noCasFailure(result);
		expect(rows).toContain(`${C}@${R_X}`);
	});

	it("reaches the same continuation on a COLD full scan", async () => {
		const { result, rows } = await scenario(
			() => Promise.resolve({ modified: [], deleted: [] }), { forceFullScan: true });
		noCasFailure(result);
		expect(rows).toContain(`${C}@${R_X}`);
	});

	it("field shape: local endpoints present, provider reports the relocation", async () => {
		const { admission, result, rows } = await scenario(
			() => Promise.resolve({ modified: [], deleted: [] }),
			{ renameReport: true });
		noCasFailure(result);
		const atC = admission.executable.actions.find((action) => action.path === C);
		expect(atC?.publication?.source?.path).toBe(A);
		expect(rows).toContain(`${C}@${R_X}`);
		expect(rows).not.toContain(`${A}@${R_X}`);
	});

	it("keeps the committed row when a conflicting report family abandons the relation", () => {
		// Field shape: the provider reports A→C carrying R_X, while a branch of local
		// rename claims makes the report family unusable. Abandoning the relation must
		// still continue R_X's committed row at its observed endpoint C, not decide C
		// unbaselined (which the identity-keyed store refuses: the match-CAS loop).
		const RX = R_X, RNEW = R_NEW;
		const ent = (path: string, text: string, identityKey?: string): FileEntity =>
			({ path, hash: text, identityKey, pathAuthority: "actual_resolved", isDirectory: false, size: text.length, mtime: 1 });
		const rec = (path: string, identityKey: string, text: string) =>
			({ path, remoteIdentityKey: identityKey, hash: text, localMtime: 1, remoteMtime: 1, localSize: text.length, remoteSize: text.length, syncedAt: 1 });
		const obs = (side: "local" | "remote", path: string, text: string, identityKey?: string): PathObservation =>
			({ kind: "exact", side, requestedPath: path, entity: ent(path, text, identityKey) });
		const B = "Untitled/b.md", D = "Untitled/d.md";
		const entries = [
			{ path: A, local: ent(A, "abc"), remote: ent(A, "zzz", RNEW), prevSync: rec(A, RX, "abc") },
			{ path: C, local: ent(C, "abc"), remote: ent(C, "abc", RX) },
			{ path: B, local: ent(B, "a"), remote: ent(B, "a") },
			{ path: D, local: ent(D, "a"), remote: ent(D, "a") },
		];
		const evidence: IdentityEvidence[] = [
			{ kind: "rename", side: "remote", oldPath: A, newPath: C, isFolder: false, authority: "reported", identityKey: RX },
			{ kind: "rename", side: "local", oldPath: A, newPath: B, isFolder: false, authority: "reported" },
			{ kind: "rename", side: "local", oldPath: A, newPath: D, isFolder: false, authority: "reported" },
			{ kind: "stable_identity", side: "remote", identityKey: RX,
				occurrences: [{ side: "remote", phase: "baseline", path: A, identityKey: RX }, { side: "remote", phase: "current", path: C, identityKey: RX }] },
		];
		const observations: PathObservation[] = [
			obs("local", A, "abc"), obs("remote", A, "zzz", RNEW),
			obs("local", C, "abc"), obs("remote", C, "abc", RX),
			obs("local", B, "a"), obs("remote", B, "a"), obs("local", D, "a"), obs("remote", D, "a"),
		];
		const scope: ScopeProjection = { isConfiguredScopeCompatible: () => true,
			byEndpoint: new Map([[A, "included"], [C, "included"], [B, "included"], [D, "included"]] as const) };
		const component: IdentityComponent = { paths: new Set([A, C, B, D]), entries, evidence, observations };
		expect(selectReportFamily(evidence.filter((item): item is IdentityEvidence & { kind: "rename" } =>
			item.kind === "rename")).kind).toBe("conflicting");

		const decision = decideIdentityComponent(component, scope, new Set([A]), "duplicate");

		expect(decision.reasons).toEqual([]);
		const atC = decision.component.actions.find((action: { path: string }) => action.path === C) as
			{ action: SyncActionType; publication?: { source?: { path?: string; remoteIdentityKey?: string }; destination?: { path?: string } } } | undefined;
		expect(atC?.action).toBe("match");
		expect(atC?.publication?.source?.path).toBe(A);
		expect(atC?.publication?.source?.remoteIdentityKey).toBe(RX);
		// The claimed address is vacant: `destination` is not the moved row, so the
		// executor's precondition and the identity-keyed CAS both hold.
		expect(atC?.publication?.destination).toBeUndefined();
	});

	it("runs the carrying action before vacating a stored path that sorts first", () => {
		// The stored path `Untitled/a.md` sorts before its endpoint `dev-skills/zz.md`,
		// so a path-ordered fallback would publish the vacancy before the carried row
		// leaves — the executor's precondition changed (the field's Untitled/a.md push).
		const stored = "Untitled/a.md", endpoint = "dev-skills/zz.md", ID = "ID_MOVED", NEW = "ID_NEW";
		const ent = (path: string, text: string, identityKey?: string): FileEntity =>
			({ path, hash: text, identityKey, pathAuthority: "actual_resolved", isDirectory: false, size: text.length, mtime: 1 });
		const rec = (path: string, identityKey: string, text: string) =>
			({ path, remoteIdentityKey: identityKey, hash: text, localMtime: 1, remoteMtime: 1, localSize: text.length, remoteSize: text.length, syncedAt: 1 });
		const obs = (side: "local" | "remote", path: string, text: string, identityKey?: string): PathObservation =>
			({ kind: "exact", side, requestedPath: path, entity: ent(path, text, identityKey) });
		const B = "Untitled/b.md", D = "Untitled/d.md";
		const entries = [
			{ path: stored, local: ent(stored, "abc"), remote: ent(stored, "zzz", NEW), prevSync: rec(stored, ID, "abc") },
			{ path: endpoint, local: ent(endpoint, "abc"), remote: ent(endpoint, "abc", ID) },
			{ path: B, local: ent(B, "a"), remote: ent(B, "a") },
			{ path: D, local: ent(D, "a"), remote: ent(D, "a") },
		];
		const evidence: IdentityEvidence[] = [
			{ kind: "rename", side: "remote", oldPath: stored, newPath: endpoint, isFolder: false, authority: "reported", identityKey: ID },
			{ kind: "rename", side: "local", oldPath: stored, newPath: B, isFolder: false, authority: "reported" },
			{ kind: "rename", side: "local", oldPath: stored, newPath: D, isFolder: false, authority: "reported" },
			{ kind: "stable_identity", side: "remote", identityKey: ID,
				occurrences: [{ side: "remote", phase: "baseline", path: stored, identityKey: ID }, { side: "remote", phase: "current", path: endpoint, identityKey: ID }] },
		];
		const observations: PathObservation[] = [
			obs("local", stored, "abc"), obs("remote", stored, "zzz", NEW),
			obs("local", endpoint, "abc"), obs("remote", endpoint, "abc", ID),
			obs("local", B, "a"), obs("remote", B, "a"), obs("local", D, "a"), obs("remote", D, "a"),
		];
		const scope: ScopeProjection = { isConfiguredScopeCompatible: () => true,
			byEndpoint: new Map([[stored, "included"], [endpoint, "included"], [B, "included"], [D, "included"]] as const) };
		const component: IdentityComponent = { paths: new Set([stored, endpoint, B, D]), entries, evidence, observations };
		const decision = decideIdentityComponent(component, scope, new Set([stored]), "duplicate");
		expect(decision.reasons).toEqual([]);
		const actions = decision.component.actions as ReadonlyArray<{ action: SyncActionType; path: string;
			publication?: { source?: { path?: string } } }>;
		const carry = actions.findIndex((action) => action.path === endpoint);
		const vacate = actions.findIndex((action) => action.path === stored);
		expect(carry).toBeGreaterThanOrEqual(0);
		expect(vacate).toBeGreaterThanOrEqual(0);
		expect(actions[carry]?.publication?.source?.path).toBe(stored);
		expect(carry).toBeLessThan(vacate);
	});

	it("executes the relocation when a conflicting report family abandons the relation", async () => {
		const B = "Untitled/b.md", D = "Untitled/d.md";
		const { result, rows } = await scenario(
			() => Promise.resolve({ modified: [], deleted: [] }),
			{ renameReport: true, localRenames: [[B, A], [D, A]],
				peers: { local: [[B, "a"], [D, "a"]], remote: [[B, "a", "ID_B"], [D, "a", "ID_D"]] } });
		noCasFailure(result);
		expect(result.blocked).toEqual([]);
		expect(rows).toContain(`${C}@${R_X}`);
		expect(rows).not.toContain(`${A}@${R_X}`);
	});

	it("executes when the stored path sorts before its moved endpoint", async () => {
		const stored = "Untitled/z.md", endpoint = "dev-skills/zz.md";
		const B = "Untitled/b.md", D = "Untitled/d.md";
		const { result, rows } = await scenario(
			() => Promise.resolve({ modified: [], deleted: [] }),
			{ renameReport: true, stored, endpoint, localRenames: [[B, stored], [D, stored]],
				peers: { local: [[B, "a"], [D, "a"]], remote: [[B, "a", "ID_B"], [D, "a", "ID_D"]] } });
		noCasFailure(result);
		expect(result.blocked).toEqual([]);
		expect(rows).toContain(`${endpoint}@${R_X}`);
		expect(rows).not.toContain(`${stored}@${R_X}`);
	});

	it("reaches the same continuation when only the endpoint is dirty", async () => {
		// Drives the HOT acquisition (the partial view is promoted to WARM for the
		// endpoint's unbaselined component): the same baseline-join must hold.
		const { result, rows } = await scenario(
			() => Promise.resolve({ modified: [C], deleted: [] }), { dirty: [C] });
		noCasFailure(result);
		expect(rows).toContain(`${C}@${R_X}`);
		expect(rows).not.toContain(`${A}@${R_X}`);
	});

	it("moves the local counterpart when a remote folder rename lands on an occupied address", () => {
		// Field shape: the provider renamed folder `Untitled` onto the existing
		// `dev-skills`, so the committed object `F2` is now observed under `dev-skills`
		// (reconciled to the conflict address) while its local counterpart is still at
		// `Untitled/a.md`. The local must move with the rename, not be pushed back to
		// the old address (which recreates `Untitled/a.md` and duplicates the content).
		const X = "Untitled/a.md", Y = "dev-skills/a.md", F1 = "F1", F2 = "F2";
		const Z = `dev-skills/a.conflict-id-${F2}.md`;
		const ent = (path: string, text: string, identityKey?: string): FileEntity =>
			({ path, hash: text, identityKey, pathAuthority: "actual_resolved", isDirectory: false, size: text.length, mtime: 1 });
		const rec = (path: string, identityKey: string, text: string): SyncRecord =>
			({ path, remoteIdentityKey: identityKey, hash: text, localMtime: 1, remoteMtime: 1, localSize: text.length, remoteSize: text.length, syncedAt: 1 });
		const obs = (side: "local" | "remote", path: string, text: string, identityKey?: string): PathObservation =>
			({ kind: "exact", side, requestedPath: path, entity: ent(path, text, identityKey) });
		const absent = (side: "local" | "remote", path: string): PathObservation =>
			({ kind: "absent", side, requestedPath: path, authority: "stat" });
		const entries = [
			{ path: X, local: ent(X, "abc") },
			{ path: Y, local: ent(Y, "a"), remote: ent(Y, "a", F1), prevSync: rec(Y, F1, "a") },
			{ path: Z, remote: ent(Z, "abc", F2) },
		];
		const evidence: IdentityEvidence[] = [
			{ kind: "rename", side: "remote", oldPath: X, newPath: Z, isFolder: false, authority: "reported", identityKey: F2 },
			{ kind: "stable_identity", side: "remote", identityKey: F2,
				occurrences: [{ side: "remote", phase: "baseline", path: Y, identityKey: F2 }, { side: "remote", phase: "current", path: Z, identityKey: F2 }] },
		];
		const observations: PathObservation[] = [
			obs("local", X, "abc"), absent("remote", X), obs("local", Y, "a"), obs("remote", Y, "a", F1),
			absent("local", Z), obs("remote", Z, "abc", F2),
		];
		const scope: ScopeProjection = { isConfiguredScopeCompatible: () => true,
			byEndpoint: new Map([[X, "included"], [Y, "included"], [Z, "included"]] as const) };
		const component: IdentityComponent = { paths: new Set([X, Y, Z]), entries, evidence, observations };

		const decision = decideIdentityComponent(component, scope, new Set([Y]), "duplicate");
		expect(decision.reasons).toEqual([]);
		const actions = decision.component.actions as ReadonlyArray<{ action: SyncActionType; path: string; oldPath?: string }>;
		// The local counterpart moves onto the identity's settled address; nothing pushes
		// the stale `Untitled/a.md` back to the provider.
		expect(actions).toContainEqual(expect.objectContaining({ action: "rename_local", path: Z, oldPath: X }));
		expect(actions.some((action) => action.action === "push" && action.path === X)).toBe(false);
	});
});
