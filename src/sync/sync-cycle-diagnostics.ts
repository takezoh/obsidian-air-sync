import type { Logger } from "../logging/logger";
import type { ChangeSet } from "./change-detector";
import type { MixedEntity, ScopeProjection } from "./types";

/**
 * What a sync cycle reports about itself.
 *
 * Kept apart from `sync-cycle-planning` because it decides nothing: every
 * function here reads facts the cycle already established and writes them to the
 * log. Nothing in this module may influence what the cycle does.
 *
 * The shared rule is that a payload costing more than a constant — a per-path
 * array, a set, a projection over every entry — is built inside
 * `logger.enabled(...)`, never before it. `Logger.log()` consults the logging
 * settings only after its argument has been evaluated, so an unguarded caller
 * pays the full price on every cycle for a line nobody will read. On a cold
 * reconcile that price is the whole vault.
 */

/**
 * How many dropped paths a scoped cycle lists. A user chasing one file needs a
 * sample, not the transcript of a cold reconcile that excluded everything.
 */
const EXCLUDED_PATH_LOG_CAP = 25;

export function logChangeDetection(
	changeSet: ChangeSet,
	renamePairs: ReadonlyMap<string, string>,
	logger?: Logger,
	visiblePaths?: ReadonlySet<string>,
): void {
	const entries = visiblePaths
		? changeSet.entries.filter((entry) => visiblePaths.has(entry.path))
		: changeSet.entries;
	// Only the count is needed unconditionally; the paths themselves are built
	// under the debug guard below.
	const remoteOnlyEntries = entries.filter((entry) => !entry.local && entry.remote);
	logger?.info("Change detection completed", {
		temperature: changeSet.temperature,
		entries: entries.length,
		localOnly: entries.filter((entry) => entry.local && !entry.remote).length,
		remoteOnly: remoteOnlyEntries.length,
		both: entries.filter((entry) => entry.local && entry.remote).length,
		enriched: entries.filter((entry) => entry.local?.hash && !entry.prevSync).length,
		hashEnrichmentCandidates: changeSet.hashEnrichment?.candidates ?? 0,
		hashEnrichmentMatches: changeSet.hashEnrichment?.matches ?? 0,
		renamePairs: renamePairs.size,
	});
	if (!logger?.enabled("debug")) return;

	if (remoteOnlyEntries.length > 0) {
		logger.debug("Remote-only paths", { paths: remoteOnlyEntries.map((entry) => entry.path) });
	}
	logUnresolvedObservations(changeSet, logger);
	logRenameEntryDetails(changeSet, renamePairs, logger);
}

/**
 * The objects the provider returned that never became facts.
 *
 * `resolvedEntity()` (path-observation.ts) turns an observation into a
 * `MixedEntity.local`/`.remote` fact only for kind `"exact"`. An `"alias"` or
 * `"present_unresolved"` observation means the object is genuinely present and
 * still produces no entry at all — so there is nothing for `applyScope` or
 * "Excluded paths" to even see, and no signal anywhere. `"absent"` and
 * `"unknown"` are ordinary and expected every cycle, so they stay out: the point
 * is to answer "why does this specific object never become a sync fact"
 * directly, rather than inferring it from a gap between two counts.
 */
function logUnresolvedObservations(changeSet: ChangeSet, logger: Logger): void {
	const unresolved = changeSet.observations.filter((item) =>
		item.kind === "alias" || item.kind === "present_unresolved");
	if (unresolved.length === 0) return;
	logger.debug("Unresolved observations", {
		items: unresolved.map((item) => ({
			side: item.side, kind: item.kind, requestedPath: item.requestedPath,
			...(item.kind === "alias" ? { resolvedPath: item.resolvedPath } : {}),
			...(item.kind === "present_unresolved"
				? { returnedPath: item.returnedPath, source: item.source, pathAuthority: item.entity.pathAuthority }
				: {}),
		})),
	});
}

function logRenameEntryDetails(
	changeSet: ChangeSet,
	renamePairs: ReadonlyMap<string, string>,
	logger: Logger,
): void {
	if (renamePairs.size === 0) return;
	const paths = new Set([...renamePairs.keys(), ...renamePairs.values()]);
	logger.debug("Rename entry details", {
		entries: changeSet.entries.filter((entry) => paths.has(entry.path)).map((entry) => ({
			path: entry.path,
			local: !!entry.local,
			remote: !!entry.remote,
			prevSync: !!entry.prevSync,
			hash: (entry.local?.hash || entry.prevSync?.hash || "").substring(0, 8) || undefined,
		})),
	});
}

/**
 * Which raw entries the cycle dropped, and by which of the two gates.
 *
 * `applyScope`'s own ignore-pattern / dot-path / wholly-ignored-directory check
 * drops an entry before it ever reaches `scopedChangeSet.entries`. The
 * `byEndpoint` disposition check drops one that survived `applyScope` but
 * resolved to something other than `"included"`. Naming the path and which of
 * the two happened — and, for the second, the actual disposition — turns "why
 * isn't this syncing" from count arithmetic into a direct answer.
 */
export function logScopeExclusions(
	rawEntries: readonly MixedEntity[],
	scopedEntries: readonly MixedEntity[],
	admittedEntries: readonly MixedEntity[],
	projection: ScopeProjection,
	logger?: Logger,
): void {
	if (admittedEntries.length === rawEntries.length) return;
	logger?.debug("Files filtered", {
		total: rawEntries.length,
		afterFilter: admittedEntries.length,
		excluded: rawEntries.length - admittedEntries.length,
	});
	if (!logger?.enabled("debug")) return;

	const admittedPaths = new Set(admittedEntries.map((entry) => entry.path));
	const scopedPaths = new Set(scopedEntries.map((entry) => entry.path));
	const dropped: { path: string; reason: string }[] = [];
	for (const entry of rawEntries) {
		if (dropped.length === EXCLUDED_PATH_LOG_CAP) break;
		if (admittedPaths.has(entry.path)) continue;
		dropped.push({
			path: entry.path,
			reason: scopedPaths.has(entry.path)
				? `disposition:${projection.byEndpoint.get(entry.path) ?? "unknown"}`
				: "excluded_from_scope",
		});
	}
	logger.debug("Excluded paths", { paths: dropped });
}
