import type { RenamePair } from "../types";
import type { AbstractMetadataCache, AddressDisplacement, RelocatedEntry, WithheldClaim } from "./metadata-cache";
import { projectedIdentityKey } from "./metadata-cache";

/**
 * One normalized entry from a backend delta page. Each id-addressed backend maps
 * its own raw delta shape (Google Drive `changes`, OneDrive `/delta`) to this:
 *  - `file` present  ⇒ an upsert (add/modify/move) of that metadata;
 *  - `file` undefined ⇒ a tombstone (deletion) — `id` resolves the cached path.
 * A backend that wants to ignore a raw change (e.g. Google Drive's "no file and not
 * removed") simply omits it from the mapped array rather than emitting a tombstone.
 */
export interface IdDeltaEntry<TFile> {
	/** Backend id of the changed item (path lookup for sort + tombstone resolution). */
	id: string;
	/** Whether this entry is a folder — used only to order folders shallow-first. */
	isFolder: boolean;
	/** Upsert metadata, or undefined for a tombstone. */
	file: TFile | undefined;
}

/**
 * One contention this drain decided and has not yet withdrawn, plus the losing
 * object's own metadata when the drain has it, so a later page that frees the
 * address can readmit it.
 *
 * The entry is present for a claim the cache refused to write — the drain is
 * holding that claimant's metadata anyway — and absent for an occupant the cache
 * evicted, whose metadata the drain never received. It is held for the duration of
 * one drain and discarded with it: nothing here is persisted, read back by the
 * cache, or carried into another cycle.
 */
export interface StandingContention {
	/** The losing object's delta entry, or null when the drain never held one. */
	readonly entry: IdDeltaEntry<unknown> | null;
	/** The loss as it stands, refreshed every time the contention is re-tested. */
	readonly claim: WithheldClaim;
}

/** Accumulates the paths a delta touched, for the caller to classify and buffer. */
export interface IdDeltaResult {
	changedPaths: Set<string>;
	renamedPaths: RenamePair[];
	count: number;
	/**
	 * Ids of folders that gained a cached path during THIS delta application — a
	 * folder whose old cached path was undefined and whose new one resolved. It
	 * covers never-tracked, evicted-then-reentered, trash-restored, and
	 * ancestor-chain entry alike, because all four look the same at apply time.
	 *
	 * A provider whose delta reports only the changed item (Google Drive) sends no
	 * change for that folder's unchanged descendants, so those descendants are facts
	 * this page cannot carry. The Google Drive backend re-lists these ids after its
	 * drain; OneDrive's delta is already complete and never reads the set.
	 *
	 * Per-call bookkeeping only: it is discarded with the call, never persisted,
	 * never copied into `IncrementalChangesResult`, and never read by the cache.
	 * Insertion order is first-entry order, and re-entry within one drain collapses
	 * to one element. A claimant readmitted at settlement enters it there, which is
	 * why settlement closes a page before the caller walks its re-listing targets.
	 */
	enteredFolderIds: Set<string>;
	/**
	 * Every derived address this drain found claimed by two live ids, AS THE
	 * CONTENTION STANDS at the last page close — the address-level view.
	 *
	 * `displacedPaths` here is the complete set of cache paths that are absent
	 * *because* the loss stands: the path the loser vacated plus every descendant
	 * that went with it. That is the set an absence rule has to subtract, which is
	 * why it is published flattened rather than in the cache's two fields.
	 *
	 * Per-call bookkeeping in exactly the sense `enteredFolderIds` documents:
	 * discarded with the call, never persisted, never read back by the cache.
	 */
	displacements: readonly AddressDisplacement[];
	/**
	 * The same losses, claimant-level: each names the path the losing claimant
	 * vacated, separately from the descendants that went with it. A consumer that
	 * has to talk about the *object* that lost reads this; one that only has to
	 * subtract absent addresses reads {@link displacements}.
	 */
	withheld: readonly WithheldClaim[];
	/**
	 * Live bookkeeping for the two published views above, keyed by losing id. A
	 * contention observed mid-drain is not final: every later page close re-tests
	 * it against current facts, and a tombstone for the admitted id readmits the
	 * claimant and withdraws the contention before it is ever published.
	 */
	standing: Map<string, StandingContention>;
}

