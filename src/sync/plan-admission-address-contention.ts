import type { AddressDisplacement } from "../fs/caching/claim-set-assignment";
import type { RenameAction, SyncRecord } from "./types";
import { insertConflictSuffix } from "./conflict";

/**
 * The complete current-cycle facts a contention repair is decided from.
 *
 * Nothing here is a prior error, an Admission failure, a database version, a
 * record count or a recovery marker: the decision is a function of this cycle's
 * observed contentions, the committed `SyncRecord` at each contended path, and
 * whether the remote filesystem offers the identity-addressed rename. That is what
 * makes COLD, WARM and HOT produce the same answer for the same facts, and it is
 * why nothing about a contention is persisted — every cycle re-derives it.
 */
export interface AddressContentionFacts {
	/** This cycle's contended addresses, as the filesystem announced them. */
	readonly contentions: readonly AddressDisplacement[];
	/**
	 * The committed `SyncRecord` at each contended path, keyed by path. The record
	 * store is keyed by `remoteIdentityKey` under a UNIQUE `path` index, so at most
	 * one record can stand at an address and therefore at most one claimant can hold
	 * the one at a contended address — which is what makes the keeper a function of
	 * the unordered claim set.
	 */
	readonly records: ReadonlyMap<string, SyncRecord | undefined>;
	/** Whether the remote filesystem can rename a provider object by its stable id. */
	readonly renameByIdentity: boolean;
}

/** What one cycle owes for the contentions it observed. */
export interface AddressContentionRemediation {
	/** At most one `rename_remote` per contended address. No new action kind. */
	readonly actions: readonly RenameAction[];
	/**
	 * Whether the cycle must not commit its checkpoint. Set only when a repair is
	 * actually owed: a contention nothing can be done about — an orphan collapse, or
	 * a backend without the capability — is announced, not blocked, because blocking
	 * would stall the cursor with no action that could ever clear it.
	 */
	readonly checkpointBlocked: boolean;
	/**
	 * The contended addresses this cycle must not resolve to a current remote object.
	 *
	 * The owner's rule is *"sync the object whose id matches the SyncRecord, rename the
	 * one that does not"* — two obligations, not one. The rename is the actions above.
	 * This is the other half: when the claimant the cache seated is NOT the one the
	 * address should sync, the object that should sync it was dropped from the working
	 * view to seat the other, so it is not observable this cycle. Acting on the seated
	 * claimant there would sync the wrong object at the keeper's address and publish a
	 * record naming an object this same plan is moving away.
	 *
	 * The address is therefore unresolved, not empty and not the seated claimant. It
	 * resolves on its own next cycle: the repair vacates it, the keeper stops losing
	 * the contest, and the ordinary rules sync it with no special case at all.
	 *
	 * Independent of `renameByIdentity`: a backend that cannot repair the namespace
	 * still must not sync the wrong object at that address.
	 */
	readonly unresolvedAddresses: ReadonlySet<string>;
}

/** One contended address, and the claimant the owner's rule says it belongs to. */
interface ContendedAddress {
	readonly path: string;
	/**
	 * The claimant the cache's arbiter seated at the address, or `undefined` when this
	 * cycle's facts disagree about who that was.
	 */
	readonly admittedId: string | undefined;
	/** Every claimant of the address, sorted: a set, not an arrival order. */
	readonly claimants: readonly string[];
	/**
	 * The claimant that keeps the plain address — the one this address syncs. Decided
	 * here and nowhere else, so the rename target and the withheld address can never
	 * be settled by two rules that disagree. `undefined` when no seated claimant could
	 * be established, which is itself a reason not to sync the address.
	 */
	readonly keeper: string | undefined;
	/** Whether a provider repair can reach this address. */
	readonly remediable: boolean;
}

/**
 * Turn this cycle's contentions into the provider renames that repair them, and name
 * the addresses that must not be synced until one lands.
 *
 * Pure: the same facts always yield the same actions, in the same order, whatever
 * order the claims arrived in and whatever acquisition temperature produced them.
 * It holds no state, publishes nothing, and returns no disposition or failure
 * reason for anyone to persist.
 */
