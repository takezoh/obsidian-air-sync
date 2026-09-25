import { LEGACY_BACKEND_ALIASES } from "../validate-module";

/**
 * The legacy six `backendType` values, mapped onto the three canonical module ids.
 *
 * This is the read-only alias catalog for the bounded compatibility exception
 * (see `docs/adr/adr-20260920-backend-module-boundary.md`): it exists so an old
 * vault's settings/identity can be interpreted as a canonical module + authMode,
 * never so a `*-custom` id can be registered as a module. It reshapes/discards an
 * incompatible old id, it does not transform unrelated data.
 */
export type LegacyAuthMode = "default" | "custom";

/**
 * Map any persisted `backendType` to a canonical module id. An already-canonical
 * id (or any unknown string) is returned unchanged, so this is idempotent and
 * never invents a backend.
 */
export function canonicalBackendId(backendType: string): string {
	return LEGACY_BACKEND_ALIASES[backendType] ?? backendType;
}

/** Whether `backendType` is a legacy `*-custom` alias. */
export function isLegacyCustomAlias(backendType: string): boolean {
	return Object.prototype.hasOwnProperty.call(LEGACY_BACKEND_ALIASES, backendType);
}

/**
 * The boolean `authMode` a persisted `backendType` implies when the stored bag
 * carries no explicit `authMode`: an old `*-custom` alias means the user's own
 * OAuth app (`true`); a canonical id means the built-in app (`false`). A stored
 * `authMode` always wins — this only fills an absent field and never hides a real
 * contradiction. The persisted representation is the boolean, not the legacy
 * `LegacyAuthMode` profile name.
 */
export function impliedAuthMode(backendType: string): boolean {
	return isLegacyCustomAlias(backendType);
}
