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

/** Replace listing uncertainty with authoritative stat observations for baseline paths. */
export async function confirmBaselineAbsences(
	changeSet: { entries: MixedEntity[]; observations: PathObservation[] },
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<void> {
	const candidates = changeSet.entries.flatMap((entry) => {
		if (!entry.prevSync) return [];
		const missing: Array<{ side: SyncSide; fs: IFileSystem }> = [];
		if (!entry.local && needsConfirmation(changeSet.observations, "local", entry.path)) {
			missing.push({ side: "local", fs: localFs });
		}
		if (!entry.remote && needsConfirmation(changeSet.observations, "remote", entry.path)) {
			missing.push({ side: "remote", fs: remoteFs });
		}
		return missing.map(({ side, fs }) => ({ entry, side, fs }));
	});
	const pool = new AsyncPool(10);
	await Promise.all(candidates.map(({ entry, side, fs }) => pool.run(async () => {
		const observation = observePath(side, entry.path, await fs.stat(entry.path));
		replaceObservation(changeSet.observations, observation);
		const entity = exactEntity(observation);
		if (side === "local") entry.local = entity;
		else entry.remote = entity;
	})));
}

function needsConfirmation(
	observations: readonly PathObservation[],
	side: SyncSide,
	path: string,
): boolean {
	const observation = observations.find((candidate) =>
		candidate.side === side && candidate.requestedPath === path);
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

/** Confirm the other side of durable rename evidence so a clean replay can retire its debt. */
export async function confirmCarriedRenameOppositeEndpoints(
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
