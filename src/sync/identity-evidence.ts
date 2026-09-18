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
	// The producing filesystem's own projected identity for `newPath` is carried through
	// intact. A pair that carries none adds nothing: an absent key is ADR 0008's third
	// state — no evidence — and nothing here infers one from an address.
	return dedupeRenameEvidence(pairs.map(({ oldPath, newPath, isFolder, identityKey }): RenameEvidence => ({
		kind: "rename", side: "remote", oldPath, newPath, isFolder: isFolder === true, authority: "reported",
		...(identityKey === undefined ? {} : { identityKey }),
	})));
}

/**
 * Two claims on one edge that name different objects are two claims, not one. The key
 * therefore tags the identity rather than folding it: `absent` is a token no carried
 * value can spell, because a carried value always appears behind `present`, so an
 * absent key, an empty key and a carried key are three distinct entries and `Map.set`
 * cannot drop one of a conflicting pair before the report family can see it.
 *
 * This is this module's *encoding* rule and deliberately not the record layer's
 * *admissibility* rule, where an absent and an empty provider identity are one
 * inadmissible case. Different layers, different questions; do not unify them.
 */
function renameEvidenceKey(evidence: RenameEvidence): string {
	const identity = evidence.identityKey === undefined
		? "absent"
		: `present\0${evidence.identityKey}`;
	return `${evidence.side}\0${evidence.oldPath}\0${evidence.newPath}\0${evidence.isFolder}\0${identity}`;
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
	// A remote rename claim keeps exactly the identity its producer carried. Nothing is
	// attached from the destination address: a key read back out of `currentRemote` is
	// the current occupant's own, so the downstream check would be comparing a value to
	// its own source. `currentRemote` survives only as the occurrence index's input.
	const completed: IdentityEvidence[] = [...reported];

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
		if (entry.prevSync) {
			appendOccurrence(byIdentity, entry.prevSync.remoteIdentityKey, {
				side: "remote", phase: "baseline", path: entry.prevSync.path,
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
		unique.set(renameEvidenceKey(item), item);
	}
	return [...unique.values()];
}
