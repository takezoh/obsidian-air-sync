import type { ConflictStrategy } from "./sync/types";

export interface AirSyncSettings {
	/** Unique identifier for this vault (used as IndexedDB key) */
	vaultId: string;
	/** Selected backend type (e.g. "googledrive") */
	backendType: string;
	/** Strategy for conflict resolution */
	conflictStrategy: ConflictStrategy;
	/** Gitignore-style patterns to exclude from sync */
	ignorePatterns: string[];
	/** Enable 3-way merge for text files */
	enableThreeWayMerge: boolean;
	/** Dot-prefixed paths to include in sync (e.g. [".templates", ".stversions"]) */
	syncDotPaths: string[];
	/** Enable experimental sync of Obsidian's own config directory (.obsidian/) */
	enableConfigSync: boolean;
	/** Maximum file size in MB to sync on mobile */
	mobileMaxFileSizeMB: number;
	/** Hold a screen wake lock while syncing so mobile devices don't sleep mid-sync */
	screenWakeLockOnSync: boolean;
	/** Show a notice summarizing each completed sync cycle (independent of logging) */
	showSyncNotifications: boolean;

	/** Write sync logs to .airsync/logs/{device}/{date}.log */
	enableLogging: boolean;
	/** Minimum log level to write */
	logLevel: "debug" | "info" | "warn" | "error";

	/**
	 * Parameters of the currently-selected backend ONLY (a single flat bag),
	 * not a per-type map. Switching backends clears this; an older per-type map
	 * is normalized on load (see `liftActiveBackendData`). Keeping only the active
	 * backend's params here means another backend's data can never structurally linger.
	 */
	backendData: Record<string, unknown>;

	/**
	 * Identity (`<type>:<remoteVaultFolderId>`) of the backend the sync-state store
	 * was last reconciled against. Persisted so a backend/target change made across
	 * a reload is detected on the next `initBackend` and the stale baselines are
	 * cleared — the state store is keyed by vaultId alone, so without this the new
	 * target would reuse the previous one's baselines. `""` until the first sync.
	 */
	lastSyncedIdentity: string;
}

export const DEFAULT_SETTINGS: AirSyncSettings = {
	vaultId: "",
	backendType: "googledrive",
	conflictStrategy: "auto_merge",
	ignorePatterns: [],
	syncDotPaths: [],
	enableConfigSync: false,
	enableThreeWayMerge: true,
	mobileMaxFileSizeMB: 10,
	screenWakeLockOnSync: false,
	showSyncNotifications: false,
	enableLogging: false,
	logLevel: "info",
	backendData: {},
	lastSyncedIdentity: "",
};



