import { describe, expect, it } from "vitest";
import type { FileEntity, PathAuthority } from "../fs/types";
import type { IFileSystem } from "../fs/interface";
import { AbstractMetadataCache } from "../fs/caching/metadata-cache";
import type { AddressDisplacement } from "../fs/caching/claim-set-assignment";
import { applyIdDeltaPage, createIdDeltaResult } from "../fs/caching/id-delta";
import {
	planAddressContentionRemediation,
	type AddressContentionFacts,
} from "./plan-admission-address-contention";
import { admitBatchObservation } from "./plan-admission";
import { captureBatchObservation } from "./sync-cycle-planning";
import { directConflictCandidateHint } from "./conflict";
import { executePlan } from "./plan-executor";
import { finalizeSyncCycle } from "./sync-cycle-finalization";
import type { PathObservation } from "./types";
import {
	addFile, createMockLocalFs, createMockRemoteFs, createMockStateStore, readText,
} from "../__mocks__/sync-test-helpers";

const ROOT = "root";

/**
 * The minimal concrete cache, shaped like an id-addressed provider entry. Driving
 * the real cache produces the real contention facts, so these tests never
 * hand-author an `AddressDisplacement` the production arbiter could not emit.
 */
interface TestFile {
	id: string;
	name: string;
	parents: string[];
	folder?: boolean;
}

class TestMetadataCache extends AbstractMetadataCache<TestFile> {
	protected extractId(file: TestFile): string { return file.id; }
	protected extractParentIds(file: TestFile): string[] { return file.parents; }
	protected extractName(file: TestFile): string { return file.name; }
	protected isFolderEntry(file: TestFile): boolean { return file.folder === true; }
	toEntity(path: string, file: TestFile): FileEntity {
		return {
			path, pathAuthority: this.getPathAuthority(path), identityKey: file.id,
			isDirectory: file.folder === true, size: 0, mtime: 0, hash: "",
		};
	}
}

const sibling = (id: string, name = "Test.md"): TestFile => ({ id, name, parents: [ROOT] });

/** COLD: one full listing, arbitrated over the whole claim set. */
function coldContention(files: TestFile[]): readonly AddressDisplacement[] {
	return new TestMetadataCache(ROOT).buildFromFiles(files);
}

/** WARM / HOT: a restored working view plus one delta page. */
function deltaContention(seeded: TestFile, arriving: TestFile,
	authority: PathAuthority = "actual_resolved"): readonly AddressDisplacement[] {
	const cache = new TestMetadataCache(ROOT);
	cache.setFile(seeded.name, seeded, authority);
	const acc = createIdDeltaResult();
	applyIdDeltaPage(cache, acc, [{ id: arriving.id, isFolder: false, file: arriving }]);
	return acc.displacements;
}

function facts(
	contentions: readonly AddressDisplacement[],
	overrides: Partial<AddressContentionFacts> = {},
): AddressContentionFacts {
	return { contentions, recordHolders: new Set(), renameByIdentity: true, ...overrides };
}

/** The claimants holding a committed record — looked up by identity, not by address. */
function synced(...identities: string[]): ReadonlySet<string> {
	return new Set(identities);
}

/** A checkpoint whose committed cursor only moves when `commitCheckpoint` is called. */
function fakeCheckpoint(committed = "cursor-1") {
	const calls: string[] = [];
	const state = { committed, working: "cursor-2" };
	const checkpoint: NonNullable<IFileSystem["checkpoint"]> = {
		getChangedPaths: () => Promise.resolve(null),
		hasCheckpoint: () => Promise.resolve(true),
		abortWorkingView: () => {
			calls.push("abortWorkingView");
			state.working = state.committed;
			return Promise.resolve();
		},
		resetCheckpoint: () => Promise.resolve(),
		commitCheckpoint: () => {
			calls.push("commitCheckpoint");
			state.committed = state.working;
			return Promise.resolve();
		},
	};
	return { calls, state, checkpoint };
}

