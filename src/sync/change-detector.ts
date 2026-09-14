/* eslint max-lines: ["error", 393] -- the COLD/WARM/HOT acquisition strategies, their directory-fact handling, and the WARM-to-COLD folder-delete escalation are one acquisition owner. */
import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { CandidateFact, IdentityEvidence, MixedEntity, PathObservation, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { TrackerSnapshot } from "./local-tracker";
import type { Logger } from "../logging/logger";
import { hasChanged } from "./change-compare";
import {
	enrichHashesForInitialMatch,
	enrichHashesForRenames,
	observeDirectConflictCandidates,
	type HashEnrichmentResult,
} from "./change-hash-enrichment";
import { directConflictCandidateHint } from "./conflict";
import { captureAliasCollisionContents } from "./collision-content-observation";
import { collectLocalRenameEvidence, completeIdentityEvidence } from "./identity-evidence";
import { needsWarmComponentAcquisition } from "./hot-acquisition-completeness";
import { promoteHotProbeIntoWarm } from "./hot-warm-promotion";
import {
	getRemoteChanges,
	hasFolderRename,
	remoteSnapshotAfterDelta,
	type RemoteChanges,
} from "./remote-change-source";
import {
	confirmEntryAbsences,
	confirmCaseAliasParentEndpoints,
	confirmRenameOppositeEndpoints,
	confirmUnknownRenameEndpoints,
	ensureRenameEndpointObservations,
	resolvedEntity,
	observePath,
} from "./path-observation";

export interface ChangeSet {
	entries: MixedEntity[];
	observations: PathObservation[];
	candidateFacts: CandidateFact[];
	identityEvidence: IdentityEvidence[];
	temperature: "hot" | "warm" | "cold";
	/** Acquisition diagnostics; production collection always supplies this after enrichment. */
	hashEnrichment?: HashEnrichmentResult;
}

export interface ChangeDetectorDeps {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	stateStore: SyncStateStore;
	changes: TrackerSnapshot;
	onRemoteIdentityEvidence?: (evidence: readonly IdentityEvidence[]) => void;
	logger?: Logger;
}

export interface CollectChangesOptions {
	/**
	 * Force a COLD full join regardless of tracker/store state. This is selected
	 * from durable facts such as a missing checkpoint or changed scope, never from
	 * a prior failure or persisted recovery instruction.
	 */
	forceFullScan?: boolean;
}

/**
 * Collect changes using the appropriate temperature mode.
 *
 * hot  (O(delta)): tracker initialized + dirty paths → stat() + cache + getMany()
 * warm (O(n) local + O(delta) remote): list() + getAll() diff + remote delta
 * cold (O(n)): both list() + full join (equivalent to buildMixedEntities)
 *
 * `forceFullScan` overrides the hot/warm choice and always runs COLD.
 */
export async function collectChanges(
	deps: ChangeDetectorDeps,
	opts: CollectChangesOptions = {},
): Promise<ChangeSet> {
	const { changes, stateStore } = deps;

	let changeSet: ChangeSet;
	// Determine temperature
	if (!opts.forceFullScan && changes.initialized && changes.dirtyPaths.size > 0 &&
		changes.folderRenamePairs.size === 0) {
		const remoteChanges = await getRemoteChanges(deps.remoteFs, deps.onRemoteIdentityEvidence);
		if (hasFolderRename(remoteChanges)) {
			changeSet = await collectCold(
				deps,
				await stateStore.getAll(),
				remoteChanges,
				undefined,
				await remoteSnapshotAfterDelta(deps.remoteFs),
			);
		} else {
			const hot = await collectHot(deps, remoteChanges);
			// Any unbaselined, partially observed address can be one spelling of a
			// managed alias component. This is an address-local condition: unrelated
			// dirty paths must not make the partial view authoritative. WARM observes
			// the record set and local surface; Admission still decides every address.
			if (needsWarmComponentAcquisition(hot, changes)) {
				const warm = await collectWarm(deps, await stateStore.getAll(), remoteChanges);
				promoteHotProbeIntoWarm(warm, hot);
				changeSet = warm;
			} else {
				changeSet = hot;
			}
		}
	} else {
		const allRecords = await stateStore.getAll();
		changeSet = opts.forceFullScan || allRecords.length === 0
			? await collectCold(deps, allRecords)
			: await collectWarm(deps, allRecords);
	}
	changeSet.identityEvidence.unshift(...collectLocalRenameEvidence(changes));
	ensureRenameEndpointObservations(changeSet.observations, changeSet.identityEvidence);
	await confirmUnknownRenameEndpoints(changeSet, deps.localFs, deps.remoteFs);
	await confirmRenameOppositeEndpoints(
		changeSet.observations,
		changeSet.identityEvidence,
		deps.localFs,
		deps.remoteFs,
	);

	// WARM/COLD listings can under-report. Confirm every baseline path whose current
	// side is missing before planning; a thrown stat aborts rather than becoming absence.
	if (changeSet.temperature !== "hot") {
		await confirmEntryAbsences(changeSet, deps.localFs, deps.remoteFs);
	}
	await confirmCaseAliasParentEndpoints(
		changeSet.observations, deps.localFs, deps.remoteFs,
	);
	await captureAliasCollisionContents(
		changeSet.entries, changeSet.observations, changeSet.identityEvidence, deps.localFs, deps.remoteFs,
	);
	// Hash enrichment operates only on exact entries and cannot upgrade observations.
	changeSet.hashEnrichment = await enrichHashesForInitialMatch(changeSet.entries, deps.localFs);
	await enrichHashesForRenames(
		changeSet.entries, changeSet.observations, deps.localFs, deps.remoteFs, changeSet.identityEvidence,
	);
	const candidateEvidence = completeIdentityEvidence(
		changeSet.identityEvidence,
		changeSet.observations,
		changeSet.entries,
	);
	const candidateFacts = await observeDirectConflictCandidates(
		changeSet.entries, changeSet.observations, candidateEvidence,
		deps.localFs, deps.remoteFs,
	);
	const candidateBaselines = await deps.stateStore.getMany(candidateFacts.map((fact) => fact.requestedPath));
	changeSet.candidateFacts = candidateFacts.map((fact) => ({
		...fact, baseline: candidateBaselines.get(fact.requestedPath) ?? null,
	}));
	changeSet.identityEvidence = completeIdentityEvidence(
		changeSet.identityEvidence,
		changeSet.observations,
		changeSet.entries,
	);

	return changeSet;
}

async function collectHot(
	deps: ChangeDetectorDeps,
	remoteChanges: RemoteChanges,
): Promise<ChangeSet> {
	const { localFs, remoteFs, stateStore, changes } = deps;

	const dirtyPaths = changes.dirtyPaths;

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
	const observations: PathObservation[] = [];

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const localStat = localStats[i] ?? undefined;
		const localObservation = observePath(
			"local",
			path,
			localStat,
		);
		const remoteObservation = observePath(
			"remote", path, remoteStats[i],
			remoteChanges.deletedPaths.has(path) ? "checkpoint_deleted" : "stat",
		);
		observations.push(localObservation, remoteObservation);
		const prevSync = syncRecords.get(path);
		return {
			path,
			local: resolvedEntity(localObservation),
			remote: resolvedEntity(remoteObservation),
			prevSync,
		};
	});

	// Acquisition retains all facts it obtained. Admission owns no-change and
	// deletion decisions, including whether stat absence has deletion authority.
	return {
		entries, observations, candidateFacts: [],
		identityEvidence: remoteChanges.renameEvidence, temperature: "hot",
	};
}