export function createIdDeltaResult(): IdDeltaResult {
	return {
		changedPaths: new Set<string>(),
		renamedPaths: [],
		count: 0,
		enteredFolderIds: new Set<string>(),
		displacements: [],
		withheld: [],
		standing: new Map<string, StandingContention>(),
	};
}

/**
 * Apply one page of id-addressed delta entries to the cache, accumulating the
 * touched paths. Shared by every backend whose delta is keyed on a stable backend
 * id (Google Drive, OneDrive). The move/rename classification and subtree removal
 * are identical across those backends and live here; each backend keeps only its
 * own pagination/cursor/410 wrapper and the raw→{@link IdDeltaEntry} mapping.
 *
 * Folders are applied shallow-first (by cached path depth) so a child path resolves
 * against an already-placed parent. `entries` is sorted IN PLACE — callers pass a
 * fresh per-page array (the backend's raw→IdDeltaEntry mapping), so no copy is needed.
 *
 * Every page CLOSES with settlement, so the contentions the drain publishes are the
 * ones that survive the facts it has seen so far. The applier is handed one page at
 * a time and cannot know which one is last, so it settles at every close; the last
 * close is therefore still the settlement point, and it happens before the caller
 * reads {@link IdDeltaResult.enteredFolderIds} to walk its re-listing targets.
 * Settling early cannot change an answer, because a claimant is only re-applied
 * when the address it lost is no longer held by the id that beat it — and when it
 * is re-applied it goes through the same arbitration, which is order-independent.
 */
export function applyIdDeltaPage<TFile>(
	cache: AbstractMetadataCache<TFile>,
	acc: IdDeltaResult,
	entries: IdDeltaEntry<TFile>[],
): void {
	entries.sort((a, b) => {
		const aFolder = a.isFolder ? 0 : 1;
		const bFolder = b.isFolder ? 0 : 1;
		if (aFolder !== bFolder) return aFolder - bFolder;
		if (aFolder === 0) {
			const aPath = cache.getPathById(a.id) ?? "";
			const bPath = cache.getPathById(b.id) ?? "";
			return aPath.split("/").length - bPath.split("/").length;
		}
		return 0;
	});
	acc.count += entries.length;
	for (const entry of entries) applyEntry(cache, acc, entry);
	settle(cache, acc);
}

