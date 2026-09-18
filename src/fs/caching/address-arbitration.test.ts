import { describe, it, expect } from "vitest";
import type { PathAuthority } from "../types";
import { arbitrateAddress, type AddressClaim } from "./address-arbitration";

const PATH = "notes/Test.md";

/**
 * The exhaustive domain. Three stable ids — including the empty string, a
 * degenerate value the arbiter must still order rather than reject — crossed with
 * both authorities. A real claim set carries ONE authority per stable id (a claim
 * is one provider object with one resolved spelling), so the generators below
 * assign an authority per id and then draw multisets of ids from it.
 */
const IDS = ["", "a", "b"] as const;
const AUTHORITIES: PathAuthority[] = ["actual_resolved", "requested_echo"];

/** Every id → authority assignment over IDS (2³ = 8). */
function authorityAssignments(): Map<string, PathAuthority>[] {
	const out: Map<string, PathAuthority>[] = [];
	for (const first of AUTHORITIES) {
		for (const second of AUTHORITIES) {
			for (const third of AUTHORITIES) {
				out.push(new Map([[IDS[0], first], [IDS[1], second], [IDS[2], third]]));
			}
		}
	}
	return out;
}

/** Every multiset of `size` ids drawn from IDS, as a sorted array (combinations with repetition). */
function idMultisets(size: number): string[][] {
	if (size === 0) return [[]];
	const out: string[][] = [];
	for (let i = 0; i < IDS.length; i++) {
		for (const rest of idMultisets(size - 1)) {
			const head = IDS[i]!;
			if (rest.length > 0 && rest[0]! < head) continue;
			out.push([head, ...rest]);
		}
	}
	return out;
}

/** Every permutation of `items`, driven exhaustively rather than sampled. */
function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	const out: T[][] = [];
	for (let i = 0; i < items.length; i++) {
		const rest = [...items.slice(0, i), ...items.slice(i + 1)];
		for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
	}
	return out;
}

/** Every claim (id × authority) — used for the pairwise symmetry sweep. */
function allClaims(): AddressClaim[] {
	return IDS.flatMap((id) => AUTHORITIES.map((authority): AddressClaim => ({ id, authority })));
}

/**
 * Fold the arbiter over a claim set in the order given, exactly as a cache writer
 * does: the current holder is the incumbent, each further claim arrives against it.
 * Returns the admitted id and the displacement set, both order-normalized.
 */
function foldClaimSet(claims: readonly AddressClaim[]): { admittedId: string; displaced: string[] } {
	let holder = claims[0]!;
	const displaced = new Set<string>();
	for (const claim of claims.slice(1)) {
		const verdict = arbitrateAddress(PATH, holder, claim);
		if (verdict.withheldId !== null) displaced.add(verdict.withheldId);
		if (verdict.admittedId !== holder.id) holder = claim;
	}
	return { admittedId: holder.id, displaced: [...displaced].sort() };
}

function claimSets(size: number): AddressClaim[][] {
	return authorityAssignments().flatMap((assignment) =>
		idMultisets(size).map((ids) =>
			ids.map((id): AddressClaim => ({ id, authority: assignment.get(id)! })),
		),
	);
}