async function collectWarm(
	deps: ChangeDetectorDeps,
	allRecords: SyncRecord[],
	prefetchedRemoteChanges?: RemoteChanges,
): Promise<ChangeSet> {
	const { localFs, remoteFs } = deps;

	const [localFiles, remoteChanges] = await Promise.all([
		localFs.list(),
		prefetchedRemoteChanges ?? getRemoteChanges(remoteFs, deps.onRemoteIdentityEvidence),
	]);
	if (hasFolderRename(remoteChanges)) {
		deps.logger?.debug("WARM escalated to COLD", {
			reason: "remote_folder_rename",
			renamePairs: remoteChanges.renameEvidence
				.filter((item) => item.isFolder)
				.map((item) => `${item.oldPath} -> ${item.newPath}`),
		});
		return collectCold(
			deps,
			allRecords,
			remoteChanges,
			localFiles,
			await remoteSnapshotAfterDelta(remoteFs),
		);
	}
	const missingLocalFolders = allRecords
		.filter((record) => record.isDirectory && !localFiles.some((file) => file.path === record.path))
		.map((record) => record.path);
	if (missingLocalFolders.length > 0) {
		// A previously-tracked folder is gone locally. Propagating that to remote
		// (delete_remote) needs remote-descendant completeness that WARM's targeted
		// stats can't prove — escalate, mirroring the folder-rename case above.
		deps.logger?.debug("WARM escalated to COLD", {
			reason: "tracked_folder_missing_locally", paths: missingLocalFolders,
		});
		return collectCold(
			deps,
			allRecords,
			remoteChanges,
			localFiles,
			await remoteSnapshotAfterDelta(remoteFs),
		);
	}

	const recordMap = new Map(allRecords.map((r) => [r.path, r]));
	const changedPaths = new Set<string>();
	// A deterministic preservation sibling is only a bounded acquisition hint.
	// Re-observe it and its base; Admission still requires a current base alias
	// and byte-consistent candidate facts before treating it as subordinate.
	for (const path of [
		...allRecords.map((record) => record.path),
		...localFiles.filter((file) => !file.isDirectory).map((file) => file.path),
	]) {
		const hint = directConflictCandidateHint(path);
		if (!hint) continue;
		changedPaths.add(path);
		changedPaths.add(hint.basePath);
	}

	// Compare local listing against sync records
	for (const file of localFiles) {
		const record = recordMap.get(file.path);
		if (!record || hasChanged(file, record)) {
			changedPaths.add(file.path);
		}
	}

	// Include paths that existed in records but are no longer in local listing (local deletions)
	const localPathSet = new Set(localFiles.map((f) => f.path));
	for (const record of allRecords) {
		if (!localPathSet.has(record.path)) {
			changedPaths.add(record.path);
		}
	}

	// Add remote changed paths
	for (const p of remoteChanges.paths) {
		changedPaths.add(p);
	}

	// Include rename pair paths so warm mode can optimize renames. A folder rename
	// pair must be included too — otherwise a folder rename report that resurfaces
	// after its relation already settled (e.g. the vault's own "rename" event
	// echoing back the sync engine's prior programmatic rename_local/rename_remote,
	// which Obsidian cannot distinguish from a user-initiated rename) never becomes
	// an entry, so its existing SyncRecord baseline never reaches Admission's
	// current facts — producing a spurious unbaselined "match" that fails
	// publication because a real record already exists (see ADR 0009).
	for (const [newPath, oldPath] of [...deps.changes.renamePairs, ...deps.changes.folderRenamePairs]) {
		changedPaths.add(newPath);
		changedPaths.add(oldPath);
	}

	const pathArray = Array.from(changedPaths);
	const remoteStats = await Promise.all(pathArray.map((p) => remoteFs.stat(p)));

	const observations: PathObservation[] = localFiles.map((file) =>
		observePath("local", file.path, file, "stat", "list"));
	const localFileMap = new Map(observations.flatMap((observation) => {
		const entity = resolvedEntity(observation);
		return entity ? [[entity.path, entity] as const] : [];
	}));

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const remoteObservation = observePath(
			"remote", path, remoteStats[i],
			remoteChanges.deletedPaths.has(path) ? "checkpoint_deleted" : "stat",
		);
		observations.push(remoteObservation);
		if (!observations.some((observation) =>
			observation.side === "local" && observation.requestedPath === path)) {
			observations.push({ kind: "unknown", side: "local", requestedPath: path, reason: "not_observed" });
		}
		return {
			path,
			local: localFileMap.get(path),
			remote: resolvedEntity(remoteObservation),
			prevSync: recordMap.get(path),
		};
	});

	return {
		entries, observations, candidateFacts: [],
		identityEvidence: remoteChanges.renameEvidence, temperature: "warm",
	};
}