/** Apply a single normalized delta entry to the cache and accumulate its paths. */
function applyEntry<TFile>(
	cache: AbstractMetadataCache<TFile>,
	acc: IdDeltaResult,
	entry: IdDeltaEntry<TFile>,
): void {
	if (entry.file === undefined) {
		// The provider says this object is gone, so any contention it was part of is
		// withdrawn: there is nothing left to readmit and nothing left to announce.
		acc.standing.delete(entry.id);
		// Tombstone: remove the object and its own subtree, recording every path they
		// held. A folder that shared its path with others leaves those, and their
		// contents, in place.
		for (const path of cache.removeObject(entry.id)) acc.changedPaths.add(path);
		return;
	}

	const applied = cache.applyFileChangeDetectMove(entry.file);
	const { oldPath, newPath, wasFolder, oldDescendants } = applied;

	if (applied.withheld) {
		// The cache refused to write this claim because another live id holds its
		// address. The object is absent from the working view but NOT from the
		// provider, so the paths it vacated are a displacement, never a deletion.
		// The entry carries the claimant's own metadata, which is what lets a later
		// page that frees the address put it back.
		hold(acc, entry, applied.withheld);
		return;
	}
	// This id was written, so any standing loss recorded for it no longer describes
	// current facts. That is the case the address-keyed withdrawal in `settleOnce`
	// cannot see: a contender that lost an address is repaired by renaming IT to a
	// new address, and a later entry placing it there must withdraw the loss without
	// waiting for the admitted id to leave. Report the address it left as the move it
	// is, so the vacated path is accounted for rather than left to read as a deletion.
	const superseded = acc.standing.get(entry.id);
	if (superseded !== undefined) {
		acc.standing.delete(entry.id);
		if (oldPath === undefined && newPath !== undefined &&
			superseded.claim.vacatedPath !== null && superseded.claim.vacatedPath !== newPath) {
			reportMove(cache, acc, {
				oldPath: superseded.claim.vacatedPath,
				newPath,
				wasFolder: entry.isFolder,
				oldDescendants: superseded.claim.displacedPaths,
			});
		}
	}
	if (applied.displacement) {
		// This entry took the address from a live occupant. Hold the occupant's own
		// metadata too — the cache hands it back for exactly this — so that if the
		// arriving claimant later vacates the address, `settleOnce` re-applies the
		// evicted object and the contention withdraws with no provider read. The
		// evicted object was in the committed view; re-seating it is what lets a
		// keeper the cache evicted (a claimant it never held otherwise) converge.
		const evicted = applied.evicted;
		const entry = evicted === undefined ? null : {
			id: applied.displacement.withheldId,
			isFolder: cache.toEntity(applied.displacement.path, evicted).isDirectory,
			file: evicted,
		};
		hold(acc, entry, { ...applied.displacement, vacatedPath: applied.displacement.path });
	}
	// The rest of what this change cost: folders merged beside an evicted occupant,
	// and children a folder brought into a same-named one that met theirs. None of
	// their metadata came with this page, so like an evicted occupant they are
	// announced and cannot be re-applied here.
	for (const loss of applied.additionalLosses ?? []) hold(acc, null, loss);

	// Moved outside the tracked root (parent no longer resolves) → surface as deleted.
	// This is the only cause of "no new path" left here: a claim this drain withheld
	// returned above, and a descendant of a loser cannot reach this branch at all,
	// because the cache removes a loser's whole subtree with it, leaving the
	// descendant's own entry with no old path to misreport.
	if (oldPath && !newPath) {
		acc.changedPaths.add(oldPath);
		for (const d of oldDescendants) acc.changedPaths.add(d);
		return;
	}
	if (!newPath) return;

	// This folder had no cached path immediately before its own mutation and has one
	// now: it entered the tracked root on THIS entry. Recording here (rather than
	// sampling `hasId` at page or drain start) is what catches a folder evicted
	// earlier in the same page by an ancestor's tombstone. `wasFolder` describes the
	// OLD path and is always false when `oldPath` is undefined, so it is never used.
	if (!oldPath && entry.isFolder) acc.enteredFolderIds.add(entry.id);

	acc.changedPaths.add(newPath);
	const moved = !!oldPath && oldPath !== newPath;
	if (moved && applied.acrossSharedPath) {
		reportContentsMove(cache, acc, oldPath, oldDescendants, applied.relocated ?? []);
	} else if (moved) {
		reportMove(cache, acc, { oldPath, newPath, wasFolder, oldDescendants });
	}
}

/**
 * Report a folder move out of, or into, a path other folders share — as what moved.
 *
 * The vault sees one folder at a shared path, so a pair naming the folder would say
 * the whole vault folder moved, carrying the other folders' contents with it. What
 * actually moved is this folder's own contents, so each file is reported as its own
 * move with its own identity, and the folder paths only as changed.
 */
function reportContentsMove<TFile>(
	cache: AbstractMetadataCache<TFile>,
	acc: IdDeltaResult,
	oldPath: string,
	oldDescendants: readonly string[],
	relocated: readonly RelocatedEntry[],
): void {
	acc.changedPaths.add(oldPath);
	for (const d of oldDescendants) acc.changedPaths.add(d);
	for (const entry of relocated) {
		acc.changedPaths.add(entry.newPath);
		if (entry.isFolder) continue;
		acc.renamedPaths.push({
			oldPath: entry.oldPath,
			newPath: entry.newPath,
			identityKey: projectedIdentityKey(cache, entry.newPath),
		});
	}
}

/**
 * Record a move's old path, its old descendants, its pair and its new subtree.
 *
 * The pair's identity comes from the cache's own entity projection at the address the
 * object now occupies — the single source every rename producer reads — never from
 * the delta entry's raw id or from the address itself. Both callers report an object
 * that is cached at `newPath` by the time they get here (an ordinary move, and a
 * claimant readmitted at settlement), so the one rule serves both.
 */