export function planAddressContentionRemediation(
	facts: AddressContentionFacts,
): AddressContentionRemediation {
	const addresses = contendedAddresses(facts);
	// An address whose seated claimant is already the keeper needs no withholding: the
	// ordinary rules are looking at exactly the object this address syncs, and the
	// repair moves a claimant that was never in the working view.
	const unresolvedAddresses = new Set(
		addresses.filter((address) => address.keeper === undefined || address.keeper !== address.admittedId)
			.map((address) => address.path),
	);
	// An absent capability is a configuration fact, not an error: no rename is
	// planned and the cycle is not blocked, because nothing it could do would
	// clear the condition.
	if (!facts.renameByIdentity) return { actions: [], checkpointBlocked: false, unresolvedAddresses };
	const actions: RenameAction[] = [];
	for (const address of addresses) {
		if (!address.remediable || address.keeper === undefined) continue;
		const renamed = address.claimants.find((id) => id !== address.keeper);
		if (renamed === undefined) continue;
		actions.push({
			action: "rename_remote",
			// The discriminator is the moving object's own identity, so the target is
			// a function of the unordered claim set, is the same address on every
			// retry (which is what makes the rename idempotent), needs no content
			// fetch, and is meaningful for a folder. It can never be mistaken for a
			// conflict PRESERVATION address, which is `.conflict-<64 hex>`: `i` is not
			// a hex digit, so `directConflictCandidateHint` can never parse this.
			path: insertConflictSuffix(address.path, `id-${renamed}`),
			oldPath: address.path,
			providerIdentity: renamed,
		});
	}
	return { actions, checkpointBlocked: actions.length > 0, unresolvedAddresses };
}

/**
 * Every contended address this cycle observed, in one deterministic order, each with
 * the claimant that keeps it and whether a provider repair can reach it.
 *
 * A contention is remediable only when BOTH claims are provider-resolved, which is
 * exactly what `owesRemediation` reports: the arbiter admits `actual_resolved` over
 * `requested_echo`, so a withheld claim can only be provider-resolved when the
 * claim that beat it was too. A `requested_echo` claimant is a guess whose parent
 * chain does not reach the bound sync root — Air Sync's working area does not reach
 * it and nothing there is at risk — so it is left alone, and so is the whole
 * address: when remediability cannot be established, nothing is done to the
 * provider. An address whose facts disagree about who was admitted is treated the
 * same way, and additionally has no established seated claimant, so it cannot be
 * synced either.
 *
 * Non-remediable addresses are still listed. Whether the provider can be repaired
 * and whether this cycle may sync the address are different questions, and folding
 * them together is what let the second one go unasked.
 */
function contendedAddresses(facts: AddressContentionFacts): ContendedAddress[] {
	const claimants = new Map<string, Set<string>>();
	const admitted = new Map<string, Set<string>>();
	const unreachable = new Set<string>();
	for (const contention of facts.contentions) {
		if (!contention.owesRemediation) unreachable.add(contention.path);
		const group = claimants.get(contention.path) ?? new Set<string>();
		group.add(contention.admittedId).add(contention.withheldId);
		claimants.set(contention.path, group);
		const holders = admitted.get(contention.path) ?? new Set<string>();
		admitted.set(contention.path, holders.add(contention.admittedId));
	}
	const addresses: ContendedAddress[] = [];
	for (const [path, group] of claimants) {
		const holders = admitted.get(path);
		const admittedId = holders?.size === 1 ? [...holders][0]! : undefined;
		const sorted = [...group].sort();
		addresses.push({
			path,
			admittedId,
			claimants: sorted,
			keeper: admittedId === undefined
				? undefined : chooseKeeper(sorted, admittedId, facts.records.get(path)),
			remediable: admittedId !== undefined && !unreachable.has(path),
		});
	}
	return addresses.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * Which claimant keeps the plain address — and therefore which one this address syncs.
 *
 * The one holding the committed `SyncRecord` there — so the user's established file
 * keeps its name and the newcomer moves. If neither holds one, it is the claimant
 * the arbiter admitted, which is itself a function of the unordered claim set.
 * `AGENTS.md` permits a decision to depend on a component's current endpoints and
 * its committed `SyncRecord`; that input is legitimate here and refused inside the
 * cache, which holds no sync state and must not acquire any.
 *
 * This is the SOLE decider for a contended address. The cache's arbiter settles who
 * occupies the cache; that is a working-view mechanism and cannot read sync state.
 * When the two answers differ, this one holds and the cycle withholds the address —
 * never both at once, which would sync one claimant and rename it in the same plan.
 */
function chooseKeeper(
	claimants: readonly string[], admittedId: string, record: SyncRecord | undefined,
): string {
	const recorded = record?.remoteIdentityKey;
	if (recorded !== undefined && claimants.includes(recorded)) return recorded;
	return admittedId;
}
