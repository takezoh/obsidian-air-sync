import type { RenameEvidence } from "./types";

type ReportSelection =
	| {
		readonly kind: "reported";
		readonly reports: readonly RenameEvidence[];
		readonly governingReports: readonly RenameEvidence[];
	}
	| { readonly kind: "none" }
	| { readonly kind: "conflicting" };

/** Classify raw reports without shaping actions or authorizing a result. */
export function selectReportFamily(reports: readonly RenameEvidence[]): ReportSelection {
	const unique = new Map<string, RenameEvidence>();
	for (const report of reports) {
		unique.set([
			report.side, report.oldPath, report.newPath,
			report.isFolder ? "folder" : "file", report.identityKey ?? "",
		].join("\0"), report);
	}
	const selected = [...unique.values()];
	const governingReports: RenameEvidence[] = [];
	for (const side of ["local", "remote"] as const) {
		const claims = selected.filter((report) => report.side === side);
		const targetsBySource = new Map<string, Set<string>>();
		const sourcesByTarget = new Map<string, Set<string>>();
		const edgesByIdentity = new Map<string, Set<string>>();
		const identitiesByEdge = new Map<string, Set<string>>();
		for (const claim of claims) {
			addToSet(targetsBySource, claim.oldPath, claim.newPath);
			addToSet(sourcesByTarget, claim.newPath, claim.oldPath);
			if (claim.identityKey) {
				addToSet(edgesByIdentity, claim.identityKey, `${claim.oldPath}\0${claim.newPath}`);
				addToSet(identitiesByEdge, `${claim.oldPath}\0${claim.newPath}`, claim.identityKey);
			}
		}
		const root = shallowestFolderRoot(claims);
		if ([...targetsBySource.values(), ...sourcesByTarget.values()]
			.some((values) => values.size > 1)) return { kind: "conflicting" };
		if (root) {
			if (claims.some((claim) => !sameRename(root, claim) &&
				!isAlignedDescendant(root, claim))) return { kind: "conflicting" };
			governingReports.push(root);
		}
		if ([...edgesByIdentity.values(), ...identitiesByEdge.values()]
			.some((values) => values.size > 1)) {
			return { kind: "conflicting" };
		}
		if (!root) {
			if (claims.length > 1) return { kind: "conflicting" };
			if (claims.length === 1) governingReports.push(claims[0]!);
		}
	}
	const localClaims = selected.filter((report) => report.side === "local");
	const remoteClaims = selected.filter((report) => report.side === "remote");
	if (localClaims.length > 0 && remoteClaims.length > 0) {
		const sharedSources = new Set(selected.map((report) => report.oldPath));
		if (sharedSources.size !== 1 || selected.some((report) => report.isFolder)) {
			return { kind: "conflicting" };
		}
	}
	return selected.length > 0
		? { kind: "reported", reports: selected, governingReports }
		: { kind: "none" };
}

function shallowestFolderRoot(claims: readonly RenameEvidence[]): RenameEvidence | undefined {
	let selected: RenameEvidence | undefined;
	for (const claim of claims) {
		if (!claim.isFolder) continue;
		if (!selected || compareRoot(claim, selected) < 0) selected = claim;
	}
	return selected;
}

function compareRoot(left: RenameEvidence, right: RenameEvidence): number {
	const depth = pathDepth(left.oldPath) - pathDepth(right.oldPath);
	return depth || left.oldPath.localeCompare(right.oldPath) || left.newPath.localeCompare(right.newPath);
}

function pathDepth(path: string): number {
	let depth = 1;
	for (const character of path) if (character === "/") depth++;
	return depth;
}

function addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
	const values = map.get(key) ?? new Set<string>();
	values.add(value);
	map.set(key, values);
}

function sameRename(left: RenameEvidence, right: RenameEvidence): boolean {
	return left.side === right.side && left.oldPath === right.oldPath &&
		left.newPath === right.newPath && left.isFolder === right.isFolder &&
		left.identityKey === right.identityKey;
}

function isAlignedDescendant(root: RenameEvidence, child: RenameEvidence): boolean {
	const oldPrefix = `${root.oldPath}/`;
	const newPrefix = `${root.newPath}/`;
	return child.oldPath.startsWith(oldPrefix) && child.newPath.startsWith(newPrefix) &&
		child.oldPath.slice(oldPrefix.length) === child.newPath.slice(newPrefix.length);
}
