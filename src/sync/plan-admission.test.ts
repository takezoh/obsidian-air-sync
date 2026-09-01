import { describe, expect, it } from "vitest";
import type { FileEntity } from "../fs/types";
import { renameEvidenceKey } from "./identity-evidence";
import {
	admitDestructivePlan,
	captureCycleAdmissionSnapshot,
	type AuthorizedSyncPlan,
} from "./plan-admission";
import type {
	IdentityEvidence,
	PathObservation,
	ScopeDisposition,
	ScopeProjection,
	SyncAction,
} from "./types";

function entity(path: string, identityKey?: string): FileEntity {
	return { path, identityKey, pathAuthority: "actual_resolved", isDirectory: false, size: 1, mtime: 1, hash: "h" };
}

function projection(entries: Record<string, ScopeDisposition>): ScopeProjection {
	return { byEndpoint: new Map(Object.entries(entries)) };
}

function admit(
	actions: SyncAction[],
	evidence: IdentityEvidence[] = [],
	observations: PathObservation[] = [],
	scope: ScopeProjection = projection({}),
) {
	return admitDestructivePlan(captureCycleAdmissionSnapshot(
		{ actions }, evidence, observations, scope, "backend\0root",
	));
}

function remoteRename(
	overrides: Partial<Extract<IdentityEvidence, { kind: "rename" }>> = {},
): Extract<IdentityEvidence, { kind: "rename" }> {
	return {
		kind: "rename", side: "remote", oldPath: "A.md", newPath: "B.md",
		isFolder: false, authority: "reported", identityKey: "X", ...overrides,
	};
}

