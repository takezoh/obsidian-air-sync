import type { MixedEntity, StandardSyncAction } from "./types";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import { sameContent } from "./content-identity";

/** Content/baseline comparison only; Admission has already bound endpoint identity. */
export function compareContent(entry: Readonly<MixedEntity>): StandardSyncAction["action"] | null {
	const { local, remote, prevSync } = entry;
	if (prevSync) {
		if (local && remote) {
			const localDiff = hasChanged(local, prevSync);
			const remoteDiff = hasRemoteChanged(remote, prevSync);
			if ((localDiff || remoteDiff) && local.size === remote.size && sameContent(local, remote)) return "match";
			if (localDiff && remoteDiff) return "conflict";
			if (localDiff) return "push";
			if (remoteDiff) return "pull";
			return null;
		}
		if (local) return hasChanged(local, prevSync) ? "conflict" : "delete_local";
		if (remote) return hasRemoteChanged(remote, prevSync) ? "conflict" : "delete_remote";
		return "cleanup";
	}
	if (local && !remote) return "push";
	if (!local && remote) return "pull";
	if (local && remote) return local.size === remote.size && sameContent(local, remote) ? "match" : "conflict";
	return null;
}
