import type { AirSyncSettings } from "../settings";
import { sha256 } from "../utils/hash";

/**
 * A hash of every setting that determines which paths are in sync scope
 * (`SyncOrchestrator.isExcluded`): the config-sync toggles, `syncDotPaths`,
 * `ignorePatterns`, the effective mobile byte limit (or null on desktop), plus
 * `configDir`/`pluginId` since `getEffectiveSyncDotPaths`/
 * `getEffectiveIgnorePatterns` fold them in when config sync is on. Compared
 * against the committed checkpoint's fingerprint so a scope-widening settings
 * change forces one cold reconcile — see `computeScopeFingerprint`'s caller in
 * `SyncOrchestrator.runSync` for why: the delta cursor only reports paths
 * changed since it started, so a remote file that was always out of scope (and
 * so never touched by a `getChangedPaths` batch) never surfaces via warm/hot
 * detection once its path enters scope.
 *
 * `syncDotPaths` is sorted (it's a set); `ignorePatterns` is NOT sorted — order
 * is significant for gitignore's last-match-wins semantics, so a reorder is
 * itself a scope change.
 */
export async function computeScopeFingerprint(
	settings: AirSyncSettings,
	configDir: string,
	pluginId: string,
	effectiveMobileMaxBytes: number | null = null,
): Promise<string> {
	const canonical = JSON.stringify({
		enableConfigSync: settings.enableConfigSync,
		syncConfigJsonFiles: settings.syncConfigJsonFiles,
		syncConfigPlugins: settings.syncConfigPlugins,
		syncConfigSnippets: settings.syncConfigSnippets,
		syncConfigThemes: settings.syncConfigThemes,
		syncConfigIcons: settings.syncConfigIcons,
		syncDotPaths: [...settings.syncDotPaths].sort(),
		ignorePatterns: settings.ignorePatterns,
		configDir,
		pluginId,
		effectiveMobileMaxBytes,
	});
	return sha256(new TextEncoder().encode(canonical).buffer);
}
