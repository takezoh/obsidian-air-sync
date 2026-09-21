import type { AirSyncSettings } from "./settings";
import { canonicalBackendId, impliedAuthMode } from "./fs/modules/compatibility/legacy-backend-aliases";

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalize a possibly-legacy `backendData` to the current single-bag shape.
 *
 * WHY THIS EXISTS: `settings.backendData` used to be a per-type map
 * (`{ "googledrive": {...}, "googledrive-custom": {...} }`) that held every
 * backend's params at once. It is now a single flat bag holding ONLY the active
 * backend's params, so another backend's data can never structurally linger.
 * Vaults saved by an older version still have the old nested shape on disk, so on
 * first load we lift the active backend's entry to the top level and discard every
 * other backend's leftovers. This keeps the currently-active backend connected
 * across the upgrade (its tokens live separately in SecretStorage and are
 * untouched) while honoring the "no foreign backend params persist" guarantee.
 *
 * This is cold-start normalization, NOT data migration: an incompatible old shape
 * is reshaped/discarded rather than transformed field-by-field. It is idempotent —
 * on the already-flat shape it is a no-op (returns false). It is a sanctioned
 * exception to CLAUDE.md's "no migration code" rule, recorded there. Old vs new is told apart
 * by whether `backendData` has a key equal to a REGISTERED backend type whose value
 * is an object; real param names never collide with a backend type, so this
 * discriminator has no false positives in practice.
 *
 * @returns true if `settings.backendData` was changed (caller should persist).
 */
export function liftActiveBackendData(
	settings: AirSyncSettings,
	knownTypes: readonly string[],
): boolean {
	const bag = settings.backendData;
	const isNested = knownTypes.some((t) => isObject(bag[t]));
	if (!isNested) return false;

	const active = bag[settings.backendType];
	settings.backendData = isObject(active) ? active : {};
	return true;
}

/**
 * Coerce a removed/unknown `conflictStrategy` to a valid one.
 *
 * WHY THIS EXISTS: the interactive `"ask"` strategy was removed (it was never
 * reachable — the resolver's modal needs an `app` that the sync pipeline never
 * threads, so `"ask"` always fell back to `"duplicate"`). A vault saved while it
 * was selected still has `conflictStrategy: "ask"` on disk; left as-is it would
 * hit no `switch` case in the resolver. We map it to `"duplicate"` — what it
 * actually did — rather than the default, so the user's effective behavior is
 * preserved. Any other unrecognized value falls back to the default `"auto_merge"`.
 *
 * @returns true if `settings.conflictStrategy` was changed (caller should persist).
 */
/**
 * Canonicalize the legacy backend selection onto a backend module id.
 *
 * WHY THIS EXISTS: the six legacy `backendType` values (three services, each with a
 * `-custom` OAuth variant) become three modules whose built-in/custom choice is the
 * `authMode` field inside the active `backendData` bag. A vault saved by an older
 * version still has a `*-custom` id and no `authMode`; left as-is it would select no
 * module. This maps the id to its canonical module and fills the absent `authMode`
 * (an old `*-custom` id means the user's own app; a canonical id means the built-in
 * app). A stored `authMode` always wins, so a real contradiction is not silently
 * hidden. It is idempotent — on a canonical id with a present `authMode` it is a
 * no-op (returns false).
 *
 * `lastSyncedIdentity` is persisted as `<backendType>:<targetId>`. Canonicalizing its
 * prefix is ONLY safe when it provably describes the same connection: the part after
 * the first colon must still equal the currently-bound target id. A stored identity
 * pointing at a different root is left untouched, so the ordinary identity-change
 * reset still fires in BackendManager. This never clears a baseline on its own.
 *
 * @returns true if any field changed (caller should persist).
 */
export function normalizeBackendModuleSettings(settings: AirSyncSettings): boolean {
	let changed = false;
	const originalType = settings.backendType;
	const canonical = canonicalBackendId(originalType);

	if (canonical !== originalType) {
		settings.backendType = canonical;
		changed = true;
	}

	const bag = settings.backendData;
	if (isObject(bag) && bag.authMode === undefined) {
		bag.authMode = impliedAuthMode(originalType);
		changed = true;
	}

	changed = canonicalizeStoredIdentity(settings, originalType) || changed;
	return changed;
}

/** Canonicalize the stored identity's backend prefix only for the same target. */
function canonicalizeStoredIdentity(settings: AirSyncSettings, originalType: string): boolean {
	const stored = settings.lastSyncedIdentity;
	if (!stored) return false;
	const separator = stored.indexOf(":");
	if (separator < 0) return false;
	const prefix = stored.slice(0, separator);
	const targetAndRest = stored.slice(separator);
	const canonicalPrefix = canonicalBackendId(prefix);
	// Same connection is proven by both halves: the prefix must canonicalize to the
	// SAME service the active selection canonicalizes to, and the target id must be
	// the currently-bound one. Either mismatch is a real target change — leave the
	// identity alone so the ordinary reset runs.
	if (canonicalPrefix === prefix) return false;
	if (canonicalPrefix !== canonicalBackendId(originalType)) return false;
	const targetId = settings.backendData.remoteVaultFolderId;
	if (typeof targetId !== "string" || targetAndRest !== `:${targetId}`) return false;
	settings.lastSyncedIdentity = `${canonicalPrefix}${targetAndRest}`;
	return true;
}

export function normalizeConflictStrategy(settings: AirSyncSettings): boolean {
	const strategy = settings.conflictStrategy as string;
	if (strategy === "auto_merge" || strategy === "prefer_local" || strategy === "duplicate") return false;
	settings.conflictStrategy = strategy === "ask" ? "duplicate" : "auto_merge";
	return true;
}
