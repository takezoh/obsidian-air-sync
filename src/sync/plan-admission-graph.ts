import type { IdentityEvidence, PathObservation, ScopeProjection, SyncAction } from "./types";

export interface AdmissionComponent {
	paths: Set<string>;
	actions: SyncAction[];
	evidence: IdentityEvidence[];
	observations: PathObservation[];
}

export function buildAdmissionComponents(
	plan: { readonly actions: readonly SyncAction[] },
	identityEvidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[],
	scope: ScopeProjection,
): AdmissionComponent[] {
	const graph = new PathGraph();
	const actionPathSets = plan.actions.map(actionPaths);
	const evidencePathSets = identityEvidence.map(evidencePaths);
	const observationPathSets = observations.map(observationPaths);
	const knownPaths = new Set([
		...actionPathSets.flat(), ...evidencePathSets.flat(), ...observationPathSets.flat(),
		...scope.byEndpoint.keys(),
	]);
	const sortedKnownPaths = [...knownPaths].sort();
	for (const paths of actionPathSets) graph.connect(paths);
	for (const [index, evidence] of identityEvidence.entries()) {
		const paths = evidencePathSets[index]!;
		graph.connect(evidence.kind === "rename" && evidence.isFolder
			? [...paths, ...folderDescendantPaths(evidence.oldPath, evidence.newPath, sortedKnownPaths)]
			: paths);
	}
	for (const paths of observationPathSets) graph.connect(paths);

	const byRoot = new Map<string, AdmissionComponent>();
	for (const path of graph.paths()) {
		const root = graph.root(path);
		const component = byRoot.get(root) ?? emptyComponent();
		component.paths.add(path);
		byRoot.set(root, component);
	}
	for (const action of plan.actions) componentFor(byRoot, graph, actionPaths(action)).actions.push(action);
	for (const evidence of identityEvidence) {
		componentFor(byRoot, graph, evidencePaths(evidence)).evidence.push(evidence);
	}
	for (const observation of observations) {
		componentFor(byRoot, graph, observationPaths(observation)).observations.push(observation);
	}
	return [...byRoot.values()].filter((component) =>
		component.actions.length > 0 || component.evidence.length > 0 ||
		component.observations.some((observation) =>
			observation.kind === "present_unresolved" || observation.kind === "unknown"));
}

function folderDescendantPaths(
	oldPath: string,
	newPath: string,
	sortedKnownPaths: readonly string[],
): string[] {
	return [
		...pathsWithPrefix(sortedKnownPaths, `${oldPath}/`),
		...pathsWithPrefix(sortedKnownPaths, `${newPath}/`),
	];
}

function pathsWithPrefix(sortedPaths: readonly string[], prefix: string): string[] {
	let low = 0;
	let high = sortedPaths.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (sortedPaths[middle]! < prefix) low = middle + 1;
		else high = middle;
	}
	const matches: string[] = [];
	for (let index = low; index < sortedPaths.length; index++) {
		const path = sortedPaths[index]!;
		if (!path.startsWith(prefix)) break;
		matches.push(path);
	}
	return matches;
}

function actionPaths(action: SyncAction): string[] {
	if (action.action !== "rename_local" && action.action !== "rename_remote") return [action.path];
	return [action.oldPath, action.path, ...(action.descendants?.flatMap((pair) => [pair.oldPath, pair.newPath]) ?? [])];
}

function evidencePaths(evidence: IdentityEvidence): string[] {
	if (evidence.kind === "rename") return [evidence.oldPath, evidence.newPath];
	if (evidence.kind === "alias") return [evidence.requestedPath, evidence.resolvedPath];
	return evidence.occurrences.map((occurrence) => occurrence.path);
}

function observationPaths(observation: PathObservation): string[] {
	if (observation.kind === "alias") return [observation.requestedPath, observation.resolvedPath];
	if (observation.kind === "present_unresolved") {
		return [observation.requestedPath, observation.returnedPath];
	}
	return [observation.requestedPath];
}

function emptyComponent(): AdmissionComponent {
	return { paths: new Set(), actions: [], evidence: [], observations: [] };
}

function componentFor(
	components: Map<string, AdmissionComponent>,
	graph: PathGraph,
	paths: readonly string[],
): AdmissionComponent {
	return components.get(graph.root(paths[0]!))!;
}

class PathGraph {
	private readonly parent = new Map<string, string>();

	connect(paths: readonly string[]): void {
		if (paths.length === 0) return;
		for (const path of paths) this.add(path);
		for (const path of paths.slice(1)) this.union(paths[0]!, path);
	}

	paths(): Iterable<string> {
		return this.parent.keys();
	}

	root(path: string): string {
		const parent = this.parent.get(path);
		if (!parent || parent === path) return path;
		const root = this.root(parent);
		this.parent.set(path, root);
		return root;
	}

	private add(path: string): void {
		if (!this.parent.has(path)) this.parent.set(path, path);
	}

	private union(left: string, right: string): void {
		const leftRoot = this.root(left);
		const rightRoot = this.root(right);
		if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
	}
}
