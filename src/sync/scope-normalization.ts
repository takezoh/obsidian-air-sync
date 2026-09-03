import { projectRenameScope } from "./scope-projection";
import type { IdentityEvidence, RenameEvidence, ScopeProjection } from "./types";

/**
 * A folder rename is only an executable unit while every descendant has the
 * same scope consequence. When policy-excluded descendants coexist with
 * included files, the folder edge is structural evidence rather than an
 * executable operation: the included child edges are the complete authorized
 * units and excluded paths remain outside sync authority.
 */
export function partitionMixedScopeFolderEvidence(
	evidence: readonly IdentityEvidence[],
	scope: ScopeProjection,
): IdentityEvidence[] {
	const partitioned = evidence.filter((item): item is RenameEvidence =>
		item.kind === "rename" && item.isFolder &&
		isCompletelyRepresentedByIncludedChildren(item, evidence, scope));
	if (partitioned.length === 0) return [...evidence];

	const retained = evidence.filter((item) => {
		if (partitioned.includes(item as RenameEvidence)) return false;
		if (item.kind !== "alias") return true;
		return !partitioned.some((folder) => item.side === folder.side &&
			((item.requestedPath === folder.oldPath && item.resolvedPath === folder.newPath) ||
				(item.requestedPath === folder.newPath && item.resolvedPath === folder.oldPath)));
	});
	return deduplicateRenameEvidence(retained);
}

function deduplicateRenameEvidence(evidence: readonly IdentityEvidence[]): IdentityEvidence[] {
	const seen = new Set<string>();
	return evidence.filter((item) => {
		if (item.kind !== "rename") return true;
		const key = [
			item.side, item.oldPath, item.newPath, item.isFolder === true,
			item.identityKey ?? "", item.authority,
		].join("\0");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function isCompletelyRepresentedByIncludedChildren(
	folder: RenameEvidence,
	evidence: readonly IdentityEvidence[],
	scope: ScopeProjection,
): boolean {
	const rule = projectRenameScope(folder, scope);
	if (rule.consequence !== "defer" || rule.oldDisposition !== "included" ||
		rule.newDisposition !== "included") return false;

	const oldPrefix = `${folder.oldPath}/`;
	const newPrefix = `${folder.newPath}/`;
	const descendants = [...scope.byEndpoint].filter(([path]) =>
		path.startsWith(oldPrefix) || path.startsWith(newPrefix));
	if (descendants.some(([, disposition]) =>
		disposition === "unknown" || disposition === "mobile_deferred")) return false;
	if (!descendants.some(([, disposition]) => disposition === "policy_out")) return false;

	const childRenames = evidence.filter((item): item is RenameEvidence =>
		item.kind === "rename" && !item.isFolder && item.side === folder.side &&
		item.oldPath.startsWith(oldPrefix) && item.newPath.startsWith(newPrefix) &&
		item.oldPath.substring(oldPrefix.length) === item.newPath.substring(newPrefix.length) &&
		projectRenameScope(item, scope).consequence !== "defer");
	if (childRenames.length === 0) return false;

	const covered = new Set(childRenames.flatMap((item) => [item.oldPath, item.newPath]));
	return descendants.every(([path, disposition]) =>
		disposition === "policy_out" || covered.has(path));
}
