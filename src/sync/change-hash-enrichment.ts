import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import { AsyncPool } from "../queue/async-queue";
import { digest, isLocallyComputable, sha256 } from "../utils/hash";
import { exactEntity, observePath, replaceObservation } from "./path-observation";
import type { CandidateFact, IdentityEvidence, MixedEntity, PathObservation } from "./types";
import { directConflictCandidateHint, insertConflictSuffix } from "./conflict";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import { captureContentSnapshot } from "./content-snapshot";

export interface HashEnrichmentResult {
	candidates: number;
	matches: number;
}

export interface PreferLocalHashEnrichmentResult {
	candidates: number;
	completed: number;
}

/** Complete current SHA-256 facts only for baseline-backed Prefer-local edit/edit candidates. */
export async function enrichHashesForPreferLocal(
	entries: MixedEntity[],
	observations: PathObservation[],
	identityEvidence: readonly IdentityEvidence[],
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<PreferLocalHashEnrichmentResult> {
	const repeatedRemoteIdentities = repeatedIdentityKeys(entries);
	const candidates = entries.filter((entry) => entry.prevSync?.hash && entry.local && entry.remote &&
		!entry.local.isDirectory && !entry.remote.isDirectory &&
		entry.prevSync.path === entry.path && entry.local.path === entry.path && entry.remote.path === entry.path &&
		(!entry.prevSync.remoteIdentityKey || !entry.remote.identityKey ||
			entry.prevSync.remoteIdentityKey === entry.remote.identityKey) &&
		!touchesTopology(entry.path, entry.remote.identityKey, identityEvidence, observations, repeatedRemoteIdentities) &&
		hasChanged(entry.local, entry.prevSync) && hasRemoteChanged(entry.remote, entry.prevSync));
	const pool = new AsyncPool(10);
	const settled = await Promise.allSettled(candidates.map((entry) => pool.run(async () => {
		entry.local = await completeSha256Fact("local", entry.path, entry.local!, localFs, observations);
		entry.remote = await completeSha256Fact("remote", entry.path, entry.remote!, remoteFs, observations);
	})));
	const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failure) throw failure.reason;
	return { candidates: candidates.length, completed: candidates.length };
}

function repeatedIdentityKeys(entries: readonly MixedEntity[]): ReadonlySet<string> {
	const paths = new Map<string, Set<string>>();
	for (const entry of entries) {
		if (!entry.remote?.identityKey) continue;
		const current = paths.get(entry.remote.identityKey) ?? new Set<string>();
		current.add(entry.remote.path);
		paths.set(entry.remote.identityKey, current);
	}
	return new Set([...paths].filter(([, current]) => current.size > 1).map(([identity]) => identity));
}

/** Conservative read gate only; Admission remains the owner of local-win eligibility. */
function touchesTopology(
	path: string,
	remoteIdentityKey: string | undefined,
	evidence: readonly IdentityEvidence[],
	observations: readonly PathObservation[],
	repeatedRemoteIdentities: ReadonlySet<string>,
): boolean {
	if (remoteIdentityKey && repeatedRemoteIdentities.has(remoteIdentityKey)) return true;
	const touches = (candidate: string): boolean =>
		path === candidate || path.startsWith(candidate + "/") || candidate.startsWith(path + "/");
	for (const item of evidence) {
		if (item.kind === "rename" && (touches(item.oldPath) || touches(item.newPath))) return true;
		if (item.kind === "alias" && (touches(item.requestedPath) || touches(item.resolvedPath))) return true;
		if (item.kind === "stable_identity" && remoteIdentityKey === item.identityKey &&
			new Set(item.occurrences.map((occurrence) => occurrence.path)).size > 1) return true;
	}
	return observations.some((item) => item.kind === "alias" &&
		(touches(item.requestedPath) || touches(item.resolvedPath)));
}

async function completeSha256Fact(
	side: "local" | "remote",
	path: string,
	entity: FileEntity,
	fs: IFileSystem,
	observations: PathObservation[],
): Promise<FileEntity> {
	if (entity.hash) return entity;
	if (entity.remoteChecksum?.algo === "sha256") {
		const enriched = { ...entity, hash: entity.remoteChecksum.value };
		replaceObservation(observations, observePath(side, path, enriched));
		return enriched;
	}
	const snapshot = await captureContentSnapshot(fs, path, entity);
	const enriched = { ...snapshot.entity, hash: await sha256(snapshot.content) };
	replaceObservation(observations, observePath(side, path, enriched));
	return enriched;
}

