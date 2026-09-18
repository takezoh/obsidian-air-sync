import type { PathAuthority } from "../types";

/**
 * One claim on a *derived* cache address — an address the cache composed itself
 * from a provider name plus a parent chain, rather than one the provider keys on.
 *
 * A claim is only ever `(stable id, how its spelling was produced)`. Nothing else
 * is available here on purpose: arrival order, checkpoint incumbency, database
 * version, record count, prior errors and local sync state are all excluded, so
 * the same complete facts always produce the same decision (AGENTS.md's
 * COLD/WARM/HOT sameness rule).
 */
export interface AddressClaim {
	/** Stable backend id of the claiming object. */
	readonly id: string;
	/** Whether the claim's spelling came from the provider or from a request echo. */
	readonly authority: PathAuthority;
}

/** The tier that settled a real contest between two distinct stable ids. */
export type AddressContestReason =
	/** Tier 1: `actual_resolved` is admitted over `requested_echo`. */
	| "path_authority"
	/** Tier 2: the lexicographically smallest stable id is admitted. */
	| "lowest_stable_id";

/** The tier that settled the arbitration, including the non-contest. */
export type AddressArbitrationReason = "same_stable_id" | AddressContestReason;

interface ArbitratedAddress {
	/** The contended cache address, echoed back so a caller can key the fact by it. */
	readonly path: string;
	/** The stable id that holds `path`. */
	readonly admittedId: string;
}

/** Both claims name one stable id: an ordinary update, not a contest. */
export interface UncontestedAddress extends ArbitratedAddress {
	readonly outcome: "no_contest";
	readonly withheldId: null;
	readonly reason: "same_stable_id";
	readonly withheldOwesRemediation: false;
}

/** Two distinct stable ids claimed one address; one is admitted and the other is named. */
export interface ContestedAddress extends ArbitratedAddress {
	readonly outcome: "admit_incumbent" | "admit_claimant";
	/** The stable id that does not hold `path`. */
	readonly withheldId: string;
	readonly reason: AddressContestReason;
	/**
	 * Whether the withheld claimant is eligible for a provider-side repair.
	 *
	 * A withheld `requested_echo` claim is not: its spelling is a guess whose
	 * parent chain does not reach the bound sync root, so it addresses an object
	 * outside the working area and there is nothing there to rename. This is what
	 * lets a caller tell an out-of-root guess apart from a genuine duplicate.
	 */
	readonly withheldOwesRemediation: boolean;
}

/** The decision itself. Total: exactly one claim holds the address, and the other is named. */
export type AddressArbitration = UncontestedAddress | ContestedAddress;

/**
 * Decide which of two claims holds a contended derived cache address.
 *
 * Pure, stateless and total — it holds no client, no logger and no backend type,
 * and it never throws for any input, including empty-string ids and identical
 * authorities. `arbitrateAddress(p, a, b)` and `arbitrateAddress(p, b, a)` name
 * the same admitted id, so order-independence comes from the rule rather than
 * from the order in which a caller happened to observe the claims.
 *
 * Tiers, in order:
 *  1. equal stable ids ⇒ `no_contest` (the arriving claim is an ordinary update);
 *  2. `actual_resolved` is admitted over `requested_echo`;
 *  3. otherwise the lexicographically smallest stable id is admitted.
 *
 * The tie-break's arbitrariness is acceptable because both objects survive and
 * both sync; the arbiter decides only *which address each one ends up at*.
 */
export function arbitrateAddress(
	path: string,
	incumbent: AddressClaim,
	claimant: AddressClaim,
): AddressArbitration {
	if (incumbent.id === claimant.id) {
		return {
			path,
			outcome: "no_contest",
			admittedId: incumbent.id,
			withheldId: null,
			reason: "same_stable_id",
			withheldOwesRemediation: false,
		};
	}

	const byAuthority = authorityRank(incumbent.authority) - authorityRank(claimant.authority);
	if (byAuthority !== 0) {
		return settle(path, incumbent, claimant, byAuthority < 0, "path_authority");
	}
	return settle(path, incumbent, claimant, incumbent.id < claimant.id, "lowest_stable_id");
}

/** Lower rank wins. Provider-resolved spelling outranks an addressing echo. */
function authorityRank(authority: PathAuthority): number {
	return authority === "actual_resolved" ? 0 : 1;
}

function settle(
	path: string,
	incumbent: AddressClaim,
	claimant: AddressClaim,
	incumbentWins: boolean,
	reason: AddressContestReason,
): ContestedAddress {
	const admitted = incumbentWins ? incumbent : claimant;
	const withheld = incumbentWins ? claimant : incumbent;
	return {
		path,
		outcome: incumbentWins ? "admit_incumbent" : "admit_claimant",
		admittedId: admitted.id,
		withheldId: withheld.id,
		reason,
		withheldOwesRemediation: withheld.authority === "actual_resolved",
	};
}