describe("address-contention remediation", () => {
	describe("remediability", () => {
		it("plans one rename and blocks the checkpoint for two provider-resolved claims", () => {
			const contentions = coldContention([sibling("A1"), sibling("B2")]);

			const plan = planAddressContentionRemediation(facts(contentions));

			expect(plan.actions).toEqual([{
				action: "rename_remote", path: "Test.conflict-id-B2.md",
				oldPath: "Test.md", providerIdentity: "B2",
			}]);
			expect(plan.checkpointBlocked).toBe(true);
		});

		it("plans nothing for an orphan collapse, whose claimant is a requested_echo guess", () => {
			// A guessed spelling loses to the provider-resolved one; the object it
			// names is outside the bound sync root, so nothing there is at risk.
			const contentions = deltaContention(sibling("A1"), sibling("B2"), "requested_echo");
			expect(contentions).toHaveLength(1);
			expect(contentions[0]?.owesRemediation).toBe(false);

			const plan = planAddressContentionRemediation(facts(contentions));

			expect(plan.actions).toEqual([]);
			expect(plan.checkpointBlocked).toBe(false);
		});

		it("plans nothing, and blocks nothing, when the backend cannot rename by identity", () => {
			const contentions = coldContention([sibling("A1"), sibling("B2")]);

			const plan = planAddressContentionRemediation(
				facts(contentions, { renameByIdentity: false }));

			expect(plan.actions).toEqual([]);
			// Nothing this cycle could do would clear the condition, so stalling the
			// cursor forever would be the wrong answer.
			expect(plan.checkpointBlocked).toBe(false);
		});

		it("plans at most one rename per contended address", () => {
			const contentions = coldContention([sibling("A1"), sibling("B2"), sibling("C3")]);
			expect(contentions.length).toBeGreaterThan(1);

			const plan = planAddressContentionRemediation(facts(contentions));

			expect(plan.actions).toHaveLength(1);
			expect(plan.actions[0]?.oldPath).toBe("Test.md");
		});
	});

	describe("the keeper", () => {
		it("keeps the claimant holding the committed SyncRecord and moves the newcomer", () => {
			// Adversarial: the arbiter admitted A1, but the user's established file at
			// this path is B2. The established file must keep its name.
			const contentions = coldContention([sibling("A1"), sibling("B2")]);
			expect(contentions[0]?.admittedId).toBe("A1");

			const plan = planAddressContentionRemediation(
				facts(contentions, { recordHolders: synced("B2") }));

			expect(plan.actions).toEqual([{
				action: "rename_remote", path: "Test.conflict-id-A1.md",
				oldPath: "Test.md", providerIdentity: "A1",
			}]);
		});

		it("ignores a committed record that names neither claimant", () => {
			const contentions = coldContention([sibling("A1"), sibling("B2")]);

			const plan = planAddressContentionRemediation(
				facts(contentions, { recordHolders: synced("stranger") }));

			expect(plan.actions[0]?.providerIdentity).toBe("B2");
		});

		it("falls back to the order-independent rule when every claimant was already synced", () => {
			// Two objects that each hold a record collide — one moved here from its own
			// address. Sync history singles out neither, so the arbiter's pick keeps it.
			const contentions = coldContention([sibling("A1"), sibling("B2")]);

			const plan = planAddressContentionRemediation(
				facts(contentions, { recordHolders: synced("A1", "B2") }));

			expect(plan.actions[0]?.providerIdentity).toBe("B2");
			expect(plan.withheldAddresses).toEqual(new Map());
		});

		it("decides identically for both claim orders and for COLD and delta acquisition", () => {
			const a = sibling("A1");
			const b = sibling("B2");
			const acquisitions = {
				cold: coldContention([a, b]),
				coldReversed: coldContention([b, a]),
				deltaAdmitsIncumbent: deltaContention(a, b),
				deltaAdmitsClaimant: deltaContention(b, a),
			};
			// The facts themselves legitimately differ — a delta that evicts an
			// occupant names the address it vacated, a cold scan has none to name —
			// so this is a claim about the DECISION, not about the evidence.
			expect(acquisitions.deltaAdmitsClaimant[0]?.displacedPaths).toEqual(["Test.md"]);
			expect(acquisitions.cold[0]?.displacedPaths).toEqual([]);

			for (const recordHolders of [synced(), synced("B2")]) {
				const plans = Object.entries(acquisitions).map(([temperature, contentions]) =>
					[temperature, planAddressContentionRemediation(facts(contentions, { recordHolders }))] as const);
				for (const [temperature, plan] of plans) {
					expect([temperature, plan]).toEqual([temperature, plans[0]![1]]);
				}
			}
		});

		it("does not depend on the order the contention facts arrive in", () => {
			const contentions = coldContention([sibling("A1"), sibling("B2"), sibling("C3")]);
			expect(contentions).toHaveLength(2);

			expect(planAddressContentionRemediation(facts([...contentions].reverse())))
				.toEqual(planAddressContentionRemediation(facts(contentions)));
		});
	});

	describe("the target address", () => {
		it("is the same address on a second planning run over the same facts", () => {
			const contentions = coldContention([sibling("A1"), sibling("B2")]);
			const input = facts(contentions);

			expect(planAddressContentionRemediation(input))
				.toEqual(planAddressContentionRemediation(input));
		});

		it("can never be read back as a conflict-preservation address", () => {
			const hex64 = "a".repeat(64);
			for (const [id, name] of [
				["B2", "Test.md"],
				// An id that is itself 64 hex characters, and a base path that already
				// carries a preservation suffix: the `id-` prefix is what keeps the
				// `[0-9a-f]{64}` parser from ever claiming the result.
				[hex64, "Test.md"],
				["B2", `Test.conflict-${hex64}.md`],
				["B2", "Notes"],
			] as const) {
				const plan = planAddressContentionRemediation(
					facts(coldContention([sibling("A1", name), sibling(id, name)])));
				const target = plan.actions[0]?.path;

				expect(target).toBe(`${name.replace(/(\.[^./]*)?$/, "")}.conflict-id-${id}${
					/\.[^./]*$/.exec(name)?.[0] ?? ""}`);
				expect(directConflictCandidateHint(target!)).toBeUndefined();
			}
		});
	});

	describe("the commit gate", () => {
		it("leaves commitCheckpoint uncalled and aborts the working view when a repair is owed", async () => {
			const contentions = coldContention([sibling("A1"), sibling("B2")]);
			const plan = planAddressContentionRemediation(facts(contentions));
			const { calls, state, checkpoint } = fakeCheckpoint();

			const completion = await finalizeSyncCycle({
				admission: { dispositions: [] } as never,
				result: { succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [] },
				checkpoint, scopeFingerprint: "scope",
				checkpointBlocked: plan.checkpointBlocked,
			});

			expect(completion).toEqual({ kind: "follow_up" });
			expect(calls).toEqual(["abortWorkingView"]);
			expect(state.committed).toBe("cursor-1");
		});

		it("commits normally for an orphan collapse, which owes no repair", async () => {
			const contentions = deltaContention(sibling("A1"), sibling("B2"), "requested_echo");
			const plan = planAddressContentionRemediation(facts(contentions));
			const { calls, state, checkpoint } = fakeCheckpoint();

			const completion = await finalizeSyncCycle({
				admission: { dispositions: [] } as never,
				result: { succeeded: [], superseded: [], failed: [], blocked: [], conflicts: [] },
				checkpoint, scopeFingerprint: "scope",
				checkpointBlocked: plan.checkpointBlocked,
			});

			expect(completion).toEqual({ kind: "clean" });
			expect(calls).toEqual(["commitCheckpoint"]);
			expect(state.committed).toBe("cursor-2");
		});

		it("re-derives the same repair after a failed rename left the cursor where it was", async () => {
			const contentions = coldContention([sibling("A1"), sibling("B2")]);
			const first = planAddressContentionRemediation(facts(contentions));
			const { calls, state, checkpoint } = fakeCheckpoint();

			await finalizeSyncCycle({
				admission: { dispositions: [] } as never,
				result: {
					succeeded: [], superseded: [], blocked: [], conflicts: [],
					failed: [{ action: first.actions[0]!, error: new Error("insufficient permissions") }],
				},
				checkpoint, scopeFingerprint: "scope", checkpointBlocked: first.checkpointBlocked,
			});

			expect(calls).toEqual(["abortWorkingView"]);
			expect(state.committed).toBe("cursor-1");
			// The next cycle re-observes the same unit from the same committed cursor
			// and re-derives the identical action: the retry is idempotent because the
			// target embeds the moving object's own id.
			expect(planAddressContentionRemediation(facts(coldContention([sibling("A1"), sibling("B2")]))))
				.toEqual(first);
		});
	});

	describe("the rest of the cycle", () => {
		it("syncs an uncontested path in a cycle whose checkpoint is blocked", async () => {
			const localFs = createMockLocalFs();
			const remoteFs = createMockRemoteFs("actual_resolved");
			const stateStore = createMockStateStore();
			addFile(localFs, "notes.md", "uncontested", 1000);
			const local = (await localFs.stat("notes.md"))!;
			const renamed: string[] = [];
			remoteFs.identityRename = {
				renameById: (identityKey: string) => {
					renamed.push(identityKey);
					return Promise.resolve();
				},
			};
			const observations: PathObservation[] = [
				{ kind: "exact", side: "local", requestedPath: "notes.md", entity: local },
				{ kind: "absent", side: "remote", requestedPath: "notes.md", authority: "stat" },
			];

			const admission = admitBatchObservation(
				captureBatchObservation([{ path: "notes.md", local }], [], observations, {
					byEndpoint: new Map([["notes.md", "included"]]),
					isConfiguredScopeCompatible: () => true,
				}, "contention-test"),
				"auto_merge",
				facts(coldContention([sibling("A1"), sibling("B2")])),
			);

			expect(admission.checkpointBlocked).toBe(true);
			expect(admission.executable.actions.map((action) => action.action).sort())
				.toEqual(["push", "rename_remote"]);

			const execution = await executePlan(admission.executable,
				{ localFs, remoteFs, committer: { stateStore, localFs } });
			const { calls, state, checkpoint } = fakeCheckpoint();
			const completion = await finalizeSyncCycle({
				admission, result: execution, checkpoint, scopeFingerprint: "scope",
				checkpointBlocked: admission.checkpointBlocked,
			});

			// The uncontested file synced and published its own SyncRecord; only the
			// cycle-level checkpoint was withheld.
			expect(execution.failed).toEqual([]);
			expect(execution.blocked).toEqual([]);
			expect(readText(remoteFs, "notes.md")).toBe("uncontested");
			expect(stateStore.records.has("notes.md")).toBe(true);
			expect(renamed).toEqual(["B2"]);
			expect(completion).toEqual({ kind: "follow_up" });
			expect(calls).toEqual(["abortWorkingView"]);
			expect(state.committed).toBe("cursor-1");
		});

		it("adds no action and no checkpoint block to a cycle with no contention", () => {
			const admission = admitBatchObservation(captureBatchObservation([], [], [], {
				byEndpoint: new Map(), isConfiguredScopeCompatible: () => true,
			}, "contention-test"));

			expect(admission.executable.actions).toEqual([]);
			expect(admission.checkpointBlocked).toBe(false);
		});
	});
});
