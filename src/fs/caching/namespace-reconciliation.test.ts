import { describe, expect, it } from "vitest";
import { groupRepairableContentions, namespaceRepairFor } from "./namespace-reconciliation";
import type { NamespaceRepairPolicy } from "./namespace-reconciliation";
import type { AddressDisplacement } from "./claim-set-assignment";

const fact = (
	admittedId: string,
	withheldId: string,
	overrides: Partial<AddressDisplacement> = {},
): AddressDisplacement => ({
	path: "Note.md", admittedId, withheldId, displacedPaths: [],
	reason: "lowest_stable_id", owesRemediation: true, ...overrides,
});

const policy = (overrides: Partial<NamespaceRepairPolicy> = {}): NamespaceRepairPolicy => ({
	isInScope: () => true,
	keeper: () => Promise.resolve(undefined),
	...overrides,
});

describe("namespaceRepairFor", () => {
	it("renames the withheld claimant when the admitted claimant keeps the address", () => {
		expect(namespaceRepairFor(fact("a-id", "b-id"), undefined)).toEqual({
			path: "Note.md", identityKey: "b-id", target: "Note.conflict-id-b-id.md",
		});
	});

	it("renames the admitted claimant when the engine names the withheld claimant the keeper", () => {
		expect(namespaceRepairFor(fact("a-id", "b-id"), "b-id")).toEqual({
			path: "Note.md", identityKey: "a-id", target: "Note.conflict-id-a-id.md",
		});
	});

	it("is a function of the unordered claim pair: the same keeper names the same mover either way", () => {
		// The FS observes the claims in whatever order the provider reports them; the
		// repair must not depend on which id happened to be admitted first.
		expect(namespaceRepairFor(fact("a-id", "b-id"), "b-id"))
			.toEqual(namespaceRepairFor(fact("b-id", "a-id"), "b-id"));
	});

	it("never targets the conflict-preservation 64-hex form", () => {
		const hex = "a".repeat(64);
		expect(namespaceRepairFor(fact("admitted", hex), "admitted").target)
			.toBe(`Note.conflict-id-${hex}.md`);
	});
});

describe("groupRepairableContentions", () => {
	it("keeps a wholly provider-resolved, in-scope address", () => {
		expect([...groupRepairableContentions([fact("a", "b")], policy()).keys()]).toEqual(["Note.md"]);
	});

	it("drops an address whose claim is not provider-resolved", () => {
		expect(groupRepairableContentions([fact("a", "b", { owesRemediation: false })], policy()).size).toBe(0);
	});

	it("drops an out-of-scope address", () => {
		expect(groupRepairableContentions([fact("a", "b")], policy({ isInScope: () => false })).size).toBe(0);
	});

	it("drops a whole address when one of its claimants is not provider-resolved", () => {
		// A mixed address: one provider-resolved loss and one requested_echo guess. The
		// group is dropped whole — renaming from an incomplete topology is the bug.
		const mixed = [fact("a", "b"), fact("a", "c", { owesRemediation: false })];
		expect(groupRepairableContentions(mixed, policy()).size).toBe(0);
	});
});
