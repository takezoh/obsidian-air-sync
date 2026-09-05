import type { IdentityEvidence, MixedEntity, PathObservation } from "./types";
import type { BatchObservation } from "./sync-cycle-planning";

/** Component membership is established before any action exists. */
export interface IdentityComponent {
	readonly paths: ReadonlySet<string>;
	readonly entries: readonly MixedEntity[];
	readonly evidence: readonly IdentityEvidence[];
	readonly observations: readonly PathObservation[];
}

export function buildFactComponents(snapshot: BatchObservation): IdentityComponent[] {
	const graph = new PathGraph();
	const evidence = snapshot.evidence.map((item) => item.evidence);
	const entryPaths = snapshot.entries.map((entry) => [
		entry.path, ...[entry.local?.path, entry.remote?.path, entry.prevSync?.path]
			.filter((path): path is string => path !== undefined),
	]);
	const paths = [...new Set([
		...entryPaths.flat(), ...evidence.flatMap(evidencePaths),
		...snapshot.observations.flatMap(observationPaths),
	])].sort();
	for (const group of entryPaths) graph.connect(group);
	for (const item of evidence) {
		const group = evidencePaths(item);
		graph.connect(item.kind === "rename" && item.isFolder
			? [...group, ...folderDescendantPaths(item.oldPath, item.newPath, paths)] : group);
	}
	for (const item of snapshot.observations) {
		const group = observationPaths(item);
		graph.connect(item.kind === "alias" && item.entity.isDirectory
			? [...group, ...folderDescendantPaths(item.requestedPath, item.resolvedPath, paths)] : group);
	}
	// Committed keys participate in publication footprints, but do not assert
	// that their historical identity still occupies that address.
	const identityPaths = new Map<string, string[]>();
	for (const entry of snapshot.entries) {
		for (const occurrence of [
			{ path: entry.prevSync?.path, identity: entry.prevSync?.remoteIdentityKey },
			{ path: entry.remote?.path, identity: entry.remote?.identityKey },
		]) {
			if (!occurrence.path || !occurrence.identity) continue;
			const group = identityPaths.get(occurrence.identity) ?? [];
			group.push(occurrence.path);
			identityPaths.set(occurrence.identity, group);
		}
	}
	for (const group of identityPaths.values()) graph.connect(group);
	const grouped = new Map<string, {
		paths: Set<string>; entries: MixedEntity[]; evidence: IdentityEvidence[];
		observations: PathObservation[];
	}>();
	for (const path of graph.paths()) {
		const root = graph.root(path);
		const component = grouped.get(root) ?? { paths: new Set(), entries: [], evidence: [], observations: [] };
		component.paths.add(path);
		grouped.set(root, component);
	}
	for (const entry of snapshot.entries) grouped.get(graph.root(entry.path))!.entries.push(entry);
	for (const item of evidence) {
		const first = evidencePaths(item)[0];
		if (first) grouped.get(graph.root(first))!.evidence.push(item);
	}
	for (const item of snapshot.observations) grouped.get(graph.root(item.requestedPath))!.observations.push(item);
	// WARM's local scan also contains unrelated, unchanged addresses for which
	// no remote facts were acquired. Those are not attempted components. Keep
	// every observed entry (including no-change entries) and every retained claim.
	return [...grouped.values()].filter((component) => component.entries.length > 0 ||
		component.evidence.length > 0 || component.observations.some((item) =>
			item.kind === "unknown" || item.kind === "present_unresolved"));
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
