import type { ExecutionResult } from "./execution-result";
import type { DeferredComponent } from "./plan-admission";
import { projectRenameScope } from "./scope-projection";
import type { RenameDebt } from "./state";
import type {
	IdentityEvidence,
	RenameEvidence,
	ScopeDisposition,
	ScopeProjection,
	PathObservation,
	SyncAction,
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

/** Debts may be removed only after a clean checkpoint and proven resolution/projection. */
export function resolvedRenameDebts(
	debts: readonly RenameDebt[],
	result: ExecutionResult,
	projection: ScopeProjection,
	observations: readonly PathObservation[] = [],
): RenameDebt[] {
	return debts.filter((debt) => {
		const edge = renameDebtEvidence(debt);
		return renameEvidenceResolved(edge, result, projection, observations);
	});
}

/** Keep reported edges until connected work succeeds, converges, or is a scope no-op. */
export function unresolvedRenameEvidence(
	evidence: readonly IdentityEvidence[],
	result: ExecutionResult,
	projection: ScopeProjection,
	observations: readonly PathObservation[] = [],
): IdentityEvidence[] {
	return evidence.filter((item) => item.kind !== "rename" ||
		!renameEvidenceResolved(item, result, projection, observations));
}

function renameEvidenceResolved(
	edge: RenameEvidence,
	result: ExecutionResult,
	projection: ScopeProjection,
	observations: readonly PathObservation[],
): boolean {
	if (result.deferred.some((component) => componentContainsRename(component, edge))) return false;
	if (result.failed.some(({ action }) => actionTouchesRename(action, edge))) return false;
	if (result.blocked.some(({ action }) => actionTouchesRename(action, edge))) return false;
	if (result.succeeded.some(({ action }) => actionTouchesRename(action, edge))) return true;
	if (resolvedAtBothSides(edge, observations)) return true;
	return projectRenameScope(edge, projection).consequence === "none";
}

function resolvedAtBothSides(
	edge: RenameEvidence,
	observations: readonly PathObservation[],
): boolean {
	return (["local", "remote"] as const).every((side) => {
		const oldObservation = observations.find((item) =>
			item.side === side && item.requestedPath === edge.oldPath);
		const newObservation = observations.find((item) =>
			item.side === side && item.requestedPath === edge.newPath);
		const oldResolved = oldObservation?.kind === "absent" ||
			(oldObservation?.kind === "alias" && oldObservation.resolvedPath === edge.newPath);
		const newResolved = newObservation?.kind === "exact" ||
			(newObservation?.kind === "alias" && newObservation.resolvedPath === edge.newPath);
		return oldResolved && newResolved;
	});
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

function componentContainsRename(component: DeferredComponent, edge: RenameEvidence): boolean {
	return component.evidence.some((item) => item.kind === "rename" &&
		item.side === edge.side && item.oldPath === edge.oldPath && item.newPath === edge.newPath &&
		item.isFolder === edge.isFolder);
}

function actionTouchesRename(action: SyncAction, edge: RenameEvidence): boolean {
	if (action.path === edge.oldPath || action.path === edge.newPath) return true;
	if ((action.action === "rename_local" || action.action === "rename_remote") &&
		(action.oldPath === edge.oldPath || action.oldPath === edge.newPath)) return true;
	return action.action === "rename_local" || action.action === "rename_remote"
		? action.descendants?.some((pair) =>
			pair.oldPath === edge.oldPath || pair.oldPath === edge.newPath ||
			pair.newPath === edge.oldPath || pair.newPath === edge.newPath) === true
		: false;
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
