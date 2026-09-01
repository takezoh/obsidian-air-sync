import { afterEach, describe, expect, it } from "vitest";
import type { IFileSystem } from "../interface";
import type {
	PriorityObservationCapability,
	PriorityObservationRequest,
} from "../priority-observation";

export type PriorityObservationScenario =
	| "current"
	| "changed-during-read"
	| "missing"
	| "replacement"
	| "unverifiable";

export interface PriorityObservationContractHarness {
	fs: IFileSystem & { priority: PriorityObservationCapability };
	request: PriorityObservationRequest;
	expectedToken: string;
	expectedContent: ArrayBuffer;
	replacementIdentityKey: string;
}

type MakePriorityObservationHarness = (
	scenario: PriorityObservationScenario,
) => PriorityObservationContractHarness | Promise<PriorityObservationContractHarness>;

/**
 * Shared test contract for the optional, identity-addressed file-open capability.
 *
 * This stays separate from {@link IFileSystem}: local filesystems need not expose
 * detached remote observation, while every remote adapter that does expose it must
 * agree on the same fail-closed outcomes. Assertions use only public capabilities;
 * provider-specific API shapes belong in each harness factory.
 */
export function runPriorityObservationContract(
	name: string,
	makeHarness: MakePriorityObservationHarness,
): void {
	describe(`PriorityObservation contract — ${name}`, () => {
		let current: PriorityObservationContractHarness | undefined;

		afterEach(async () => {
			await current?.fs.close?.();
			current = undefined;
		});

		async function setup(scenario: PriorityObservationScenario): Promise<PriorityObservationContractHarness> {
			current = await makeHarness(scenario);
			return current;
		}

		it("observes and reads the admitted identity", async () => {
			const harness = await setup("current");

			const observed = await harness.fs.priority.observe(harness.request);
			expect(observed).toMatchObject({
				kind: "current",
				path: harness.request.path,
				identityKey: harness.request.identityKey,
				token: harness.expectedToken,
				entity: { pathAuthority: "actual_resolved" },
			});
			if (observed.kind !== "current") throw new Error("expected current observation");
			expect(await harness.fs.priority.read(observed)).toEqual({
				kind: "content",
				content: harness.expectedContent,
			});
		});

		it("rejects content when the identity version changes during the read", async () => {
			const harness = await setup("changed-during-read");
			const observed = await harness.fs.priority.observe(harness.request);
			if (observed.kind !== "current") throw new Error("expected current observation");

			expect(await harness.fs.priority.read(observed)).toEqual({ kind: "target_changed" });
		});

		it("distinguishes an absent identity and path from a replacement", async () => {
			const missing = await setup("missing");
			expect(await missing.fs.priority.observe(missing.request)).toEqual({
				kind: "missing",
				occupant: { kind: "absent" },
			});

			await missing.fs.close?.();
			const replacement = await setup("replacement");
			expect(await replacement.fs.priority.observe(replacement.request)).toMatchObject({
				kind: "structural",
				occupant: {
					kind: "current",
					identityKey: replacement.replacementIdentityKey,
				},
			});
		});

		it("fails closed when the backend cannot supply complete version evidence", async () => {
			const harness = await setup("unverifiable");
			expect(await harness.fs.priority.observe(harness.request)).toMatchObject({
				kind: "unverifiable",
				occupant: { kind: "unverifiable" },
			});
		});
	});
}
