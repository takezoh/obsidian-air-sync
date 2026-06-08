/**
 * Backend-agnostic remote-vault contract.
 *
 * These constants and types describe the remote-vault convention that the `fs/`
 * layer owns: the default root folder name, the reserved metadata path, and the
 * result shape a backend returns when it resolves/binds a remote vault. They live
 * in `fs/` because they appear in the `IBackendProvider`/`IFileSystem` contract;
 * `sync/` and `ui/` import them from here.
 */

/** Root folder name created in the backend storage */
export const REMOTE_VAULT_ROOT = "obsidian-air-sync";

/**
 * Reserved sync path for the backend's own vault metadata. It is managed
 * out-of-band by the backend (not through the IFileSystem layer), so the sync
 * engine must never push, pull, or delete it — even when the user opts `.airsync`
 * into syncDotPaths. Backends that store metadata here hide it from their own
 * `list()`/`stat()`; `SyncOrchestrator.isExcluded()` enforces the same on the
 * local side so the exclusion is symmetric. Backend-agnostic on purpose.
 */
export const INTERNAL_METADATA_PATH = ".airsync/metadata.json";

/** Result of resolving a remote vault */
export interface RemoteVaultResolution {
	/** Backend-specific data to persist in settings.backendData (e.g., remoteVaultFolderId) */
	backendUpdates: Record<string, unknown>;
}
