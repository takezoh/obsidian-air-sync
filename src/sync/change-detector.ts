import type { IFileSystem } from "../fs/interface";
import type { MixedEntity, RenamePair, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { LocalChangeTracker } from "./local-tracker";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import { md5 } from "../utils/md5";
import { sha256 } from "../utils/hash";
import { AsyncPool } from "../queue/async-queue";

export interface ChangeSet {
	entries: MixedEntity[];
	temperature: "hot" | "warm" | "cold";
	remoteRenamePairs: RenamePair[];
}

export interface ChangeDetectorDeps {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	stateStore: SyncStateStore;
	localTracker: LocalChangeTracker;
}

/**
 * Collect changes using the appropriate temperature mode.
 *
 * hot  (O(delta)): tracker initialized + dirty paths → stat() + cache + getMany()
 * warm (O(n) local + O(delta) remote): list() + getAll() diff + remote delta
 * cold (O(n)): both list() + full join (equivalent to buildMixedEntities)
 */
export async function collectChanges(deps: ChangeDetectorDeps): Promise<ChangeSet> {
	const { localTracker, stateStore } = deps;

	let changeSet: ChangeSet;

	// Determine temperature
	if (localTracker.isInitialized() && localTracker.getDirtyPaths().size > 0) {
		changeSet = await collectHot(deps);
	} else {
		const allRecords = await stateStore.getAll();
		changeSet = allRecords.length === 0
			? await collectCold(deps, allRecords)
			: await collectWarm(deps, allRecords);
	}

	// Enrich empty hashes for entries without baseline (all temperature modes)
	await enrichHashesForInitialMatch(changeSet.entries, deps.localFs);

	// Ensure rename-related local entries have hashes (WARM/COLD use list() → hash:"")
	await enrichHashesForRenames(changeSet.entries, deps.localFs, localTracker.getRenamePairs());

	return changeSet;
}

async function collectHot(deps: ChangeDetectorDeps): Promise<ChangeSet> {
	const { localFs, remoteFs, stateStore, localTracker } = deps;

	const dirtyPaths = localTracker.getDirtyPaths();

	// Get remote changed paths if supported
	const remoteChanges = await getRemoteChanges(remoteFs);

	// Union of local dirty and remote changed paths
	const changedPaths = new Set<string>(dirtyPaths);
	for (const p of remoteChanges.paths) {
		changedPaths.add(p);
	}

	const pathArray = Array.from(changedPaths);

	// Fetch local stats, remote stats, and sync records in parallel
	const [localStats, remoteStats, syncRecords] = await Promise.all([
		Promise.all(pathArray.map((p) => localFs.stat(p))),
		Promise.all(pathArray.map((p) => remoteFs.stat(p))),
		stateStore.getMany(pathArray),
	]);

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const local = localStats[i] ?? undefined;
		const remote = remoteStats[i] ?? undefined;
		const prevSync = syncRecords.get(path);
		return {
			path,
			local: local?.isDirectory ? undefined : local,
			remote: remote?.isDirectory ? undefined : remote,
			prevSync,
		};
	});

	// Also include unchanged records not in changedPaths so downstream has full picture
	// (only entries with actual changes are included in hot mode — callers handle partial sets)
	const filtered = entries.filter((e) => {
		// Include if local or remote exists, or if there's a prevSync (deletion case)
		return e.local !== undefined || e.remote !== undefined || e.prevSync !== undefined;
	});

	// Check which hot entries actually changed vs baseline (prune no-ops)
	const changed = filtered.filter((e) => {
		const prev = e.prevSync;
		// Both deleted — include if previously synced (cleanup)
		if (!e.local && !e.remote) return !!prev;
		// New file: no prev record
		if (!prev) return true;
		// Local deleted but remote still exists (e.g. rename source)
		if (!e.local && e.remote) return true;
		// Local changed
		if (e.local && hasChanged(e.local, prev)) return true;
		// Remote changed
		if (e.remote && hasRemoteChanged(e.remote, prev)) return true;
		return false;
	});

	return { entries: changed, temperature: "hot", remoteRenamePairs: remoteChanges.renamed };
}

