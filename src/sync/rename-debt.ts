import { projectRenameScope } from "./scope-projection";
import { renameEvidenceKey } from "./identity-evidence";
import type { RenameDebt } from "./state";
import type {
	IdentityEvidence,
	LocalRenameEvidence,
	RenameEvidence,
	ScopeProjection,
} from "./types";

export function mergeRenameDebtEvidence(
	evidence: readonly IdentityEvidence[],
	debts: readonly RenameDebt[],
): IdentityEvidence[] {
	return mergeIdentityEvidence(evidence, debts.map(renameDebtEvidence));
}

export function mergeIdentityEvidence(
	...collections: ReadonlyArray<readonly IdentityEvidence[]>
): IdentityEvidence[] {
	const merged = new Map<string, IdentityEvidence>();
	for (const item of collections.flat()) {
		merged.set(JSON.stringify(item), item);
	}
	return [...merged.values()];
}

/** Mechanical v6 serialization for membership already selected by Admission. */
export function serializeLocalRenameDebts(
	namespace: string,
	evidence: readonly LocalRenameEvidence[],
	projection: ScopeProjection,
): RenameDebt[] {
	return evidence.map((item): RenameDebt => {
		const rule = projectRenameScope(item, projection);
		return {
			namespace,
			side: item.side,
			oldPath: item.oldPath,
			newPath: item.newPath,
			isFolder: item.isFolder,
			oldDisposition: rule.oldDisposition,
			newDisposition: rule.newDisposition,
		};
	});
}

/** Select namespace-local debts whose exact evidence membership Admission released. */
export function renameDebtsBoundToEvidence(
	debts: readonly RenameDebt[],
	releasedEvidence: readonly IdentityEvidence[],
	namespace: string,
): RenameDebt[] {
	const released = new Set(releasedEvidence.flatMap((item) =>
		item.kind === "rename" ? [renameEvidenceKey(item)] : []));
	return debts.filter((debt) => debt.namespace === namespace &&
		released.has(renameEvidenceKey(renameDebtEvidence(debt))));
}

/** Retain evidence not included in Admission's mechanically releasable membership. */
export function unreleasedIdentityEvidence(
	evidence: readonly IdentityEvidence[],
	releasedEvidence: readonly IdentityEvidence[],
): IdentityEvidence[] {
	const released = new Set(releasedEvidence);
	const releasedRenames = new Set(releasedEvidence.flatMap((item) =>
		item.kind === "rename" ? [renameEvidenceKey(item)] : []));
	return evidence.filter((item) => item.kind === "rename"
		? !releasedRenames.has(renameEvidenceKey(item))
		: !released.has(item));
}

export function renameDebtEvidence(debt: RenameDebt): RenameEvidence {
	return {
		kind: "rename",
		side: debt.side,
		oldPath: debt.oldPath,
		newPath: debt.newPath,
		isFolder: debt.isFolder,
		authority: "reported",
	};
}