function reportMove<TFile>(
	cache: AbstractMetadataCache<TFile>,
	acc: IdDeltaResult,
	move: { oldPath: string; newPath: string; wasFolder: boolean; oldDescendants: readonly string[] },
): void {
	acc.changedPaths.add(move.oldPath);
	for (const d of move.oldDescendants) acc.changedPaths.add(d);
	acc.renamedPaths.push({
		oldPath: move.oldPath,
		newPath: move.newPath,
		isFolder: move.wasFolder || undefined,
		identityKey: projectedIdentityKey(cache, move.newPath),
	});
	// Folder move — also report the new descendant paths as updated.
	if (move.wasFolder) {
		for (const nd of cache.collectDescendants(move.newPath)) acc.changedPaths.add(nd);
	}
}

/** Hold one loss for the rest of the drain, replacing whatever stood for that id. */
function hold(acc: IdDeltaResult, entry: IdDeltaEntry<unknown> | null, claim: WithheldClaim): void {
	acc.standing.set(claim.withheldId, {
		entry: entry !== null && entry.id === claim.withheldId ? entry : null,
		claim,
	});
}

/**
 * Close a page: re-test every standing contention against current facts, then
 * publish what still stands.
 *
 * A contention is re-tested only when the address it lost is no longer held by the
 * id that beat it — a tombstone for the admitted id, or another object taking the
 * address. Re-application goes through the ordinary apply path, so the claimant is
 * either admitted (and the contention withdrawn) or arbitrated against whoever
 * holds the address now; the arbiter names the same winner whichever of them the
 * drain observed first. A claimant that was admitted from a path it had vacated
 * reports that as the move it is.
 */
function settle<TFile>(cache: AbstractMetadataCache<TFile>, acc: IdDeltaResult): void {
	// Each pass either re-tests a contention (which refreshes it, so the next pass
	// skips it) or admits a claimant (which removes it), so the guard is only a
	// belt-and-braces bound on a cache that keeps changing under re-application.
	for (let pass = 0, guard = acc.standing.size + 1; pass <= guard; pass++) {
		if (!settleOnce(cache, acc)) break;
	}
	const settled = [...acc.standing.values()]
		.map((standing) => standing.claim)
		.sort((a, b) => (contentionKey(a) < contentionKey(b) ? -1 : 1));
	acc.withheld = settled;
	acc.displacements = settled.map(toDisplacement);
}

/** One re-test pass over the standing contentions; true when anything was re-applied. */
function settleOnce<TFile>(cache: AbstractMetadataCache<TFile>, acc: IdDeltaResult): boolean {
	let progressed = false;
	for (const [id, standing] of [...acc.standing]) {
		const { entry, claim } = standing;
		if (entry === null || entry.file === undefined) continue;
		// Still beaten by the same id: the facts that decided this have not moved.
		if (cache.idAt(claim.path) === claim.admittedId) continue;

		acc.standing.delete(id);
		applyEntry(cache, acc, entry as IdDeltaEntry<TFile>);
		const readmittedAt = cache.getPathById(id);
		if (readmittedAt !== undefined && claim.vacatedPath !== null && claim.vacatedPath !== readmittedAt) {
			reportMove(cache, acc, {
				oldPath: claim.vacatedPath,
				newPath: readmittedAt,
				wasFolder: entry.isFolder,
				oldDescendants: claim.displacedPaths,
			});
		}
		progressed = true;
	}
	return progressed;
}

/**
 * Flatten a standing loss into the address-level fact: the contended address, the
 * two ids, and every cache path that is absent because the loss stands — the path
 * the claimant vacated included, since that is exactly the absence an attribution
 * rule must not read as a deletion.
 */
function toDisplacement(claim: WithheldClaim): AddressDisplacement {
	const absent = claim.vacatedPath === null
		? [...claim.displacedPaths]
		: [claim.vacatedPath, ...claim.displacedPaths].sort();
	return {
		path: claim.path,
		admittedId: claim.admittedId,
		withheldId: claim.withheldId,
		displacedPaths: absent,
		reason: claim.reason,
		owesRemediation: claim.owesRemediation,
	};
}

/** One announced order for one drain: (address, losing id) is unique per loss. */
function contentionKey(claim: WithheldClaim): string {
	return `${claim.path} ${claim.withheldId}`;
}
