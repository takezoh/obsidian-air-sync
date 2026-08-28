import { describe, expect, it, vi } from "vitest";
import { createMockLocalFs, createMockRemoteFs, createMockStateStore, addFile } from "../__mocks__/sync-test-helpers";
import type { PriorityObservationRequest } from "../fs/priority-observation";
import { LocalChangeTracker } from "./local-tracker";
import { admitDestructivePlan, captureCycleAdmissionSnapshot, memberObligationFor } from "./plan-admission";
import { admitCurrentAction } from "./current-action-admission";
import type { PathObservation, SyncAction } from "./types";

describe("admitCurrentAction", () => {
	it.each([
		["keeps", "child-id", "run"],
		["rejects", "replacement-id", "nonterminal"],
	] as const)("%s an extra structural endpoint with current identity %s", async (
		_description, currentChildIdentity, expectedKind,
	) => {
		const localFs = createMockLocalFs();
		const remoteFs = createMockRemoteFs();
		const local = addFile(localFs, "B", "folder-target", 1000);
		const remoteSource = addFile(remoteFs, "A", "folder-source", 1000);
		remoteSource.identityKey = "folder-id";
		const frozenChild = addFile(remoteFs, "A/x.md", "child", 1000);
		frozenChild.identityKey = "child-id";
		const action: SyncAction = {
			action: "rename_remote", oldPath: "A", path: "B", isFolder: true,
			local, remote: remoteSource,
			descendants: [{ oldPath: "A/x.md", newPath: "B/x.md" }],
		};
		const observations: PathObservation[] = [
			{ kind: "exact", side: "remote", requestedPath: "A", entity: remoteSource },
			{ kind: "absent", side: "remote", requestedPath: "B", authority: "stat" },
			{ kind: "exact", side: "remote", requestedPath: "A/x.md", entity: frozenChild },
			{ kind: "absent", side: "remote", requestedPath: "B/x.md", authority: "stat" },
		];
		const admittedPlan = admitDestructivePlan(captureCycleAdmissionSnapshot(
			{ actions: [action] },
			[{ kind: "rename", side: "local", oldPath: "A", newPath: "B",
				isFolder: true, authority: "reported" }],
			observations,
			{ byEndpoint: new Map(["A", "B", "A/x.md", "B/x.md"].map((path) =>
				[path, "included" as const])) },
			"test:root",
		));
		const member = memberObligationFor(admittedPlan.executable, action);
		expect(member.componentRemoteIdentities).toEqual({
			A: "folder-id", B: null, "A/x.md": "child-id", "B/x.md": null,
		});
		const currentChild = addFile(remoteFs, "A/x.md", "current", 2000);
		currentChild.identityKey = currentChildIdentity;
		remoteFs.priority = {
			observe: vi.fn(({ path, identityKey }: PriorityObservationRequest) => {
				if (path === "B" || path === "B/x.md") {
					return Promise.resolve({ kind: "missing" as const, occupant: { kind: "absent" as const } });
				}
				const entity = path === "A" ? remoteSource : currentChild;
				const occupant = { kind: "current" as const, path,
					identityKey: entity.identityKey ?? "", token: `token:${entity.identityKey}`, entity };
				if (identityKey && identityKey !== entity.identityKey) {
					return Promise.resolve({ kind: "structural" as const, occupant });
				}
				return Promise.resolve({ ...occupant, occupant });
			}),
			read: vi.fn().mockResolvedValue({ kind: "target_changed" }),
		};

		const current = await admitCurrentAction({
			localFs, remoteFs, stateStore: createMockStateStore(),
			localTracker: new LocalChangeTracker(),
		}, action, member);

		expect(current.kind).toBe(expectedKind);
	});
});
