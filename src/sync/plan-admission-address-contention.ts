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
}

/** One contended address a provider repair can actually reach. */
interface RemediableAddress {
	readonly path: string;
	/** The claimant the arbiter admitted — the fallback keeper. */
	readonly admittedId: string;
	/** Every claimant of the address, sorted: a set, not an arrival order. */
	readonly claimants: readonly string[];
}

/**
 * Turn this cycle's contentions into the provider renames that repair them.
 *
 * Pure: the same facts always yield the same actions, in the same order, whatever
 * order the claims arrived in and whatever acquisition temperature produced them.
 * It holds no state, publishes nothing, and returns no disposition or failure
 * reason for anyone to persist.
 */
export function planAddressContentionRemediation(
	facts: AddressContentionFacts,
): AddressContentionRemediation {
	// An absent capability is a configuration fact, not an error: no rename is
	// planned and the cycle is not blocked, because nothing it could do would
	// clear the condition.
	if (!facts.renameByIdentity) return { actions: [], checkpointBlocked: false };
	const actions: RenameAction[] = [];
	for (const address of remediableAddresses(facts.contentions)) {
		const keeper = chooseKeeper(address, facts.records.get(address.path));
		const renamed = address.claimants.find((id) => id !== keeper);
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
	return { actions, checkpointBlocked: actions.length > 0 };
}

/**
 * The contended addresses a provider repair can reach, in one deterministic order.
 *
 * A contention is remediable only when BOTH claims are provider-resolved, which is
 * exactly what `owesRemediation` reports: the arbiter admits `actual_resolved` over
 * `requested_echo`, so a withheld claim can only be provider-resolved when the
 * claim that beat it was too. A `requested_echo` claimant is a guess whose parent
 * chain does not reach the bound sync root — Air Sync's working area does not reach
 * it and nothing there is at risk — so it is left alone, and so is the whole
 * address: when remediability cannot be established, nothing is done to the
 * provider. An address whose facts disagree about who was admitted is treated the
 * same way.
 */
function remediableAddresses(
	contentions: readonly AddressDisplacement[],
): RemediableAddress[] {
	const claimants = new Map<string, Set<string>>();
	const admitted = new Map<string, Set<string>>();
	const unreachable = new Set<string>();
	for (const contention of contentions) {
		if (!contention.owesRemediation) {
			unreachable.add(contention.path);
			continue;
		}
		const group = claimants.get(contention.path) ?? new Set<string>();
		group.add(contention.admittedId).add(contention.withheldId);
		claimants.set(contention.path, group);
		const holders = admitted.get(contention.path) ?? new Set<string>();
		admitted.set(contention.path, holders.add(contention.admittedId));
	}
	const remediable: RemediableAddress[] = [];
	for (const [path, group] of claimants) {
		const holders = admitted.get(path);
		if (unreachable.has(path) || holders?.size !== 1) continue;
		remediable.push({ path, admittedId: [...holders][0]!, claimants: [...group].sort() });
	}
	return remediable.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * Which claimant keeps the plain address.
 *
 * The one holding the committed `SyncRecord` there — so the user's established file
 * keeps its name and the newcomer moves. If neither holds one, it is the claimant
 * the arbiter admitted, which is itself a function of the unordered claim set.
 * `AGENTS.md` permits a decision to depend on a component's current endpoints and
 * its committed `SyncRecord`; that input is legitimate here and refused inside the
 * cache, which holds no sync state and must not acquire any.
 */
function chooseKeeper(address: RemediableAddress, record: SyncRecord | undefined): string {
	const recorded = record?.remoteIdentityKey;
	if (recorded !== undefined && address.claimants.includes(recorded)) return recorded;
	return address.admittedId;
}
