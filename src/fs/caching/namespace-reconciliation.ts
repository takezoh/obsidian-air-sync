import type { AddressDisplacement } from "./claim-set-assignment";
import type { RemoteDelta } from "./remote-fs";
import { insertConflictSuffix } from "../../utils/path";

/**
 * The sync engine's per-call inputs to namespace reconciliation.
 *
 * The remote filesystem owns the path↔identity bijection and the provider namespace
 * repair, but two facts it must not own are supplied by the caller: whether an address
 * is inside the user's sync scope, and which claimant keeps the plain address (the
 * object holding a committed `SyncRecord`, which only the sync engine can read). Both
 * are arguments, never stored — the filesystem stays stateless.
 */
export interface NamespaceRepairPolicy {
	/** Whether the contended address is inside the user's sync scope. */
	readonly isInScope: (path: string) => boolean;
	/** The keeper claimant id, or undefined to leave the choice to the arbiter. */
	readonly keeper: (path: string, claimantIds: readonly string[]) => Promise<string | undefined>;
}

/** One backend rename the filesystem must perform to settle a contention. */
export interface NamespaceRepair {
	/** The contended derived address. */
	readonly path: string;
	/** The stable id of the claimant that must move. */
	readonly identityKey: string;
	/** The deterministic conflict address it moves to. */
	readonly target: string;
}

/** One repair the provider refused or failed. */
export interface NamespaceRepairFailure {
	readonly path: string;
	readonly identityKey: string;
	readonly target: string;
	readonly message: string;
	/**
	 * The provider's own error, carried so the sync engine can classify it (retry,
	 * target-changed, permission) and run its error policy instead of looping.
	 */
	readonly error: unknown;
}

/**
 * What one reconciliation pass did.
 *
 * `settled` — no contention, or nothing actionable, so the cycle proceeds.
 * `changed` — the provider namespace was mutated and the working view must be
 *   discarded; the sync engine retries the cycle.
 * `failed` — at least one repair could not be performed; the cycle must not commit
 *   its cursor and is retried. No collision record is persisted.
 */
export type NamespaceReconciliation =
	/**
	 * The namespace is settled. `delta` is the working delta reconciliation built while
	 * looking for contentions, so change collection reads this same view instead of
	 * replaying the cursor again (which would see no changes). Null on a fresh sync;
	 * absent when the filesystem did not build one (no capability).
	 */
	| { readonly kind: "settled"; readonly delta?: RemoteDelta | null }
	| { readonly kind: "changed" }
	| { readonly kind: "failed"; readonly failures: readonly NamespaceRepairFailure[] };

/**
 * The reconciliation capability the remote filesystem offers, in the shape
 * {@link IdentityAddressedRename} and `checkpoint` already use. Optional: a filesystem
 * whose addresses are the provider's own keys can never produce a contention and
 * simply does not offer it.
 */
export interface NamespaceReconciliationCapability {
	reconcileNamespace(policy: NamespaceRepairPolicy): Promise<NamespaceReconciliation>;
}

/**
 * Which claimant of a contended address must move, given the keeper. The keeper is
 * the engine's answer or, when absent, the arbiter's admitted claimant; the other
 * claimant is renamed to the conflict address derived from its own stable id.
 *
 * Pure: a function of the unordered claim pair plus the keeper, so the same facts
 * always yield the same repair and a retry targets the same address (idempotent).
 */
export function namespaceRepairFor(fact: AddressDisplacement, keeper: string | undefined): NamespaceRepair {
	const keep = keeper ?? fact.admittedId;
	const identityKey = keep === fact.admittedId ? fact.withheldId : fact.admittedId;
	return { path: fact.path, identityKey, target: insertConflictSuffix(fact.path, `id-${identityKey}`) };
}

/**
 * Group the contentions of one working view by contended address, keeping only the
 * addresses that are wholly repairable.
 *
 * An address is repairable only when EVERY claimant of it is provider-resolved
 * (`owesRemediation`) and it is in scope. A group with even one non-repairable claimant
 * is dropped whole: renaming a provider-resolved claimant there would mutate the
 * provider from an incomplete topology, and the requested_echo claimant's spelling did
 * not come from the provider. Path-wide gating is the rule; per-fact eligibility is
 * exactly the bug it prevents.
 */
export function groupRepairableContentions(
	contentions: readonly AddressDisplacement[],
	policy: NamespaceRepairPolicy,
): Map<string, AddressDisplacement[]> {
	const grouped = new Map<string, AddressDisplacement[]>();
	for (const fact of contentions) {
		if (!policy.isInScope(fact.path)) continue;
		const group = grouped.get(fact.path);
		if (group) group.push(fact);
		else grouped.set(fact.path, [fact]);
	}
	const repairable = new Map<string, AddressDisplacement[]>();
	for (const [path, facts] of grouped) {
		if (facts.every((fact) => fact.owesRemediation)) repairable.set(path, facts);
	}
	return repairable;
}