describe("admitDestructivePlan", () => {
	it("admits a genuine exact-path remote deletion without identity evidence", () => {
		const action: SyncAction = { path: "gone.md", action: "delete_local", local: entity("gone.md") };

		const result = admit([action], [], [{
			kind: "absent", side: "remote", requestedPath: "gone.md", authority: "checkpoint_deleted",
		}]);

		expect(result.executable.actions).toEqual([action]);
		expect(result.deferred).toEqual([]);
		expect(result.localRenameLifecycle.persistBeforeExecution).toEqual([]);
		expect(result.localRenameLifecycle.releaseAfterSafeCheckpoint).toEqual([]);
	});

	it("retains a local rename when the additive proof has unknown current scope", () => {
		const action: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const observations: PathObservation[] = [
			{ kind: "unknown", side: "local", requestedPath: "A.md", reason: "not_observed" },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		];

		const result = admit([action], evidence, observations, projection({
			"A.md": "unknown", "B.md": "included",
		}));

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]?.reasons).toContain("unknown_observation");
		expect(result.localRenameLifecycle.persistBeforeExecution).toEqual(evidence);
		expect(result.localRenameLifecycle.releaseAfterSafeCheckpoint).toEqual([]);
	});

	it("retains a local rename when the remote destination is already occupied", () => {
		const action: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const observations: PathObservation[] = [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "remote") },
		];

		const result = admit([action], evidence, observations, projection({
			"A.md": "included", "B.md": "included",
		}));

		expect(result.executable.actions).toEqual([]);
		expect(result.localRenameLifecycle.persistBeforeExecution).toEqual(evidence);
	});

	it("retains a local rename when the source has baseline membership", () => {
		const action: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const observations: PathObservation[] = [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		];
		const snapshot = captureCycleAdmissionSnapshot(
			{ actions: [action] }, evidence, observations,
			projection({ "A.md": "included", "B.md": "included" }), "backend\0root", ["A.md"],
		);

		const result = admitDestructivePlan(snapshot);

		expect(result.executable.actions).toEqual([]);
		expect(result.localRenameLifecycle.persistBeforeExecution).toEqual(evidence);
	});

	it("admits only the terminal push for an unbaselined local rename chain", () => {
		const action: SyncAction = { path: "C.md", action: "push", local: entity("C.md") };
		const evidence = [
			remoteRename({ side: "local", identityKey: undefined, oldPath: "A.md", newPath: "B.md" }),
			remoteRename({ side: "local", identityKey: undefined, oldPath: "B.md", newPath: "C.md" }),
		];
		const observations: PathObservation[] = [
			...(["A.md", "B.md"] as const).flatMap((path) => [
				{ kind: "absent" as const, side: "local" as const, requestedPath: path, authority: "stat" as const },
				{ kind: "absent" as const, side: "remote" as const, requestedPath: path, authority: "stat" as const },
			]),
			{ kind: "exact", side: "local", requestedPath: "C.md", entity: entity("C.md") },
			{ kind: "absent", side: "remote", requestedPath: "C.md", authority: "stat" },
		];

		const result = admit([action], evidence, observations, projection({
			"A.md": "included", "B.md": "included", "C.md": "included",
		}));

		expect(result.executable.actions).toEqual([action]);
		expect(result.localRenameLifecycle.persistBeforeExecution).toEqual([]);
		expect(result.localRenameLifecycle.releaseAfterSafeCheckpoint).toEqual([]);
	});

	it("defers unobserved case-distinct deletions independently", () => {
		const actions: SyncAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "a.md", action: "delete_remote", remote: entity("a.md") },
		];

		const result = admit(actions);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred).toHaveLength(2);
		expect(result.deferred.map((item) => item.reasons)).toEqual([
			["unknown_observation"], ["unknown_observation"],
		]);
	});

	it("defers both opposing deletes joined by stable identity", () => {
		const actions: SyncAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "a.md", action: "delete_remote", remote: entity("a.md", "X") },
		];
		const evidence: IdentityEvidence[] = [{
			kind: "stable_identity", side: "remote", identityKey: "X", occurrences: [
				{ side: "remote", phase: "baseline", path: "A.md", identityKey: "X" },
				{ side: "remote", phase: "current", path: "a.md", identityKey: "X" },
			],
		}];

		const result = admit(actions, evidence);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]).toMatchObject({
			paths: ["A.md", "a.md"], reasons: ["opposing_deletes"], actions,
		});
	});

	it("defers a stable-identity component without a permitted postcondition", () => {
		const action: SyncAction = { path: "A.md", action: "delete_local", local: entity("A.md") };
		const evidence: IdentityEvidence[] = [{
			kind: "stable_identity", side: "remote", identityKey: "X", occurrences: [
				{ side: "remote", phase: "baseline", path: "A.md", identityKey: "X" },
				{ side: "remote", phase: "current", path: "B.md", identityKey: "X" },
			],
		}];

		const result = admit([action], evidence);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["identity_postcondition_unproven"]);
	});

	it("does not let unrelated stable identity replace authoritative delete absence", () => {
		const action: SyncAction = { path: "A.md", action: "delete_local", local: entity("A.md") };
		const evidence: IdentityEvidence[] = [{
			kind: "stable_identity", side: "remote", identityKey: "X", occurrences: [
				{ side: "remote", phase: "baseline", path: "A.md", identityKey: "X" },
			],
		}];

		const result = admit([action], evidence);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]?.reasons).toEqual(["unknown_observation"]);
	});

	it("defers every action touching a requested-echo observation", () => {
		const actions: SyncAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "B.md", action: "match", remote: entity("B.md") },
			{ path: "safe.md", action: "push", local: entity("safe.md") },
		];
		const observations: PathObservation[] = [{
			kind: "present_unresolved", side: "remote", requestedPath: "A.md", returnedPath: "B.md",
			entity: { ...entity("B.md"), pathAuthority: "requested_echo" }, source: "stat",
		}];

		const result = admit(actions, [], observations);

		expect(result.executable.actions).toEqual([actions[2]]);
		expect(result.deferred[0]).toMatchObject({
			paths: ["A.md", "B.md"], reasons: ["present_unresolved"], actions: actions.slice(0, 2),
		});
	});

	it("retains and defers an unresolved evidence component with no actions", () => {
		const observations: PathObservation[] = [{
			kind: "present_unresolved", side: "remote", requestedPath: "A.md", returnedPath: "B.md",
			entity: { ...entity("B.md"), pathAuthority: "requested_echo" }, source: "stat",
		}];

		const result = admit([], [remoteRename()], observations);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred).toHaveLength(1);
		expect(result.deferred[0]).toMatchObject({
			paths: ["A.md", "B.md"], reasons: ["present_unresolved"], actions: [],
		});
	});

	it("resolves an actionless rename after authoritative two-sided convergence", () => {
		const observations: PathObservation[] = (["local", "remote"] as const).flatMap((side) => [
			{ kind: "absent" as const, side, requestedPath: "A.md", authority: "stat" as const },
			{ kind: "exact" as const, side, requestedPath: "B.md", entity: entity("B.md", "X") },
		]);

		const result = admit([], [remoteRename()], observations, projection({
			"A.md": "included", "B.md": "included",
		}));

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred).toEqual([]);
		expect(result.dispositions).toEqual([expect.objectContaining({
			kind: "resolved_no_action", paths: ["A.md", "B.md"], actions: [],
		})]);
		expect(result.localRenameLifecycle.releaseAfterSafeCheckpoint).toEqual([]);
	});

	it("releases only replayed debt for an already-converged rename", () => {
		const evidence = remoteRename({ side: "local", identityKey: undefined });
		const observations: PathObservation[] = (["local", "remote"] as const).flatMap((side) => [
			{ kind: "absent" as const, side, requestedPath: "A.md", authority: "stat" as const },
			{ kind: "exact" as const, side, requestedPath: "B.md", entity: entity("B.md") },
		]);
		const snapshot = captureCycleAdmissionSnapshot(
			{ actions: [] }, [evidence], observations,
			projection({ "A.md": "included", "B.md": "included" }),
			"backend\0root", [], [renameEvidenceKey(evidence)],
		);

		const result = admitDestructivePlan(snapshot);

		expect(result.localRenameLifecycle.persistBeforeExecution).toEqual([]);
		expect(result.localRenameLifecycle.releaseAfterSafeCheckpoint).toEqual([evidence]);
	});

	it("admits an additive push when a local rename has no synchronized anchor", () => {
		const action: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const observations: PathObservation[] = [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		];

		const result = admit([action], evidence, observations, projection({
			"A.md": "included", "B.md": "included",
		}));

		expect(result.executable.actions).toEqual([action]);
		expect(result.deferred).toEqual([]);
		expect(result.localRenameLifecycle.persistBeforeExecution).toEqual([]);
		expect(result.localRenameLifecycle.releaseAfterSafeCheckpoint).toEqual([]);
	});

	it("releases replayed debt after its additive push succeeds", () => {
		const action: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = remoteRename({ side: "local", identityKey: undefined });
		const observations: PathObservation[] = [
			{ kind: "absent", side: "local", requestedPath: "A.md", authority: "stat" },
			{ kind: "absent", side: "remote", requestedPath: "A.md", authority: "stat" },
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "absent", side: "remote", requestedPath: "B.md", authority: "stat" },
		];
		const snapshot = captureCycleAdmissionSnapshot(
			{ actions: [action] }, [evidence], observations,
			projection({ "A.md": "included", "B.md": "included" }),
			"backend\0root", [], [renameEvidenceKey(evidence)],
		);

		const result = admitDestructivePlan(snapshot);

		expect(result.executable.actions).toEqual([action]);
		expect(result.localRenameLifecycle.persistBeforeExecution).toEqual([]);
		expect(result.localRenameLifecycle.releaseAfterSafeCheckpoint).toEqual([evidence]);
	});

	it("keeps captured inputs stable when caller-owned containers change", () => {
		const action: SyncAction = { path: "gone.md", action: "delete_local", local: entity("gone.md") };
		const plan = { actions: [action] };
		const evidence: IdentityEvidence[] = [];
		const observations: PathObservation[] = [{
			kind: "absent", side: "remote", requestedPath: "gone.md", authority: "checkpoint_deleted",
		}];
		const scope = projection({ "gone.md": "included" });
		const snapshot = captureCycleAdmissionSnapshot(plan, evidence, observations, scope, "backend\0root");

		plan.actions.length = 0;
		observations.length = 0;
		(scope.byEndpoint as Map<string, ScopeDisposition>).set("gone.md", "unknown");

		const result = admitDestructivePlan(snapshot);
		expect(result.executable.actions).toEqual([action]);
		expect(result.snapshot.namespace).toBe("backend\0root");
	});

	it("keeps plain proposals outside the executor contract", () => {
		const proposal = { actions: [] };
		// @ts-expect-error A plain proposal is not an Admission-issued plan.
		const unauthorized: AuthorizedSyncPlan = proposal;
		expect(unauthorized.actions).toEqual([]);
	});

	it("defers match and delete together when an alias links them", () => {
		const actions: SyncAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "a.md", action: "match", remote: entity("a.md") },
		];
		const evidence: IdentityEvidence[] = [{
			kind: "alias", side: "local", requestedPath: "A.md", resolvedPath: "a.md",
		}];

		const result = admit(actions, evidence);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]).toMatchObject({ reasons: ["alias_target_mutation"], actions });
	});

	it("defers an opposite-side delete that treats an alias request as independently absent", () => {
		const action: SyncAction = { path: "A.md", action: "delete_remote", remote: entity("A.md", "X") };
		const evidence: IdentityEvidence[] = [{
			kind: "alias", side: "local", requestedPath: "A.md", resolvedPath: "a.md",
		}];

		const result = admit([action], evidence);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["alias_target_mutation"]);
	});

	it("admits an exact native rename matching reported movement", () => {
		const action: SyncAction = {
			path: "B.md", oldPath: "A.md", action: "rename_local",
			local: entity("A.md"), remote: entity("B.md", "X"),
		};
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit([action], [remoteRename()], [], scope);

		expect(result.executable.actions).toEqual([action]);
		expect(result.deferred).toEqual([]);
	});

	it("shapes a proved local rename and its lifecycle from the base component", () => {
		const baseline = {
			path: "A.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, syncedAt: 1, remoteIdentityKey: "X",
		};
		const deletion: SyncAction = {
			path: "A.md", action: "delete_remote",
			remote: entity("A.md", "X"),
			baseline,
		};
		const push: SyncAction = { path: "B.md", action: "push", local: entity("B.md") };
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const result = admit([deletion, push], evidence, [], projection({
			"A.md": "included", "B.md": "included",
		}));

		expect(result.executable.actions).toEqual([{
			path: "B.md", oldPath: "A.md", action: "rename_remote",
			local: push.local, remote: deletion.remote, baseline: deletion.baseline,
		}]);
		expect(result.deferred).toEqual([]);
		expect(result.localRenameLifecycle.persistBeforeExecution).toEqual(evidence);
		expect(result.localRenameLifecycle.releaseAfterSafeCheckpoint).toEqual(evidence);
	});

	it("shapes a backend-reported remote rename from the base component", () => {
		const baseline = {
			path: "A.md", hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, syncedAt: 1, remoteIdentityKey: "X",
		};
		const deletion: SyncAction = {
			path: "A.md", action: "delete_local", local: entity("A.md"), baseline,
		};
		const pull: SyncAction = { path: "B.md", action: "pull", remote: entity("B.md", "X") };

		const result = admit([deletion, pull], [remoteRename()], [], projection({
			"A.md": "included", "B.md": "included",
		}));

		expect(result.executable.actions).toEqual([{
			path: "B.md", oldPath: "A.md", action: "rename_local",
			local: deletion.local, remote: pull.remote, baseline,
		}]);
		expect(result.deferred).toEqual([]);
	});

	it("shapes disconnected local and remote renames without disturbing ordinary order", () => {
		const baseline = (path: string, remoteIdentityKey?: string) => ({
			path, hash: "h", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, syncedAt: 1, remoteIdentityKey,
		});
		const ordinary: SyncAction = { path: "middle.md", action: "push", local: entity("middle.md") };
		const proposal: SyncAction[] = [
			{
				path: "local-old.md", action: "delete_remote",
				remote: entity("local-old.md", "L"), baseline: baseline("local-old.md", "L"),
			},
			{ path: "local-new.md", action: "push", local: entity("local-new.md") },
			ordinary,
			{
				path: "remote-old.md", action: "delete_local",
				local: entity("remote-old.md"), baseline: baseline("remote-old.md", "R"),
			},
			{ path: "remote-new.md", action: "pull", remote: entity("remote-new.md", "R") },
		];
		const evidence: IdentityEvidence[] = [
			remoteRename({
				side: "local", oldPath: "local-old.md", newPath: "local-new.md",
				identityKey: undefined,
			}),
			remoteRename({ oldPath: "remote-old.md", newPath: "remote-new.md", identityKey: "R" }),
		];
		const scope = projection(Object.fromEntries([
			"local-old.md", "local-new.md", "middle.md", "remote-old.md", "remote-new.md",
		].map((path) => [path, "included" as const])));

		const result = admit(proposal, evidence, [], scope);

		expect(result.executable.actions.map((action) => action.action)).toEqual([
			"rename_remote", "push", "rename_local",
		]);
		expect(result.executable.actions[1]).toBe(ordinary);
		const targets = result.executable.actions.map((action) => action.path);
		expect(new Set(targets).size).toBe(targets.length);
	});

	it("admits a remote case-only rename when the local destination aliases its source", () => {
		const action: SyncAction = {
			path: "a.md", oldPath: "A.md", action: "rename_local",
			local: entity("A.md"), remote: entity("a.md", "X"),
		};
		const evidence: IdentityEvidence[] = [
			remoteRename({ oldPath: "A.md", newPath: "a.md" }),
			{ kind: "alias", side: "local", requestedPath: "a.md", resolvedPath: "A.md" },
		];

		const result = admit([action], evidence, [], projection({
			"A.md": "included", "a.md": "included",
		}));

		expect(result.executable.actions).toEqual([action]);
		expect(result.deferred).toEqual([]);
	});

	it("admits a local case-only rename when the remote destination aliases its source", () => {
		const action: SyncAction = {
			path: "a.md", oldPath: "A.md", action: "rename_remote",
			local: entity("a.md"), remote: entity("A.md", "X"),
		};
		const evidence: IdentityEvidence[] = [
			{
				kind: "rename", side: "local", oldPath: "A.md", newPath: "a.md",
				isFolder: false, authority: "reported",
			},
			{ kind: "alias", side: "remote", requestedPath: "a.md", resolvedPath: "A.md" },
		];

		const result = admit([action], evidence, [], projection({
			"A.md": "included", "a.md": "included",
		}));

		expect(result.executable.actions).toEqual([action]);
		expect(result.deferred).toEqual([]);
	});

	it("defers a native rename whose current destination identity contradicts the report", () => {
		const action: SyncAction = {
			path: "B.md", oldPath: "A.md", action: "rename_local",
			local: entity("A.md"), remote: entity("B.md", "Y"),
		};
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit([action], [remoteRename()], [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["conflicting_identity"]);
	});

	it("defers a reported rename that contradicts stable baseline identity", () => {
		const action: SyncAction = {
			path: "B.md", oldPath: "A.md", action: "rename_local",
			local: entity("A.md"), remote: entity("B.md", "X"),
		};
		const evidence: IdentityEvidence[] = [remoteRename(), {
			kind: "stable_identity", side: "remote", identityKey: "Y", occurrences: [
				{ side: "remote", phase: "baseline", path: "A.md", identityKey: "Y" },
				{ side: "remote", phase: "current", path: "C.md", identityKey: "Y" },
			],
		}];
		const scope = projection({ "A.md": "included", "B.md": "included", "C.md": "included" });

		const result = admit([action], evidence, [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["conflicting_identity"]);
	});

	it("admits a native rename when alias evidence is on the source side", () => {
		const action: SyncAction = {
			path: "a.md", oldPath: "A.md", action: "rename_remote",
			local: entity("a.md"), remote: entity("A.md", "X"),
		};
		const evidence: IdentityEvidence[] = [
			remoteRename({ side: "local", oldPath: "A.md", newPath: "a.md", identityKey: undefined }),
			{ kind: "alias", side: "local", requestedPath: "A.md", resolvedPath: "a.md" },
		];
		const scope = projection({ "A.md": "included", "a.md": "included" });

		const result = admit([action], evidence, [], scope);

		expect(result.executable.actions).toEqual([action]);
		expect(result.deferred).toEqual([]);
	});

	it("defers a native rename when its target side already occupies the destination", () => {
		const action: SyncAction = {
			path: "B.md", oldPath: "A.md", action: "rename_remote",
			local: entity("B.md"), remote: entity("A.md", "X"),
		};
		const evidence = [remoteRename({ side: "local", identityKey: undefined })];
		const observations: PathObservation[] = [{
			kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "Y"),
		}];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit([action], evidence, observations, scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["rename_mismatch"]);
	});

	it("defers a reported rename whose refined actions do not prove a safe postcondition", () => {
		const actions: SyncAction[] = [
			{ path: "A.md", action: "delete_local", local: entity("A.md") },
			{ path: "B.md", action: "delete_remote", remote: entity("B.md", "X") },
		];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit(actions, [remoteRename()], [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["opposing_deletes"]);
	});

	it("admits the exact in-scope to policy-out consequence", () => {
		const action: SyncAction = { path: "A.md", action: "delete_local", local: entity("A.md") };
		const scope = projection({ "A.md": "included", "B.md": "policy_out" });

		const result = admit([action], [remoteRename()], [], scope);

		expect(result.executable.actions).toEqual([action]);
		expect(result.deferred).toEqual([]);
	});

	it("defers a rename crossing an unknown scope endpoint", () => {
		const action: SyncAction = { path: "A.md", action: "delete_local", local: entity("A.md") };
		const scope = projection({ "A.md": "included", "B.md": "unknown" });

		const result = admit([action], [remoteRename()], [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["unknown_scope"]);
	});

	it("admits source recreation when unequal remote identities prove both resources", () => {
		const actions: SyncAction[] = [
			{ path: "A.md", action: "pull", remote: entity("A.md", "Y") },
			{ path: "B.md", action: "pull", remote: entity("B.md", "X") },
		];
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: entity("A.md", "Y") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "X") },
		];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit(actions, [remoteRename()], observations, scope);

		expect(result.executable.actions).toEqual(actions);
		expect(result.deferred).toEqual([]);
	});

	it("defers an unrecognized extra action in a source-recreation component", () => {
		const actions: SyncAction[] = [
			{ path: "B.md", action: "pull", remote: entity("B.md", "X") },
			{ path: "B.md", oldPath: "A.md", action: "rename_remote" },
		];
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: entity("A.md", "Y") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "X") },
		];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit(actions, [remoteRename()], observations, scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["rename_mismatch"]);
	});

	it("defers a source-recreation component containing an action outside both endpoints", () => {
		const actions: SyncAction[] = [
			{ path: "B.md", action: "pull", remote: entity("B.md", "X") },
			{ path: "C.md", oldPath: "A.md", action: "rename_remote", remote: entity("C.md", "Z") },
		];
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: entity("A.md", "Y") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "X") },
			{ kind: "exact", side: "remote", requestedPath: "C.md", entity: entity("C.md", "Z") },
		];
		const scope = projection({ "A.md": "included", "B.md": "included", "C.md": "included" });

		const result = admit(actions, [remoteRename()], observations, scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["rename_mismatch"]);
	});

	it("defers a conflict because its strategy cannot prove source-recreation survival", () => {
		const actions: SyncAction[] = [
			{ path: "A.md", action: "pull", remote: entity("A.md", "Y") },
			{ path: "B.md", action: "conflict", local: entity("B.md"), remote: entity("B.md", "X") },
		];
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "A.md", entity: entity("A.md", "Y") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "X") },
		];
		const scope = projection({ "A.md": "included", "B.md": "included" });

		const result = admit(actions, [remoteRename()], observations, scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["rename_mismatch"]);
	});

	it("defers an out-to-in transfer when the destination side is occupied", () => {
		const action: SyncAction = { path: "B.md", action: "pull", remote: entity("B.md", "X") };
		const scope = projection({ "A.md": "policy_out", "B.md": "included" });
		const observations: PathObservation[] = [{
			kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md"),
		}];

		const result = admit([action], [remoteRename()], observations, scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["rename_mismatch"]);
	});

	it("defers a folder rename when a projected descendant is not mapped", () => {
		const action: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local", isFolder: true,
			descendants: [{ oldPath: "A/known.md", newPath: "B/known.md" }],
		};
		const evidence = [remoteRename({ oldPath: "A", newPath: "B", isFolder: true })];
		const scope = projection({
			A: "included", B: "included", "A/known.md": "included", "B/known.md": "included",
			"A/missing.md": "included", "B/missing.md": "included",
		});

		const descendantAction: SyncAction = { path: "A/missing.md", action: "match" };
		const result = admit([action, descendantAction], evidence, [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.actions).toEqual([action, descendantAction]);
		expect(result.deferred[0]!.reasons).toEqual(["incomplete_folder_mapping"]);
	});

	it("defers a folder rename containing a descendant absent from scope projection", () => {
		const action: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local", isFolder: true,
			descendants: [{ oldPath: "A/hidden.md", newPath: "B/hidden.md" }],
		};
		const evidence = [remoteRename({ oldPath: "A", newPath: "B", isFolder: true })];
		const scope = projection({ A: "included", B: "included" });

		const result = admit([action], evidence, [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["incomplete_folder_mapping"]);
	});

	it("defers a folder rename whose descendant relative paths are crossed", () => {
		const action: SyncAction = {
			path: "B", oldPath: "A", action: "rename_local", isFolder: true,
			descendants: [
				{ oldPath: "A/x.md", newPath: "B/y.md" },
				{ oldPath: "A/y.md", newPath: "B/x.md" },
			],
		};
		const evidence = [remoteRename({ oldPath: "A", newPath: "B", isFolder: true })];
		const scope = projection({
			A: "included", B: "included", "A/x.md": "included", "B/x.md": "included",
			"A/y.md": "included", "B/y.md": "included",
		});

		const result = admit([action], evidence, [], scope);

		expect(result.executable.actions).toEqual([]);
		expect(result.deferred[0]!.reasons).toEqual(["incomplete_folder_mapping"]);
	});

	it("marks only the exact singleton tracked pull as priority-substitutable", () => {
		const baseline = {
			path: "note.md", hash: "old", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "remote-id", syncedAt: 1,
		};
		const local = entity("note.md");
		const remote = entity("note.md", "remote-id");
		const action: SyncAction = { path: "note.md", action: "pull", local, remote, baseline };
		const result = admit([action], [], [
			{ kind: "exact", side: "local", requestedPath: "note.md", entity: local },
			{ kind: "exact", side: "remote", requestedPath: "note.md", entity: remote },
		], projection({ "note.md": "included" }));

		const disposition = result.dispositions.find((item) => item.kind === "authorized");
		expect(disposition?.kind === "authorized" && disposition.priorityPullAction).toBe(action);
	});

	it("does not mark a pull connected to cross-path evidence", () => {
		const baseline = {
			path: "B.md", hash: "old", localMtime: 1, remoteMtime: 1,
			localSize: 1, remoteSize: 1, remoteIdentityKey: "X", syncedAt: 1,
		};
		const action: SyncAction = {
			path: "B.md", action: "pull", local: entity("B.md"), remote: entity("B.md", "X"), baseline,
		};
		const result = admit([action], [remoteRename()], [
			{ kind: "exact", side: "local", requestedPath: "B.md", entity: entity("B.md") },
			{ kind: "exact", side: "remote", requestedPath: "B.md", entity: entity("B.md", "X") },
		], projection({ "A.md": "included", "B.md": "included" }));

		expect(result.dispositions.some((item) =>
			item.kind === "authorized" && item.priorityPullAction !== undefined)).toBe(false);
	});

	it("does not mutate the plan, observations, evidence, or projection", () => {
		const action: SyncAction = { path: "gone.md", action: "delete_local", local: entity("gone.md") };
		const evidence: IdentityEvidence[] = [];
		const observations: PathObservation[] = [];
		const scope = projection({ "gone.md": "included" });
		const plan = { actions: [action] };

		admitDestructivePlan(captureCycleAdmissionSnapshot(
			plan, evidence, observations, scope, "backend\0root",
		));

		expect(plan).toEqual({ actions: [action] });
		expect(evidence).toEqual([]);
		expect(observations).toEqual([]);
		expect([...scope.byEndpoint]).toEqual([["gone.md", "included"]]);
	});
});
