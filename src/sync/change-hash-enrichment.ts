import type { IFileSystem } from "../fs/interface";
import { AsyncPool } from "../queue/async-queue";
import { digest, isLocallyComputable, sha256 } from "../utils/hash";
import { exactEntity, observePath, replaceObservation } from "./path-observation";
import type { MixedEntity, PathObservation } from "./types";
import { hasChanged, hasRemoteChanged } from "./change-compare";

/** Enrich initial same-size pairs when the remote checksum is locally reproducible. */
export async function enrichHashesForInitialMatch(
	entries: MixedEntity[],
	localFs: IFileSystem,
): Promise<void> {
	const candidates = entries.filter(
		(entry) => entry.local && entry.remote && !entry.prevSync &&
			!entry.local.hash && !entry.remote.hash &&
			entry.local.size === entry.remote.size &&
			entry.remote.remoteChecksum !== undefined &&
			isLocallyComputable(entry.remote.remoteChecksum.algo),
	);
	const pool = new AsyncPool(10);
	await Promise.all(candidates.map((entry) => pool.run(async () => {
		try {
			const remoteChecksum = entry.remote!.remoteChecksum!;
			const content = await localFs.read(entry.path);
			if (await digest(content, remoteChecksum.algo) === remoteChecksum.value) {
				const hash = await sha256(content);
				entry.local = { ...entry.local!, hash };
				entry.remote = { ...entry.remote!, hash };
			}
		} catch {
			// A failed read stays unenriched and therefore takes the safe conflict path.
		}
	})));
}

/**
 * Recover a write-completed / baseline-save-failed path without durable marker
 * state. Only the exact ambiguous shape pays two reads; unequal content remains a
 * normal conflict.
 */
export async function enrichHashesForBothChangedEqualContent(
	entries: MixedEntity[],
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<void> {
	const candidates = entries.filter((entry) =>
		entry.prevSync && entry.local && entry.remote &&
		!entry.local.isDirectory && !entry.remote.isDirectory &&
		entry.local.size === entry.remote.size &&
		hasChanged(entry.local, entry.prevSync) && hasRemoteChanged(entry.remote, entry.prevSync),
	);
	const pool = new AsyncPool(4);
	await Promise.all(candidates.map((entry) => pool.run(async () => {
		try {
			const [localContent, remoteContent] = await Promise.all([
				localFs.read(entry.path), remoteFs.read(entry.path),
			]);
			const [localHash, remoteHash] = await Promise.all([
				sha256(localContent), sha256(remoteContent),
			]);
			if (localHash !== remoteHash) return;
			entry.local = { ...entry.local!, hash: localHash };
			entry.remote = { ...entry.remote!, hash: remoteHash };
		} catch {
			// Read failure preserves the existing conflict admission.
		}
	})));
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
