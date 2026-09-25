import type {
	BackendBinding,
	BackendRuntimeContext,
	BackendTarget,
	JsonObject,
	JsonPatch,
} from "../../backend-api";

/**
 * The core half of a module's folder binding. A module declares
 * `BackendBinding.beginPick`/`completePick`; it never opens UI, mutates global
 * settings, or talks to the sync engine. All provider I/O stays inside those
 * methods — this host only routes the config patches they return through the
 * connection's generation gate.
 */
export interface FolderPickConfigPort {
	/** The active backendData bag, read fresh at each step. */
	read(): Readonly<JsonObject>;
	/** Persist a patch; returns `false` when the issuing generation is stale. */
	commit(patch: JsonPatch): Promise<boolean>;
}

export interface FolderPickHost {
	readonly binding: BackendBinding;
	readonly context: BackendRuntimeContext;
	readonly config: FolderPickConfigPort;
}

/**
 * Begin a web/in-app folder pick. Persists the state the module returns for the
 * callback to correlate. Returns `false` when the backend has no picker or the
 * connection is no longer current.
 */
export async function beginFolderPick(host: FolderPickHost): Promise<boolean> {
	const { binding, context, config } = host;
	if (!binding.beginPick) return false;
	const patch = await binding.beginPick(context, config.read());
	return config.commit(patch);
}

/**
 * Bind the folder selected by {@link beginFolderPick}, given the callback
 * params. Returns the stable target the module resolved, or `null` when the
 * backend has no picker or the generation turned stale before the patch could
 * be applied (so a late callback from a replaced connection never re-binds).
 */
export async function completeFolderPick(
	host: FolderPickHost,
	params: Readonly<Record<string, string>>,
): Promise<BackendTarget | null> {
	const { binding, context, config } = host;
	if (!binding.completePick) return null;
	const result = await binding.completePick(context, params, config.read());
	const applied = await config.commit(result.patch);
	return applied ? result.target : null;
}