async function collectCold(
	deps: ChangeDetectorDeps,
	allRecords: SyncRecord[],
	remoteChanges?: RemoteChanges,
	prefetchedLocalFiles?: FileEntity[],
	prefetchedRemoteFiles?: FileEntity[],
): Promise<ChangeSet> {
	const { localFs, remoteFs } = deps;

	const [localFiles, remoteFiles] = await Promise.all([
		prefetchedLocalFiles ?? localFs.list(),
		prefetchedRemoteFiles ?? remoteFs.list(),
	]);
	const syncRecords = allRecords;

	const pathMap = new Map<string, MixedEntity>();
	const observations: PathObservation[] = [];

	const getOrCreate = (path: string): MixedEntity => {
		let entity = pathMap.get(path);
		if (!entity) {
			entity = { path };
			pathMap.set(path, entity);
		}
		return entity;
	};

	for (const file of localFiles) {
		const observation = observePath("local", file.path, file, "stat", "list");
		observations.push(observation);
		const entity = resolvedEntity(observation);
		if (entity) getOrCreate(entity.path).local = entity;
	}

	for (const file of remoteFiles) {
		const observation = observePath("remote", file.path, file, "stat", "list");
		observations.push(observation);
		const entity = resolvedEntity(observation);
		if (entity) getOrCreate(entity.path).remote = entity;
	}

	for (const record of syncRecords) {
		getOrCreate(record.path).prevSync = record;
	}

	return {
		entries: Array.from(pathMap.values()),
		observations,
		candidateFacts: [],
		identityEvidence: remoteChanges?.renameEvidence ?? [],
		temperature: "cold",
	};
}