describe("arbitrateAddress", () => {
	describe("tier order", () => {
		it("admits the provider-resolved claim over an echoed guess, whichever arrived first", () => {
			const guess: AddressClaim = { id: "a", authority: "requested_echo" };
			const resolved: AddressClaim = { id: "b", authority: "actual_resolved" };

			const arriving = arbitrateAddress(PATH, guess, resolved);
			const incumbent = arbitrateAddress(PATH, resolved, guess);

			expect(arriving.admittedId).toBe("b");
			expect(arriving.outcome).toBe("admit_claimant");
			expect(incumbent.admittedId).toBe("b");
			expect(incumbent.outcome).toBe("admit_incumbent");
			expect(arriving.reason).toBe("path_authority");
			expect(incumbent.reason).toBe("path_authority");
		});

		it("applies the authority tier BEFORE the lowest-id tier", () => {
			// "a" < "b", so a lowest-id-first arbiter would admit "a" here.
			const verdict = arbitrateAddress(
				PATH,
				{ id: "a", authority: "requested_echo" },
				{ id: "b", authority: "actual_resolved" },
			);

			expect(verdict.admittedId).toBe("b");
			expect(verdict.withheldId).toBe("a");
			expect(verdict.reason).toBe("path_authority");
		});

		it("admits the lexicographically lowest stable id when the authority tier ties", () => {
			for (const authority of AUTHORITIES) {
				const verdict = arbitrateAddress(PATH, { id: "f2", authority }, { id: "f1", authority });

				expect(verdict.admittedId).toBe("f1");
				expect(verdict.withheldId).toBe("f2");
				expect(verdict.outcome).toBe("admit_claimant");
				expect(verdict.reason).toBe("lowest_stable_id");
			}
		});

		it("reports no contest when both claims name one stable id", () => {
			const verdict = arbitrateAddress(
				PATH,
				{ id: "f1", authority: "requested_echo" },
				{ id: "f1", authority: "actual_resolved" },
			);

			expect(verdict.outcome).toBe("no_contest");
			expect(verdict.admittedId).toBe("f1");
			expect(verdict.withheldId).toBeNull();
			expect(verdict.reason).toBe("same_stable_id");
			expect(verdict.withheldOwesRemediation).toBe(false);
		});
	});

	describe("remediation eligibility", () => {
		it("marks a withheld echoed guess as owing no provider remediation", () => {
			// The orphan-collapse pair: a bare-name-collapsed orphan against a genuine
			// root-level child. The guess loses in both orders and owes no rename,
			// because its parent chain never reached the bound sync root.
			const guess: AddressClaim = { id: "orphan", authority: "requested_echo" };
			const child: AddressClaim = { id: "child", authority: "actual_resolved" };

			for (const verdict of [
				arbitrateAddress("orphan.md", guess, child),
				arbitrateAddress("orphan.md", child, guess),
			]) {
				expect(verdict.admittedId).toBe("child");
				expect(verdict.withheldId).toBe("orphan");
				expect(verdict.withheldOwesRemediation).toBe(false);
			}
		});

		it("marks a withheld provider-resolved claim as owing a provider remediation", () => {
			const verdict = arbitrateAddress(
				"Test.md",
				{ id: "f1", authority: "actual_resolved" },
				{ id: "f2", authority: "actual_resolved" },
			);

			expect(verdict.admittedId).toBe("f1");
			expect(verdict.withheldId).toBe("f2");
			expect(verdict.withheldOwesRemediation).toBe(true);
		});
	});

	describe("order independence", () => {
		it("names the same admitted id for both argument orders of every claim pair", () => {
			for (const incumbent of allClaims()) {
				for (const claimant of allClaims()) {
					const forward = arbitrateAddress(PATH, incumbent, claimant);
					const reverse = arbitrateAddress(PATH, claimant, incumbent);

					expect(reverse.admittedId).toBe(forward.admittedId);
					expect(reverse.withheldId).toBe(forward.withheldId);
					expect(reverse.reason).toBe(forward.reason);
					expect(reverse.withheldOwesRemediation).toBe(forward.withheldOwesRemediation);
					// Only the seat the winner sat in differs between the two orders.
					expect(reverse.outcome).toBe(
						forward.outcome === "no_contest"
							? "no_contest"
							: forward.outcome === "admit_incumbent" ? "admit_claimant" : "admit_incumbent",
					);
				}
			}
		});

		for (const size of [2, 3]) {
			it(`yields one admitted id and one displacement set over every permutation of a claim set of size ${size}`, () => {
				const sets = claimSets(size);
				expect(sets.length).toBeGreaterThan(0);

				for (const claims of sets) {
					const orders = permutations(claims);
					const expected = foldClaimSet(orders[0]!);
					for (const order of orders) {
						expect({ order: order.map((c) => `${c.id}:${c.authority}`), ...foldClaimSet(order) })
							.toEqual({ order: order.map((c) => `${c.id}:${c.authority}`), ...expected });
					}
				}
			});
		}
	});

	describe("totality", () => {
		it("never throws and always names an admitted id, over the whole claim domain", () => {
			for (const path of ["", "Test.md", "a/b/c.md", "  ", "../x"]) {
				for (const incumbent of allClaims()) {
					for (const claimant of allClaims()) {
						const verdict = arbitrateAddress(path, incumbent, claimant);

						expect(verdict.path).toBe(path);
						expect([incumbent.id, claimant.id]).toContain(verdict.admittedId);
						if (verdict.outcome === "no_contest") {
							expect(verdict.withheldId).toBeNull();
						} else {
							expect(verdict.withheldId).not.toBe(verdict.admittedId);
							expect([incumbent.id, claimant.id]).toContain(verdict.withheldId);
						}
					}
				}
			}
		});

		it("settles two empty-string ids as one identity rather than a contest", () => {
			const verdict = arbitrateAddress("", { id: "", authority: "requested_echo" }, { id: "", authority: "requested_echo" });

			expect(verdict.outcome).toBe("no_contest");
			expect(verdict.admittedId).toBe("");
		});

		it("orders an empty-string id against a non-empty one without throwing", () => {
			const verdict = arbitrateAddress(
				PATH,
				{ id: "a", authority: "actual_resolved" },
				{ id: "", authority: "actual_resolved" },
			);

			expect(verdict.admittedId).toBe("");
			expect(verdict.reason).toBe("lowest_stable_id");
		});
	});

	describe("purity", () => {
		it("mutates neither claim and returns an equal decision for a repeated call", () => {
			const incumbent = Object.freeze<AddressClaim>({ id: "f2", authority: "actual_resolved" });
			const claimant = Object.freeze<AddressClaim>({ id: "f1", authority: "requested_echo" });

			const first = arbitrateAddress(PATH, incumbent, claimant);
			const second = arbitrateAddress(PATH, incumbent, claimant);

			expect(second).toEqual(first);
			expect(incumbent).toEqual({ id: "f2", authority: "actual_resolved" });
			expect(claimant).toEqual({ id: "f1", authority: "requested_echo" });
		});
	});
});