/** Enrich initial same-size pairs from a remote SHA-256 or reproducible checksum. */
export async function enrichHashesForInitialMatch(
	entries: MixedEntity[],
	localFs: IFileSystem,
): Promise<HashEnrichmentResult> {
	const candidates = entries.filter(
		(entry) => entry.local && entry.remote && !entry.prevSync &&
			entry.local.size === entry.remote.size &&
			!entry.local.hash && (
				!!entry.remote.hash || (!entry.remote.hash &&
					entry.remote.remoteChecksum !== undefined &&
					isLocallyComputable(entry.remote.remoteChecksum.algo))
			),
	);
	const pool = new AsyncPool(10);
	const outcomes = await Promise.all(candidates.map((entry) => pool.run(async () => {
		try {
			const content = await localFs.read(entry.path);
			if (entry.remote!.hash) {
				const hash = await sha256(content);
				if (hash === entry.remote!.hash) {
					entry.local = { ...entry.local!, hash };
					return true;
				}
				return false;
			}
			const remoteChecksum = entry.remote!.remoteChecksum!;
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

/** Freeze direct candidate occupancy only after every source hash is complete. */
export async function observeDirectConflictCandidates(
	entries: MixedEntity[],
	observations: PathObservation[],
	identityEvidence: readonly IdentityEvidence[],
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<Array<Omit<CandidateFact, "baseline">>> {
	const bases = new Set(observations.flatMap((item) => item.kind === "alias" && !item.entity.isDirectory
		? [item.requestedPath, item.resolvedPath] : []));
	if (bases.size === 0) return [];
	const versionsByBase = new Map<string, ReadonlySet<string>>();
	const derivedCandidates = new Set<string>();
	for (const base of bases) {
		const versions = sourceHashesAt(base, entries, identityEvidence);
		versionsByBase.set(base, versions);
		for (const hash of versions) derivedCandidates.add(insertConflictSuffix(base, hash));
	}
	const hintedCandidates = new Set(entries.flatMap((entry) => [entry.path, entry.prevSync?.path]
		.filter((path): path is string => path !== undefined)
		.filter((path) => {
			const hint = directConflictCandidateHint(path);
			return hint !== undefined && bases.has(hint.basePath);
		})));
	for (const path of hintedCandidates) derivedCandidates.add(path);
	const subordinateBases = new Set<string>();
	for (let index = observations.length - 1; index >= 0; index--) {
		const observation = observations[index]!;
		if (observation.kind !== "alias" || observation.entity.isDirectory ||
			!derivedCandidates.has(observation.requestedPath)) continue;
		subordinateBases.add(observation.requestedPath);
		subordinateBases.add(observation.resolvedPath);
		observations.splice(index, 1);
	}
	const requests: Array<{ side: "local" | "remote"; path: string; fs: IFileSystem }> = [];
	for (const base of bases) {
		if (subordinateBases.has(base)) continue;
		for (const hash of versionsByBase.get(base) ?? []) {
			const path = insertConflictSuffix(base, hash);
			requests.push({ side: "local", path, fs: localFs }, { side: "remote", path, fs: remoteFs });
		}
	}
	for (const path of hintedCandidates) {
		requests.push({ side: "local", path, fs: localFs }, { side: "remote", path, fs: remoteFs });
	}
	const uniqueRequests = [...new Map(requests.map((item) => [`${item.side}\0${item.path}`, item])).values()];
	const pool = new AsyncPool(10);
	const endpoints = await Promise.all(uniqueRequests.map((request) => pool.run(async () => {
		let entity = await request.fs.stat(request.path);
		if (entity && !entity.isDirectory && !entity.hash) {
			const content = await request.fs.read(request.path);
			if (content.byteLength !== entity.size) throw new Error(`Conflict candidate changed while observed: ${request.path}`);
			entity = { ...entity, hash: await sha256(content) };
		}
		return { ...request, entity, observation: observePath(request.side, request.path, entity) };
	})));
	for (const fact of endpoints) {
		if (!fact.entity) continue;
		const path = fact.entity.path;
		let entry = entries.find((candidate) => candidate.path === path);
		if (!entry) {
			entry = { path };
			entries.push(entry);
		}
		if (fact.side === "local") entry.local = fact.entity;
		else entry.remote = fact.entity;
	}
	const requestedPaths = [...new Set(uniqueRequests.map((request) => request.path))];
	return requestedPaths.map((requestedPath) => {
		const local = endpoints.find((item) => item.side === "local" && item.path === requestedPath)?.observation;
		const remote = endpoints.find((item) => item.side === "remote" && item.path === requestedPath)?.observation;
		if (!local || !remote) throw new Error(`Incomplete candidate observation: ${requestedPath}`);
		return { requestedPath, local, remote };
	});
}

function sourceHashesAt(
	base: string, entries: readonly MixedEntity[], identityEvidence: readonly IdentityEvidence[],
): ReadonlySet<string> {
	const connected = connectedEvidencePaths(base, identityEvidence);
	return new Set(entries.flatMap((entry) => [entry.local, entry.remote]
		.filter((entity): entity is FileEntity =>
			!!entity && !entity.isDirectory && !!entity.hash && connected.has(entity.path))
		.map((entity) => entity.hash)));
}

function connectedEvidencePaths(base: string, evidence: readonly IdentityEvidence[]): ReadonlySet<string> {
	const connected = new Set([base]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const item of evidence) {
			const paths = item.kind === "rename" ? [item.oldPath, item.newPath]
				: item.kind === "alias" ? [item.requestedPath, item.resolvedPath]
					: item.occurrences.filter((occurrence) => occurrence.phase === "current")
						.map((occurrence) => occurrence.path);
			if (!paths.some((path) => connected.has(path))) continue;
			for (const path of paths) {
				if (!connected.has(path)) {
					connected.add(path);
					changed = true;
				}
			}
		}
	}
	return connected;
}

/** Acquire content facts at both reported endpoints, including unchanged folder children. */
export async function enrichHashesForRenames(
	entries: MixedEntity[],
	observations: PathObservation[],
	localFs: IFileSystem,
	remoteFs: IFileSystem,
	evidence: readonly IdentityEvidence[],
): Promise<void> {
	const paths = new Set<string>();
	const prefixes = new Set<string>();
	for (const item of evidence) {
		if (item.kind !== "rename") continue;
		for (const path of [item.oldPath, item.newPath]) {
			paths.add(path);
			if (item.isFolder) prefixes.add(path + "/");
		}
	}
	const candidates = entries.filter((entry) => paths.has(entry.path) ||
		[...prefixes].some((prefix) => entry.path.startsWith(prefix)));
	const pool = new AsyncPool(10);
	await Promise.all(candidates.map((entry) => pool.run(async () => {
		if (entry.remote && !entry.remote.isDirectory && !entry.remote.hash && !entry.remote.remoteChecksum) {
			const observation = observePath("remote", entry.path, await remoteFs.stat(entry.path));
			replaceObservation(observations, observation);
			entry.remote = exactEntity(observation);
		}
		let statEntity = entry.local;
		if (!statEntity || statEntity.isDirectory) return;
		if (!statEntity.hash) {
			const observation = observePath("local", entry.path, await localFs.stat(entry.path));
			replaceObservation(observations, observation);
			statEntity = exactEntity(observation);
			entry.local = statEntity;
		}
		const remoteChecksum = entry.remote?.remoteChecksum;
		if (!statEntity?.hash || !entry.remote || entry.remote.hash || !remoteChecksum ||
			!isLocallyComputable(remoteChecksum.algo)) return;
		const content = await localFs.read(entry.path);
		if (content.byteLength !== statEntity.size || await sha256(content) !== statEntity.hash) return;
		if (await digest(content, remoteChecksum.algo) !== remoteChecksum.value) return;
		entry.remote = { ...entry.remote, hash: statEntity.hash };
		replaceObservation(observations, observePath("remote", entry.path, entry.remote));
	})));
}
