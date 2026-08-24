import type { RenamePair } from "../fs/types";
import type { EntityOccurrence, IdentityEvidence, MixedEntity, PathObservation, RenameEvidence } from "./types";
import type { TrackerSnapshot } from "./local-tracker";

export function collectLocalRenameEvidence(changes: TrackerSnapshot): RenameEvidence[] {
	return dedupeRenameEvidence([
		...[...changes.renamePairs].map(([newPath, oldPath]): RenameEvidence => ({
			kind: "rename", side: "local", oldPath, newPath, isFolder: false, authority: "reported",
		})),
		...[...changes.folderRenamePairs].map(([newPath, oldPath]): RenameEvidence => ({
			kind: "rename", side: "local", oldPath, newPath, isFolder: true, authority: "reported",
		})),
	]);
}

export function collectRemoteRenameEvidence(pairs: readonly RenamePair[]): RenameEvidence[] {
	return dedupeRenameEvidence(pairs.map(({ oldPath, newPath, isFolder }): RenameEvidence => ({
		kind: "rename", side: "remote", oldPath, newPath, isFolder: isFolder === true, authority: "reported",
	})));
}

export function renameOptimizerView(evidence: readonly IdentityEvidence[]): {
	localFiles: ReadonlyMap<string, string>;
	localFolders: ReadonlyMap<string, string>;
	remote: RenamePair[];
} {
	const localFiles = new Map<string, string>();
	const localFolders = new Map<string, string>();
	const remote: RenamePair[] = [];
	for (const item of evidence) {
		if (item.kind !== "rename") continue;
		if (item.side === "remote") {
			remote.push({ oldPath: item.oldPath, newPath: item.newPath, isFolder: item.isFolder || undefined });
		} else {
			(item.isFolder ? localFolders : localFiles).set(item.newPath, item.oldPath);
		}
	}
	return { localFiles, localFolders, remote };
}

export function completeIdentityEvidence(
	reported: readonly IdentityEvidence[],
	observations: readonly PathObservation[],
	entries: readonly MixedEntity[],
): IdentityEvidence[] {
	const currentRemote = new Map<string, string>();
	for (const observation of observations) {
		if (observation.side !== "remote" ||
			(observation.kind !== "exact" && observation.kind !== "alias")) continue;
		const path = observation.kind === "alias" ? observation.resolvedPath : observation.requestedPath;
		if (observation.entity.identityKey) currentRemote.set(path, observation.entity.identityKey);
	}
	for (const entry of entries) {
		if (entry.remote?.identityKey) currentRemote.set(entry.path, entry.remote.identityKey);
	}
	const completed = reported.map((item): IdentityEvidence =>
		item.kind === "rename" && item.side === "remote" && !item.identityKey
			? { ...item, identityKey: currentRemote.get(item.newPath) }
			: item);

	for (const observation of observations) {
		if (observation.kind === "alias") {
			completed.push({
				kind: "alias", side: observation.side, requestedPath: observation.requestedPath,
				resolvedPath: observation.resolvedPath,
			});
		}
	}

	const byIdentity = new Map<string, EntityOccurrence[]>();
	for (const entry of entries) {
		if (entry.prevSync?.remoteIdentityKey) {
			appendOccurrence(byIdentity, entry.prevSync.remoteIdentityKey, {
				side: "remote", phase: "baseline", path: entry.path,
				identityKey: entry.prevSync.remoteIdentityKey,
			});
		}
	}
	for (const [path, identityKey] of currentRemote) {
		appendOccurrence(byIdentity, identityKey, {
			side: "remote", phase: "current", path, identityKey,
		});
	}
	for (const [identityKey, occurrences] of byIdentity) {
		if (new Set(occurrences.map((occurrence) => occurrence.path)).size > 1) {
			completed.push({ kind: "stable_identity", side: "remote", identityKey, occurrences });
		}
	}
	return completed;
}

function appendOccurrence(
	byIdentity: Map<string, EntityOccurrence[]>,
	identityKey: string,
	occurrence: EntityOccurrence,
): void {
	const occurrences = byIdentity.get(identityKey) ?? [];
	occurrences.push(occurrence);
	byIdentity.set(identityKey, occurrences);
}

function dedupeRenameEvidence(evidence: RenameEvidence[]): RenameEvidence[] {
	const unique = new Map<string, RenameEvidence>();
	for (const item of evidence) {
		unique.set(JSON.stringify([item.side, item.oldPath, item.newPath, item.isFolder]), item);
	}
	return [...unique.values()];
}
