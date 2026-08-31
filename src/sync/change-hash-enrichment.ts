import type { IFileSystem } from "../fs/interface";
import { AsyncPool } from "../queue/async-queue";
import { digest, isLocallyComputable, sha256 } from "../utils/hash";
import { exactEntity, observePath, replaceObservation } from "./path-observation";
import type { MixedEntity, PathObservation } from "./types";

export interface HashEnrichmentResult {
	candidates: number;
	matches: number;
}

/** Enrich initial same-size pairs when the remote checksum is locally reproducible. */
export async function enrichHashesForInitialMatch(
	entries: MixedEntity[],
	localFs: IFileSystem,
): Promise<HashEnrichmentResult> {
	const candidates = entries.filter(
		(entry) => entry.local && entry.remote && !entry.prevSync &&
			!entry.local.hash && !entry.remote.hash &&
			entry.local.size === entry.remote.size &&
			entry.remote.remoteChecksum !== undefined &&
			isLocallyComputable(entry.remote.remoteChecksum.algo),
	);
	const pool = new AsyncPool(10);
	const outcomes = await Promise.all(candidates.map((entry) => pool.run(async () => {
		try {
			const remoteChecksum = entry.remote!.remoteChecksum!;
			const content = await localFs.read(entry.path);
			if (await digest(content, remoteChecksum.algo) === remoteChecksum.value) {
				const hash = await sha256(content);
				entry.local = { ...entry.local!, hash };
				entry.remote = { ...entry.remote!, hash };
				return true;
			}
		} catch {
			// A failed read stays unenriched and therefore takes the safe conflict path.
		}
		return false;
	})));
	return {
		candidates: candidates.length,
		matches: outcomes.filter(Boolean).length,
	};
}

/** Resolve and hash rename destinations that came from hash-free listings. */
export async function enrichHashesForRenames(
	entries: MixedEntity[],
	observations: PathObservation[],
	localFs: IFileSystem,
	renamePairs: ReadonlyMap<string, string>,
	folderRenamePairs: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
	const newPaths = new Set(renamePairs.keys());
	const newFolderPrefixes = [...folderRenamePairs.keys()].map((path) => path + "/");
	const candidates = entries.filter(
		(entry) => entry.local && !entry.local.isDirectory && !entry.local.hash &&
			(newPaths.has(entry.path) || newFolderPrefixes.some((prefix) => entry.path.startsWith(prefix))),
	);
	const pool = new AsyncPool(10);
	await Promise.all(candidates.map((entry) => pool.run(async () => {
		const observation = observePath("local", entry.path, await localFs.stat(entry.path));
		replaceObservation(observations, observation);
		const statEntity = exactEntity(observation);
		entry.local = statEntity ? { ...entry.local!, hash: statEntity.hash } : undefined;
	})));
}
