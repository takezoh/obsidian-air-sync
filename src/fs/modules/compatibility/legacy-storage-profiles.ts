import type { PhysicalKeyResolver } from "../secret-host";
import { canonicalBackendId } from "./legacy-backend-aliases";
import type { LegacyAuthMode } from "./legacy-backend-aliases";

/**
 * Physical SecretStorage / IndexedDB profiles for the legacy six backends, kept
 * as a bounded compatibility map. A module id is logical; these profiles are the
 * physical names an existing vault already wrote, so alias normalization must not
 * move a token or lose a checkpoint store.
 *
 * Physical keys were `air-sync-<type>-<name>-token` (`type` being the legacy id,
 * e.g. `googledrive-custom`), and the checkpoint DB prefix likewise carried the
 * legacy id. The map below reproduces those names for the canonical module +
 * authMode pair.
 */

/** The legacy `backendType` whose physical profile a (module, authMode) pair uses. */
export function legacyStorageType(moduleId: string, authMode: LegacyAuthMode): string {
	const canonical = canonicalBackendId(moduleId);
	// Google Drive's built-in and custom apps shared one store/secret namespace in
	// the legacy code (`air-sync-googledrive`), so only OneDrive/Dropbox gained the
	// `-custom` suffix.
	if (canonical === "googledrive") return "googledrive";
	return authMode === "custom" ? `${canonical}-custom` : canonical;
}

/** The legacy IndexedDB `dbNamePrefix` for a canonical module + authMode. */
export function legacyDbNamePrefix(moduleId: string, authMode: LegacyAuthMode): string {
	return `air-sync-${legacyStorageType(moduleId, authMode)}`;
}

/**
 * Build the {@link PhysicalKeyResolver} that keeps a connection on its legacy
 * physical secret keys. `authMode` selects the profile because built-in and custom
 * tokens live under different namespaces for OneDrive/Dropbox.
 */
export function createLegacyPhysicalKeyResolver(authMode: LegacyAuthMode): PhysicalKeyResolver {
	const storageType = (moduleId: string): string => legacyStorageType(moduleId, authMode);
	return (moduleId, logicalKey) => `air-sync-${storageType(moduleId)}-${logicalKey}-token`;
}
