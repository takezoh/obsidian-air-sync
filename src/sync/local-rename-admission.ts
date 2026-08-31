import { projectRenameScope } from "./scope-projection";
import type { AdmissionComponent } from "./plan-admission-graph";
import { renameEvidenceKey } from "./identity-evidence";
import type { LocalRenameEvidence, ScopeProjection } from "./types";

export interface LocalRenameLifecycle {
	persistBeforeExecution: readonly LocalRenameEvidence[];
	releaseAfterSafeCheckpoint: readonly LocalRenameEvidence[];
}

export function classifyNonBindingLocalRenames(
	components: readonly AdmissionComponent[],
	baselinePaths: ReadonlySet<string>,
	scope: ScopeProjection,
): ReadonlySet<string> {
	const nonBinding = new Set<string>();
	for (const component of components) {
		const candidates = component.evidence.filter((item): item is LocalRenameEvidence =>
			item.kind === "rename" && item.side === "local");
		if (candidates.length === 0 || !isNonBindingComponent(
			component, candidates, baselinePaths, scope,
		)) continue;
		for (const candidate of candidates) nonBinding.add(renameEvidenceKey(candidate));
	}
	return nonBinding;
}

export function buildLocalRenameLifecycle(
	persistBeforeExecution: readonly LocalRenameEvidence[],
	releaseAfterSafeCheckpoint: readonly LocalRenameEvidence[],
): LocalRenameLifecycle {
	return {
		persistBeforeExecution: Object.freeze([...persistBeforeExecution]),
		releaseAfterSafeCheckpoint: Object.freeze([...releaseAfterSafeCheckpoint]),
	};
}

function isNonBindingComponent(
	component: AdmissionComponent,
	candidates: readonly LocalRenameEvidence[],
	baselinePaths: ReadonlySet<string>,
	scope: ScopeProjection,
): boolean {
	if (component.evidence.length !== candidates.length) return false;
	if (component.actions.length === 0 && candidates.every((candidate) =>
		projectRenameScope(candidate, scope).consequence === "none")) return true;
	if (candidates.some((candidate) => candidate.isFolder)) return false;
	if ([...component.paths].some((path) => baselinePaths.has(path) ||
		scope.byEndpoint.get(path) !== "included")) return false;

	const oldPaths = new Set(candidates.map((candidate) => candidate.oldPath));
	const newPaths = new Set(candidates.map((candidate) => candidate.newPath));
	const terminalPaths = new Set([...newPaths].filter((path) => !oldPaths.has(path)));
	if (terminalPaths.size === 0 || component.actions.length !== terminalPaths.size ||
		component.actions.some((action) => action.action !== "push" || action.baseline !== undefined ||
			!terminalPaths.has(action.path))) return false;

	for (const path of new Set([...oldPaths, ...newPaths])) {
		if (!hasOnlyObservation(component, "remote", path, "absent")) return false;
		const expectedLocal = terminalPaths.has(path) ? "exact" : "absent";
		if (!hasOnlyObservation(component, "local", path, expectedLocal)) return false;
	}
	return true;
}

function hasOnlyObservation(
	component: AdmissionComponent,
	side: "local" | "remote",
	path: string,
	kind: "absent" | "exact",
): boolean {
	const observations = component.observations.filter((item) =>
		item.side === side && item.requestedPath === path);
	return observations.length > 0 && observations.every((item) => item.kind === kind);
}
