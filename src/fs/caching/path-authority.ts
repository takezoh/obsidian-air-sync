import type { PathAuthority } from "../types";

interface PathAuthorityContext<TFile> {
	rootFolderId: string;
	byId: ReadonlyMap<string, TFile>;
	extractId: (file: TFile) => string;
	extractParentIds: (file: TFile) => string[];
	resolved: Map<string, PathAuthority>;
}

/** Resolve whether a backend parent chain reaches the configured sync root. */
export function resolvePathAuthority<TFile>(
	file: TFile,
	context: PathAuthorityContext<TFile>,
	visiting: Set<string>,
): PathAuthority {
	const id = context.extractId(file);
	const cached = context.resolved.get(id);
	if (cached !== undefined) return cached;
	if (visiting.has(id)) return "requested_echo";

	const parents = context.extractParentIds(file);
	const parentId = parents.includes(context.rootFolderId)
		? context.rootFolderId
		: parents.find((candidate) => context.byId.has(candidate));
	if (!parentId || parentId === id) return remember(context.resolved, id, "requested_echo");
	if (parentId === context.rootFolderId) return remember(context.resolved, id, "actual_resolved");

	const parent = context.byId.get(parentId);
	if (!parent) return remember(context.resolved, id, "requested_echo");
	visiting.add(id);
	const authority = resolvePathAuthority(parent, context, visiting);
	visiting.delete(id);
	return remember(context.resolved, id, authority);
}

function remember(
	resolved: Map<string, PathAuthority>,
	id: string,
	authority: PathAuthority,
): PathAuthority {
	resolved.set(id, authority);
	return authority;
}
