import type { FileEntity } from "../fs/types";
import { exactEntity, replaceObservation } from "./path-observation";
import type { IdentityEvidence, MixedEntity, PathObservation, SyncSide } from "./types";

interface AcquisitionFacts {
	readonly entries: MixedEntity[];
	readonly observations: PathObservation[];
	readonly identityEvidence: readonly IdentityEvidence[];
}

function presentEntity(observation: PathObservation): FileEntity | undefined {
	return observation.kind === "exact" || observation.kind === "alias" ||
		observation.kind === "present_unresolved" ? observation.entity : undefined;
}

function sameOptional<T>(left: T | undefined, right: T | undefined): boolean {
	return left === undefined || right === undefined || left === right;
}

function mergeEntity(
	preferred: FileEntity,
	other: FileEntity,
	path: string,
	side: SyncSide,
	requireSamePath: boolean,
): FileEntity {
	const sameChecksum = !preferred.remoteChecksum || !other.remoteChecksum ||
		(preferred.remoteChecksum.algo === other.remoteChecksum.algo &&
			preferred.remoteChecksum.value === other.remoteChecksum.value);
	if ((requireSamePath && preferred.path !== other.path) ||
		preferred.isDirectory !== other.isDirectory || preferred.size !== other.size ||
		(preferred.mtime !== 0 && other.mtime !== 0 && preferred.mtime !== other.mtime) ||
		!sameOptional(preferred.identityKey, other.identityKey) ||
		!sameOptional(preferred.hash || undefined, other.hash || undefined) || !sameChecksum) {
		throw new Error(`HOT/WARM observation changed for ${side}:${path}`);
	}
	return {
		...preferred,
		mtime: preferred.mtime || other.mtime,
		hash: preferred.hash || other.hash,
		identityKey: preferred.identityKey ?? other.identityKey,
		remoteChecksum: preferred.remoteChecksum ?? other.remoteChecksum,
		backendMeta: preferred.backendMeta ?? other.backendMeta,
	};
}

function withEntity(observation: PathObservation, entity: FileEntity): PathObservation {
	if (observation.kind === "exact") return { ...observation, entity };
	if (observation.kind === "alias") return { ...observation, entity };
	if (observation.kind === "present_unresolved") return { ...observation, entity };
	return observation;
}

function reconcileObservation(
	hot: PathObservation,
	warm: PathObservation | undefined,
): PathObservation {
	if (!warm || warm.kind === "unknown") return hot;
	if (hot.kind === "unknown") return warm;
	const hotEntity = presentEntity(hot);
	const warmEntity = presentEntity(warm);
	if (!hotEntity || !warmEntity) {
		if (!hotEntity && !warmEntity) return hot;
		throw new Error(`HOT/WARM presence changed for ${hot.side}:${hot.requestedPath}`);
	}
	const hotResolved = hot.kind === "exact" || hot.kind === "alias";
	const warmResolved = warm.kind === "exact" || warm.kind === "alias";
	if (hotResolved && !warmResolved) {
		return withEntity(hot, mergeEntity(hotEntity, warmEntity, hot.requestedPath, hot.side, false));
	}
	if (warmResolved && !hotResolved) {
		return withEntity(warm, mergeEntity(warmEntity, hotEntity, hot.requestedPath, hot.side, false));
	}
	return withEntity(warm, mergeEntity(warmEntity, hotEntity, hot.requestedPath, hot.side, true));
}

/** Compose WARM breadth with every authoritative fact already acquired by HOT. */
export function promoteHotProbeIntoWarm(warm: AcquisitionFacts, hot: AcquisitionFacts): void {
	for (const hotEntry of hot.entries) {
		let warmEntry = warm.entries.find((entry) => entry.path === hotEntry.path);
		if (!warmEntry) {
			warmEntry = { path: hotEntry.path };
			warm.entries.push(warmEntry);
		}
		warmEntry.prevSync ??= hotEntry.prevSync;
		for (const side of ["local", "remote"] as const) {
			const hotObservation = hot.observations.find((observation) =>
				observation.side === side && observation.requestedPath === hotEntry.path);
			if (!hotObservation) continue;
			const warmObservation = warm.observations.find((observation) =>
				observation.side === side && observation.requestedPath === hotEntry.path);
			const merged = reconcileObservation(hotObservation, warmObservation);
			replaceObservation(warm.observations, merged);
			const entity = exactEntity(merged);
			if (side === "local") warmEntry.local = entity;
			else warmEntry.remote = entity;
		}
	}
}
