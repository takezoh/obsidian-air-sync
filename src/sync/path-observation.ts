import type { FileEntity } from "../fs/types";
import type { IFileSystem } from "../fs/interface";
import type { IdentityEvidence, MixedEntity, PathObservation, SyncSide } from "./types";
import { AsyncPool } from "../queue/async-queue";

export function observePath(
	side: SyncSide,
	requestedPath: string,
	entity: FileEntity | null | undefined,
	absenceAuthority: "stat" | "checkpoint_deleted" = "stat",
	source: "stat" | "list" = "stat",
): PathObservation {
	if (!entity) return { kind: "absent", side, requestedPath, authority: absenceAuthority };
	if (entity.pathAuthority !== "actual_resolved") {
		return {
			kind: "present_unresolved", side, requestedPath, returnedPath: entity.path, entity, source,
		};
	}
	if (entity.path === requestedPath) return { kind: "exact", side, requestedPath, entity };
	return { kind: "alias", side, requestedPath, resolvedPath: entity.path, entity };
}

export function exactEntity(observation: PathObservation): FileEntity | undefined {
	return observation.kind === "exact" && !observation.entity.isDirectory
		? observation.entity
		: undefined;
}

/** Replace listing uncertainty with authoritative stat observations before planning absence. */
export async function confirmEntryAbsences(
	changeSet: { entries: MixedEntity[]; observations: PathObservation[] },
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<void> {
	const observationIndexes = new Map<string, number>();
	changeSet.observations.forEach((observation, index) => {
		const key = observationKey(observation.side, observation.requestedPath);
		if (!observationIndexes.has(key)) observationIndexes.set(key, index);
	});
	const candidates = changeSet.entries.flatMap((entry) => {
		const missing: Array<{ side: SyncSide; fs: IFileSystem }> = [];
		if (!entry.local && needsConfirmation(observationAt(
			changeSet.observations, observationIndexes, "local", entry.path,
		))) {
			missing.push({ side: "local", fs: localFs });
		}
		if (!entry.remote && needsConfirmation(observationAt(
			changeSet.observations, observationIndexes, "remote", entry.path,
		))) {
			missing.push({ side: "remote", fs: remoteFs });
		}
		return missing.map(({ side, fs }) => ({ entry, side, fs }));
	});
	const pool = new AsyncPool(10);
	const confirmed = await Promise.all(candidates.map(({ entry, side, fs }) => pool.run(async () => {
		const observation = observePath(side, entry.path, await fs.stat(entry.path));
		return { entry, side, observation };
	})));
	for (const { entry, side, observation } of confirmed) {
		const key = observationKey(side, entry.path);
		const index = observationIndexes.get(key);
		if (index === undefined) {
			observationIndexes.set(key, changeSet.observations.length);
			changeSet.observations.push(observation);
		} else {
			changeSet.observations[index] = observation;
		}
		const entity = exactEntity(observation);
		if (side === "local") entry.local = entity;
		else entry.remote = entity;
	}
}

/**
 * A file-level local alias can reveal a case-only parent mismatch even when the
 * listing produced no explicit folder rename evidence.  Observe the two parent
 * endpoints as facts so Admission can decide the whole component; this function
 * does not create rename evidence or actions.
 */
export async function confirmCaseAliasParentEndpoints(
	observations: PathObservation[],
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<void> {
	const pairs = new Map<string, { oldPath: string; newPath: string }>();
	for (const observation of observations) {
		if (observation.kind !== "alias" || observation.side !== "local" ||
			observation.entity.isDirectory) continue;
		const oldPath = parentPath(observation.requestedPath);
		const newPath = parentPath(observation.resolvedPath);
		if (!oldPath || !newPath || oldPath === newPath ||
			oldPath.toLowerCase() !== newPath.toLowerCase()) continue;
		pairs.set(`${oldPath}\0${newPath}`, { oldPath, newPath });
	}
	const pool = new AsyncPool(10);
	await Promise.all([...pairs.values()].flatMap(({ oldPath, newPath }) => [
		{ side: "local" as const, path: oldPath, fs: localFs },
		{ side: "local" as const, path: newPath, fs: localFs },
		{ side: "remote" as const, path: oldPath, fs: remoteFs },
		{ side: "remote" as const, path: newPath, fs: remoteFs },
	].filter(({ side, path }) => !observations.some((observation) =>
		observation.side === side && observation.requestedPath === path &&
		observation.kind !== "unknown" && observation.kind !== "present_unresolved"))
		.map(({ side, path, fs }) => pool.run(async () => {
			replaceObservation(observations, observePath(side, path, await fs.stat(path)));
		}))));
}

function parentPath(path: string): string {
	const separator = path.lastIndexOf("/");
	return separator === -1 ? "" : path.slice(0, separator);
}

function observationAt(
	observations: readonly PathObservation[],
	indexes: ReadonlyMap<string, number>,
	side: SyncSide,
	path: string,
): PathObservation | undefined {
	const index = indexes.get(observationKey(side, path));
	return index === undefined ? undefined : observations[index];
}

function observationKey(side: SyncSide, path: string): string {
	return `${side}\0${path}`;
}

function needsConfirmation(observation: PathObservation | undefined): boolean {
	return !observation || observation.kind === "unknown" ||
		(observation.kind === "present_unresolved" && observation.source === "list");
}

export function ensureRenameEndpointObservations(
	observations: PathObservation[],
	evidence: readonly IdentityEvidence[],
): void {
	for (const item of evidence) {
		if (item.kind !== "rename") continue;
		for (const requestedPath of [item.oldPath, item.newPath]) {
			if (!observations.some((observation) =>
				observation.side === item.side && observation.requestedPath === requestedPath)) {
				observations.push({
					kind: "unknown", side: item.side, requestedPath, reason: "not_observed",
				});
			}
		}
	}
}

/** Resolve rename-origin endpoints that collection did not otherwise observe. */
export async function confirmUnknownRenameEndpoints(
	changeSet: { observations: PathObservation[]; identityEvidence: readonly IdentityEvidence[] },
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<void> {
	const candidates = new Map<string, { side: SyncSide; path: string; fs: IFileSystem }>();
	for (const evidence of changeSet.identityEvidence) {
		if (evidence.kind !== "rename") continue;
		for (const path of [evidence.oldPath, evidence.newPath]) {
			const observation = changeSet.observations.find((candidate) =>
				candidate.side === evidence.side && candidate.requestedPath === path);
			if (observation?.kind === "unknown" && observation.reason === "not_observed") {
				candidates.set(`${evidence.side}\0${path}`, {
					side: evidence.side,
					path,
					fs: evidence.side === "local" ? localFs : remoteFs,
				});
			}
		}
	}
	const pool = new AsyncPool(10);
	await Promise.all([...candidates.values()].map(({ side, path, fs }) => pool.run(async () => {
		replaceObservation(changeSet.observations, observePath(side, path, await fs.stat(path)));
	})));
}

/** Confirm the opposite side of every rename candidate before Admission classifies it. */
export async function confirmRenameOppositeEndpoints(
	observations: PathObservation[],
	evidence: readonly IdentityEvidence[],
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<void> {
	const candidates = new Map<string, { side: SyncSide; path: string; fs: IFileSystem }>();
	for (const item of evidence) {
		if (item.kind !== "rename") continue;
		const side = item.side === "local" ? "remote" : "local";
		const fs = side === "local" ? localFs : remoteFs;
		for (const path of [item.oldPath, item.newPath]) {
			const existing = observations.find((observation) =>
				observation.side === side && observation.requestedPath === path);
			if (!existing || existing.kind === "unknown" ||
				(existing.kind === "present_unresolved" && existing.source === "list")) {
				candidates.set(`${side}\0${path}`, { side, path, fs });
			}
		}
	}
	const pool = new AsyncPool(10);
	await Promise.all([...candidates.values()].map(({ side, path, fs }) => pool.run(async () => {
		replaceObservation(observations, observePath(side, path, await fs.stat(path)));
	})));
}

export function replaceObservation(observations: PathObservation[], replacement: PathObservation): void {
	const index = observations.findIndex((observation) =>
		observation.side === replacement.side && observation.requestedPath === replacement.requestedPath);
	if (index === -1) observations.push(replacement);
	else observations[index] = replacement;
}
