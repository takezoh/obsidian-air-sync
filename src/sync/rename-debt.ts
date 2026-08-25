import { projectRenameScope } from "./scope-projection";
import type { RenameDebt } from "./state";
import type {
	IdentityEvidence,
	RenameEvidence,
	ScopeDisposition,
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

/** Fill only unknown endpoints; current explicit policy/mobile classifications win. */
export function applyRenameDebtScope(
	projection: ScopeProjection,
	debts: readonly RenameDebt[],
): ScopeProjection {
	const candidates = new Map<string, ScopeDisposition>();
	const conflicts = new Set<string>();
	for (const debt of debts) {
		rememberDisposition(candidates, conflicts, debt.oldPath, debt.oldDisposition);
		rememberDisposition(candidates, conflicts, debt.newPath, debt.newDisposition);
	}
	const byEndpoint = new Map(projection.byEndpoint);
	for (const [path, disposition] of candidates) {
		if (!conflicts.has(path) && byEndpoint.get(path) === "unknown") {
			byEndpoint.set(path, disposition);
		}
	}
	return { byEndpoint };
}

export function collectLocalRenameDebts(
	namespace: string,
	evidence: readonly IdentityEvidence[],
	projection: ScopeProjection,
): RenameDebt[] {
	return evidence.flatMap((item): RenameDebt[] => {
		if (item.kind !== "rename" || item.side !== "local") return [];
		const rule = projectRenameScope(item, projection);
		if (rule.consequence === "none") return [];
		return [{
			namespace,
			side: item.side,
			oldPath: item.oldPath,
			newPath: item.newPath,
			isFolder: item.isFolder,
			oldDisposition: rule.oldDisposition,
			newDisposition: rule.newDisposition,
		}];
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

function renameEvidenceKey(evidence: RenameEvidence): string {
	return `${evidence.side}\0${evidence.oldPath}\0${evidence.newPath}\0${evidence.isFolder}`;
}

function rememberDisposition(
	candidates: Map<string, ScopeDisposition>,
	conflicts: Set<string>,
	path: string,
	disposition: ScopeDisposition,
): void {
	const current = candidates.get(path);
	if (current !== undefined && current !== disposition) conflicts.add(path);
	else candidates.set(path, disposition);
}
