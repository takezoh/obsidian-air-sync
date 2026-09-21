import type { BackendModule } from "../../backend-api";
import { googleDriveModule } from "../googledrive/module";
import { oneDriveModule } from "../onedrive/module";
import { dropboxModule } from "../dropbox/module";

/**
 * The single built-in import root for the three canonical backend modules.
 *
 * Core registers these through the same validate→register path a future dynamic
 * loader uses (`BackendModuleRegistry`). `src/fs/registry.ts` is the production
 * composition: it validates/registers these and wraps each in a
 * `BackendModuleProvider` (connection host + `ManagedRemoteFs`). This is the only
 * production import root for the backend-specific module implementations.
 */
export const BUILTIN_BACKEND_MODULES: readonly BackendModule[] = [
	googleDriveModule,
	oneDriveModule,
	dropboxModule,
];
