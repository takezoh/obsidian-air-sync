import type { IFileSystem } from "../fs/interface";
import { AsyncPool } from "../queue/async-queue";
import { digest, isLocallyComputable, sha256 } from "../utils/hash";
import { exactEntity, observePath, replaceObservation } from "./path-observation";
import type { IdentityEvidence, MixedEntity, PathObservation } from "./types";

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

/** Acquire comparable content facts for local case aliases before Admission. */
export async function enrichHashesForLocalCaseAliases(
	entries: MixedEntity[],
	observations: PathObservation[],
	identityEvidence: readonly IdentityEvidence[],
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<void> {
	const byPath = new Map(entries.map((entry) => [entry.path, entry]));
	const candidates = new Map<string, { source: MixedEntity; target: MixedEntity }>();
	for (const observation of observations) {
		if (observation.kind !== "alias" || observation.side !== "local" ||
			observation.requestedPath.toLowerCase() !== observation.resolvedPath.toLowerCase()) continue;
		if (identityEvidence.some((item) => item.kind === "rename" &&
			((item.oldPath === observation.requestedPath && item.newPath === observation.resolvedPath) ||
				(item.oldPath === observation.resolvedPath && item.newPath === observation.requestedPath)))) continue;
		const source = byPath.get(observation.requestedPath);
		const target = byPath.get(observation.resolvedPath);
		if (!source?.remote || source.local || !target?.local || target.remote ||
			source.remote.isDirectory || target.local.isDirectory) continue;
		candidates.set(`${source.path}\0${target.path}`, { source, target });
	}
	const pool = new AsyncPool(10);
	await Promise.all([...candidates.values()].map(({ source, target }) => pool.run(async () => {
		const [localContent, remoteContent] = await Promise.all([
			localFs.read(target.path),
			remoteFs.read(source.path),
		]);
		const [localHash, remoteHash] = await Promise.all([
			sha256(localContent),
			sha256(remoteContent),
		]);
		target.local = { ...target.local!, hash: localHash };
		source.remote = { ...source.remote!, hash: remoteHash };
		replaceObservation(observations, observePath("local", source.path, target.local));
		replaceObservation(observations, observePath("local", target.path, target.local));
		replaceObservation(observations, observePath("remote", source.path, source.remote));
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
		(entry) => entry.local && !entry.local.isDirectory &&
			(newPaths.has(entry.path) || newFolderPrefixes.some((prefix) => entry.path.startsWith(prefix))),
	);
	const pool = new AsyncPool(10);
	await Promise.all(candidates.map((entry) => pool.run(async () => {
		let statEntity = entry.local;
		if (!statEntity) return;
		if (!statEntity.hash) {
			const observation = observePath("local", entry.path, await localFs.stat(entry.path));
			replaceObservation(observations, observation);
			statEntity = exactEntity(observation);
			entry.local = statEntity ? { ...entry.local!, hash: statEntity.hash } : undefined;
		}
		const remoteChecksum = entry.remote?.remoteChecksum;
		if (!statEntity?.hash || !entry.remote || entry.remote.hash || !remoteChecksum ||
			!isLocallyComputable(remoteChecksum.algo)) return;
		const content = await localFs.read(entry.path);
		if (await digest(content, remoteChecksum.algo) !== remoteChecksum.value) return;
		entry.remote = { ...entry.remote, hash: statEntity.hash };
		replaceObservation(observations, observePath("remote", entry.path, entry.remote));
	})));
}
