import type { TrackerSnapshot } from "./local-tracker";
import type { IdentityEvidence, MixedEntity, PathObservation } from "./types";
import { collectLocalRenameEvidence } from "./identity-evidence";

interface HotAcquisitionFacts {
	readonly entries: readonly MixedEntity[];
	readonly observations: readonly PathObservation[];
	readonly identityEvidence: readonly IdentityEvidence[];
}

function identityEdges(
	hot: HotAcquisitionFacts,
	changes: TrackerSnapshot,
): Array<readonly [string, string]> {
	const edges: Array<readonly [string, string]> = [];
	for (const observation of hot.observations) {
		if (observation.kind === "alias") {
			edges.push([observation.requestedPath, observation.resolvedPath]);
		}
	}
	for (const evidence of [
		...hot.identityEvidence,
		...collectLocalRenameEvidence(changes),
	]) {
		if (evidence.kind === "rename") edges.push([evidence.oldPath, evidence.newPath]);
		else if (evidence.kind === "alias") edges.push([evidence.requestedPath, evidence.resolvedPath]);
		else {
			const paths = [...new Set(evidence.occurrences.map((occurrence) => occurrence.path))];
			for (const path of paths.slice(1)) edges.push([paths[0]!, path]);
		}
	}
	return edges;
}

function connectedPaths(start: string, edges: readonly (readonly [string, string])[]): Set<string> {
	const component = new Set([start]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const [left, right] of edges) {
			if (!component.has(left) && !component.has(right)) continue;
			if (!component.has(left)) { component.add(left); grew = true; }
			if (!component.has(right)) { component.add(right); grew = true; }
		}
	}
	return component;
}

/** Whether a partial HOT component needs the bounded WARM surface acquisition. */
export function needsWarmComponentAcquisition(
	hot: HotAcquisitionFacts,
	changes: TrackerSnapshot,
): boolean {
	const edges = identityEdges(hot, changes);
	const visited = new Set<string>();
	return hot.entries.some((entry) => {
		if (visited.has(entry.path)) return false;
		const component = connectedPaths(entry.path, edges);
		for (const path of component) visited.add(path);
		const componentEntries = hot.entries.filter((candidate) => component.has(candidate.path));
		const hasCurrentOccurrence = componentEntries.some((candidate) => candidate.local || candidate.remote) ||
			hot.observations.some((observation) => component.has(observation.requestedPath) &&
				(observation.kind === "alias" || observation.kind === "present_unresolved"));
		// A locally dirty, unbaselined address can be an endpoint of an abandoned
		// folder relation even when address-local stat sees neither side. WARM breadth
		// is required to rediscover its descendants. This is also conservative for a
		// transient create/delete: it spends one local listing rather than treating a
		// partial HOT view as complete.
		const hasDirtyAddress = componentEntries.some((candidate) => changes.dirtyPaths.has(candidate.path));
		return (hasCurrentOccurrence || hasDirtyAddress) &&
			!componentEntries.some((candidate) => candidate.prevSync);
	});
}
