import type { AirSyncSettings } from "./settings";

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
 * on the already-flat shape it is a no-op (returns false). Old vs new is told apart
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
