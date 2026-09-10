import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import { AsyncPool } from "../queue/async-queue";
import { sha256 } from "../utils/hash";
import { exactEntity, observePath, replaceObservation } from "./path-observation";
import type { IdentityEvidence, MixedEntity, PathObservation, SyncSide } from "./types";

/** Capture every independently addressable file occurrence joined by a current alias fact. */
export async function captureAliasCollisionContents(
	entries: MixedEntity[],
	observations: PathObservation[],
	identityEvidence: readonly IdentityEvidence[],
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<void> {
	const components = potentialCollisionComponents(observations, identityEvidence);
	if (components.length === 0) return;
	const collisionPaths = new Set(components.flatMap((component) => [...component]));
	const occurrences = new Map<string, { side: SyncSide; path: string; fs: IFileSystem }>();
	const add = (side: SyncSide, entity: FileEntity | undefined) => {
		if (!entity || entity.isDirectory || !collisionPaths.has(entity.path)) return;
		occurrences.set(`${side}\0${entity.path}`, {
			side, path: entity.path, fs: side === "local" ? localFs : remoteFs,
		});
	};
	for (const entry of entries) {
		add("local", entry.local);
		add("remote", entry.remote);
	}
	for (const observation of observations) {
		if (observation.kind === "exact" || observation.kind === "alias" ||
			observation.kind === "present_unresolved") add(observation.side, observation.entity);
	}
	const pool = new AsyncPool(10);
	const facts = await Promise.all([...occurrences.values()].map((occurrence) => pool.run(async () => {
		const statObservation = observePath(occurrence.side, occurrence.path, await occurrence.fs.stat(occurrence.path));
		const statEntity = exactEntity(statObservation);
		if (!statEntity) return { ...occurrence, observation: statObservation, entity: undefined };
		const content = await occurrence.fs.read(occurrence.path);
		if (content.byteLength !== statEntity.size) {
			throw new Error(`Collision source changed while observed: ${occurrence.path}`);
		}
		const entity = { ...statEntity, hash: await sha256(content) };
		return { ...occurrence, observation: observePath(occurrence.side, occurrence.path, entity), entity };
	})));
	for (const fact of facts) {
		for (const entry of entries) {
			if (fact.side === "local" && entry.local?.path === fact.path) entry.local = undefined;
			if (fact.side === "remote" && entry.remote?.path === fact.path) entry.remote = undefined;
		}
		replaceObservation(observations, fact.observation);
		if (!fact.entity) continue;
		for (let index = 0; index < observations.length; index++) {
			const observation = observations[index]!;
			if (observation.side !== fact.side || !("entity" in observation) ||
				observation.entity.path !== fact.path) continue;
			observations[index] = { ...observation, entity: fact.entity };
		}
		let entry = entries.find((candidate) => candidate.path === fact.path);
		if (!entry) {
			entry = { path: fact.path };
			entries.push(entry);
		}
		if (fact.side === "local") entry.local = fact.entity;
		else entry.remote = fact.entity;
	}
}

function potentialCollisionComponents(
	observations: readonly PathObservation[],
	identityEvidence: readonly IdentityEvidence[],
): ReadonlySet<string>[] {
	const adjacency = new Map<string, Set<string>>();
	const aliasPaths = new Set<string>();
	const connect = (left: string, right: string) => {
		const leftEdges = adjacency.get(left) ?? new Set<string>();
		const rightEdges = adjacency.get(right) ?? new Set<string>();
		leftEdges.add(right);
		rightEdges.add(left);
		adjacency.set(left, leftEdges);
		adjacency.set(right, rightEdges);
	};
	for (const observation of observations) {
		if (observation.kind === "alias" && !observation.entity.isDirectory) {
			connect(observation.requestedPath, observation.resolvedPath);
			aliasPaths.add(observation.requestedPath);
			aliasPaths.add(observation.resolvedPath);
		}
	}
	for (const evidence of identityEvidence) {
		const paths = evidence.kind === "rename" ? [evidence.oldPath, evidence.newPath]
			: evidence.kind === "alias" ? [evidence.requestedPath, evidence.resolvedPath]
				: evidence.occurrences.filter((occurrence) => occurrence.phase === "current")
					.map((occurrence) => occurrence.path);
		if (paths.length > 1) {
			for (const path of paths.slice(1)) connect(paths[0]!, path);
		}
	}
	const remaining = new Set(adjacency.keys());
	const components: Set<string>[] = [];
	while (remaining.size > 0) {
		const first = remaining.values().next().value as string;
		const component = new Set<string>();
		const pending = [first];
		while (pending.length > 0) {
			const path = pending.pop()!;
			if (component.has(path)) continue;
			component.add(path);
			remaining.delete(path);
			pending.push(...adjacency.get(path) ?? []);
		}
		if ([...component].some((path) => aliasPaths.has(path))) components.push(component);
	}
	return components;
}