async function collectWarm(deps: ChangeDetectorDeps, allRecords: SyncRecord[]): Promise<ChangeSet> {
	const { localFs, remoteFs } = deps;

	const [localFiles, remoteChanges] = await Promise.all([
		localFs.list(),
		getRemoteChanges(remoteFs),
	]);

	const recordMap = new Map(allRecords.map((r) => [r.path, r]));
	const changedPaths = new Set<string>();

	// Compare local listing against sync records
	for (const file of localFiles) {
		if (file.isDirectory) continue;
		const record = recordMap.get(file.path);
		if (!record || hasChanged(file, record)) {
			changedPaths.add(file.path);
		}
	}

	// Include paths that existed in records but are no longer in local listing (local deletions)
	const localPathSet = new Set(localFiles.filter((f) => !f.isDirectory).map((f) => f.path));
	for (const record of allRecords) {
		if (!localPathSet.has(record.path)) {
			changedPaths.add(record.path);
		}
	}

	// Add remote changed paths
	for (const p of remoteChanges.paths) {
		changedPaths.add(p);
	}

	// Include rename pair paths so warm mode can optimize renames
	const renamePairs = deps.localTracker.getRenamePairs();
	for (const [newPath, oldPath] of renamePairs) {
		changedPaths.add(newPath);
		changedPaths.add(oldPath);
	}

	const pathArray = Array.from(changedPaths);
	const remoteStats = await Promise.all(pathArray.map((p) => remoteFs.stat(p)));

	const localFileMap = new Map(localFiles.filter((f) => !f.isDirectory).map((f) => [f.path, f]));

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const remote = remoteStats[i] ?? undefined;
		return {
			path,
			local: localFileMap.get(path),
			remote: remote?.isDirectory ? undefined : remote,
			prevSync: recordMap.get(path),
		};
	});

	return { entries, temperature: "warm", remoteRenamePairs: remoteChanges.renamed };
}

async function collectCold(deps: ChangeDetectorDeps, allRecords: SyncRecord[]): Promise<ChangeSet> {
	const { localFs, remoteFs } = deps;

	const [localFiles, remoteFiles] = await Promise.all([
		localFs.list(),
		remoteFs.list(),
	]);
	const syncRecords = allRecords;

	const pathMap = new Map<string, MixedEntity>();

	const getOrCreate = (path: string): MixedEntity => {
		let entity = pathMap.get(path);
		if (!entity) {
			entity = { path };
			pathMap.set(path, entity);
		}
		return entity;
	};

	for (const file of localFiles) {
		if (file.isDirectory) continue;
		getOrCreate(file.path).local = file;
	}

	for (const file of remoteFiles) {
		if (file.isDirectory) continue;
		getOrCreate(file.path).remote = file;
	}

	for (const record of syncRecords) {
		getOrCreate(record.path).prevSync = record;
	}

	return { entries: Array.from(pathMap.values()), temperature: "cold", remoteRenamePairs: [] };
}

/**
 * Enrich empty hashes for entries without baseline by comparing local MD5
 * with remote's backend-provided contentChecksum. Runs for all temperature
 * modes to handle partial initial syncs and simultaneous file creation.
 */
async function enrichHashesForInitialMatch(
	entries: MixedEntity[],
	localFs: IFileSystem,
): Promise<void> {
	const candidates = entries.filter(
		(e) => e.local && e.remote && !e.prevSync &&
			!e.local.hash && !e.remote.hash &&
			e.local.size === e.remote.size &&
			typeof e.remote.backendMeta?.contentChecksum === "string"
	);
	if (candidates.length === 0) return;

	const pool = new AsyncPool(10);
	await Promise.all(
		candidates.map((entry) =>
			pool.run(async () => {
				try {
					const content = await localFs.read(entry.path);
					const localMd5 = md5(content);
					const remoteMd5 = entry.remote!.backendMeta!.contentChecksum as string;
					if (localMd5 === remoteMd5) {
						const contentHash = await sha256(content);
						entry.local = { ...entry.local!, hash: contentHash };
						entry.remote = { ...entry.remote!, hash: contentHash };
					}
				} catch {
					// Skip failed reads — entry stays unenriched (conflict, safe side)
				}
			})
		)
	);
}

/**
 * Ensure rename destination entries have hashes via stat().
 * In WARM/COLD mode, list() returns hash:"" — the rename optimizer
 * needs a real hash to verify content equivalence.
 */
export async function enrichHashesForRenames(
	entries: MixedEntity[],
	localFs: IFileSystem,
	renamePairs: ReadonlyMap<string, string>,
): Promise<void> {
	if (renamePairs.size === 0) return;

	const newPaths = new Set(renamePairs.keys());
	const candidates = entries.filter(
		(e) => newPaths.has(e.path) && e.local && !e.local.hash,
	);
	if (candidates.length === 0) return;

	await Promise.all(
		candidates.map(async (entry) => {
			try {
				const stat = await localFs.stat(entry.path);
				if (stat && !stat.isDirectory && stat.hash) {
					entry.local = { ...entry.local!, hash: stat.hash };
				}
			} catch {
				// Skip — rename optimizer falls back to push+delete
			}
		})
	);
}

interface RemoteChanges {
	paths: string[];
	renamed: RenamePair[];
}

async function getRemoteChanges(remoteFs: IFileSystem): Promise<RemoteChanges> {
	if (!remoteFs.getChangedPaths) return { paths: [], renamed: [] };
	const result = await remoteFs.getChangedPaths();
	if (!result) return { paths: [], renamed: [] };
	return {
		paths: [...result.modified, ...result.deleted],
		renamed: result.renamed ?? [],
	};
}
