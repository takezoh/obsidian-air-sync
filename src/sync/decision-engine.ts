import type { MixedEntity, SyncAction, SyncPlan } from "./types";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import { sameContent } from "./content-identity";

export function planSync(entries: MixedEntity[]): SyncPlan {
	const actions: SyncAction[] = [];

	for (const entry of entries) {
		const action = decideAction(entry);
		if (action !== null) {
			actions.push(action);
		}
	}

	return { actions };
}

function decideAction(entry: MixedEntity): SyncAction | null {
	const { path, local, remote, prevSync } = entry;
	const base = { path, local, remote, baseline: prevSync };

	if (prevSync) {
		if (local && remote) {
			const localDiff = hasChanged(local, prevSync);
			const remoteDiff = hasRemoteChanged(remote, prevSync);

			if (localDiff && remoteDiff) {
				return { ...base, action: "conflict" };
			}
			if (localDiff) {
				return { ...base, action: "push" };
			}
			if (remoteDiff) {
				return { ...base, action: "pull" };
			}
			return null;
		}

		if (local && !remote) {
			if (hasChanged(local, prevSync)) {
				return { ...base, action: "conflict" };
			}
			return { ...base, action: "delete_local" };
		}

		if (!local && remote) {
			if (hasRemoteChanged(remote, prevSync)) {
				return { ...base, action: "conflict" };
			}
			return { ...base, action: "delete_remote" };
		}

		// Neither exists but baseline exists → both deleted
		return { ...base, action: "cleanup" };
	}

	// No baseline
	if (local && !remote) {
		return { ...base, action: "push" };
	}

	if (!local && remote) {
		return { ...base, action: "pull" };
	}

	if (local && remote) {
		// Provably-identical content (via hash or a same-algo remoteChecksum) is a
		// no-op match; the size guard rejects the degenerate hash-collision case.
		if (sameContent(local, remote) && local.size === remote.size) {
			return { ...base, action: "match" };
		}
		return { ...base, action: "conflict" };
	}

	return null;
}
