import type { IFileSystem } from "../fs/interface";
import type { IdentityEvidence, MixedEntity, PathObservation } from "./types";
import { hasRemoteChanged } from "./change-compare";
import { observePath } from "./path-observation";
import { sha256 } from "../utils/hash";

/**
 * Recover only a file-level case rename proved by the current snapshot. The
 * baseline-free branch is deliberately stricter because no historical
 * relation survives a schema cold-start.
 */
export async function inferCurrentStateLocalCaseRenames(
	entries: readonly MixedEntity[],
	observations: PathObservation[],
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<IdentityEvidence[]> {
	const inferred = inferBaselineRenames(entries);
	const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
	const remoteIdentityCounts = countRemoteIdentities(entries);
	const baselineFreeCandidates = observations.flatMap((item) => {
		if (item.kind !== "alias" || item.side !== "local" ||
			item.requestedPath === item.resolvedPath ||
			item.requestedPath.toLowerCase() !== item.resolvedPath.toLowerCase()) return [];
		const source = entriesByPath.get(item.requestedPath);
		const target = entriesByPath.get(item.resolvedPath);
		const identityKey = source?.remote?.identityKey;
		if (!source?.remote || source.local || source.prevSync || !target?.local ||
			target.remote || target.prevSync || !identityKey ||
			remoteIdentityCounts.get(identityKey) !== 1) return [];
		return hasRequiredEndpoints(observations, source.path, target.path)
			? [{ source, target }]
			: [];
	});
	for (const { source, target } of baselineFreeCandidates) {
		const [localContent, remoteContent] = await Promise.all([
			localFs.read(target.path),
			remoteFs.read(source.path),
		]);
		if (!sameBytes(localContent, remoteContent)) continue;
		const hash = await sha256(localContent);
		target.local = { ...target.local!, hash };
		source.remote = { ...source.remote!, hash };
		replaceObservation(observations, observePath("local", target.path, target.local));
		replaceObservation(observations, observePath("remote", source.path, source.remote));
		inferred.push(renameEvidence(source.path, target.path));
	}
	return inferred;
}

function inferBaselineRenames(entries: readonly MixedEntity[]): IdentityEvidence[] {
	const localByFoldedPath = new Map<string, MixedEntity[]>();
	for (const entry of entries) {
		if (!entry.local || entry.path === entry.prevSync?.path) continue;
		const key = entry.path.toLowerCase();
		const candidates = localByFoldedPath.get(key) ?? [];
		candidates.push(entry);
		localByFoldedPath.set(key, candidates);
	}
	const inferred: IdentityEvidence[] = [];
	for (const source of entries) {
		const baseline = source.prevSync;
		if (!baseline || source.local || !source.remote ||
			hasRemoteChanged(source.remote, baseline) ||
			(baseline.remoteIdentityKey &&
				source.remote.identityKey !== baseline.remoteIdentityKey)) continue;
		const candidates = (localByFoldedPath.get(baseline.path.toLowerCase()) ?? [])
			.filter((target) => target.path !== baseline.path &&
				target.path.toLowerCase() === baseline.path.toLowerCase() && !target.remote);
		if (candidates.length === 1) {
			inferred.push(renameEvidence(baseline.path, candidates[0]!.path));
		}
	}
	return inferred;
}

function countRemoteIdentities(entries: readonly MixedEntity[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		const identityKey = entry.remote?.identityKey;
		if (identityKey) counts.set(identityKey, (counts.get(identityKey) ?? 0) + 1);
	}
	return counts;
}

function hasRequiredEndpoints(
	observations: readonly PathObservation[],
	oldPath: string,
	newPath: string,
): boolean {
	return observations.some((item) => item.kind === "exact" && item.side === "local" &&
		item.requestedPath === newPath) &&
		observations.some((item) => item.kind === "exact" && item.side === "remote" &&
			item.requestedPath === oldPath) &&
		observations.some((item) => item.kind === "absent" && item.side === "remote" &&
			item.requestedPath === newPath && item.authority === "stat");
}

function renameEvidence(oldPath: string, newPath: string): IdentityEvidence {
	return {
		kind: "rename", side: "local", oldPath, newPath,
		isFolder: false, authority: "current_state",
	};
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const leftBytes = new Uint8Array(left);
	const rightBytes = new Uint8Array(right);
	for (let index = 0; index < leftBytes.length; index += 1) {
		if (leftBytes[index] !== rightBytes[index]) return false;
	}
	return true;
}

function replaceObservation(
	observations: PathObservation[],
	replacement: PathObservation,
): void {
	for (let index = 0; index < observations.length; index += 1) {
		const current = observations[index]!;
		if (current.side === replacement.side &&
			current.requestedPath === replacement.requestedPath) {
			observations[index] = replacement;
		}
	}
}
