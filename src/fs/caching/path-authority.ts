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

/** Project stored entry authority through any unresolved cached ancestor. */
export function resolveCachedPathAuthority(
	path: string,
	entries: ReadonlyMap<string, unknown>,
	authorities: ReadonlyMap<string, PathAuthority>,
): PathAuthority {
	if (!entries.has(path)) return "requested_echo";
	let current = path;
	while (current) {
		if (entries.has(current) && resolveStoredPathAuthority(current, authorities) === "requested_echo") {
			return "requested_echo";
		}
		const separator = current.lastIndexOf("/");
		current = separator === -1 ? "" : current.substring(0, separator);
	}
	return "actual_resolved";
}

export function resolveStoredPathAuthority(
	path: string, authorities: ReadonlyMap<string, PathAuthority>,
): PathAuthority {
	return authorities.get(path) ?? "requested_echo";
}
