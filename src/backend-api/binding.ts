import type { JsonObject } from "./json";
import type { BackendRuntimeContext } from "./runtime";

/**
 * The stable target a connection is bound to. `id` is unique within the
 * provider/account namespace; `displayPath` is human-readable and MUST NOT be
 * used to derive identity. Core composes the global identity from module id +
 * `target.id` — a module never invents a cross-backend identity string.
 */
export interface BackendTarget {
	readonly id: string;
	readonly displayPath?: string;
	/**
	 * Optional display-only note when the target is present but not usable (e.g. it
	 * is in the provider's trash). It is NEVER part of identity: core compares
	 * targets by `id` alone. `getTarget` must not set it.
	 */
	readonly warning?: string;
}

/**
 * A patch against the active backendData bag: top-level `set`/`unset` only.
 * It never targets global settings, secret values, cursors, or metadata
 * snapshots; nested changes are expressed as an explicit replacement of the
 * relevant top-level field.
 */
export interface JsonPatch {
	readonly set?: Readonly<JsonObject>;
	readonly unset?: readonly string[];
}

export interface BindingResult {
	readonly patch: JsonPatch;
	readonly target: BackendTarget;
}

/**
 * The binding workflows a module supports. A module returns patches and a
 * target; it never mutates global settings directly. Core renders the picker
 * modal and owns the connection lifecycle.
 */
export interface BackendBinding {
	/** Find or create this vault's default remote folder. */
	resolveDefault(
		context: BackendRuntimeContext,
		config: Readonly<JsonObject>,
		vaultName: string,
	): Promise<BindingResult>;

	/** Begin a web/in-app folder pick; returns e.g. a CSRF state to persist. */
	beginPick?(
		context: BackendRuntimeContext,
		config: Readonly<JsonObject>,
	): Promise<JsonPatch>;

	/** Bind the folder selected by {@link beginPick}, given the callback params. */
	completePick?(
		context: BackendRuntimeContext,
		params: Readonly<Record<string, string>>,
		config: Readonly<JsonObject>,
	): Promise<BindingResult>;

	/** Resolve the bound target's current display location, if the backend can. */
	getDisplayPath?(
		context: BackendRuntimeContext,
		config: Readonly<JsonObject>,
		target: BackendTarget,
	): Promise<BackendTarget | null>;

	/**
	 * List the folder names directly under an App-Folder-scoped root, for the core
	 * in-app folder picker. Optional: only a backend whose whole visible namespace is
	 * its own app folder offers it. Core renders the modal; this only returns facts.
	 */
	listAppRootFolders?(
		context: BackendRuntimeContext,
		config: Readonly<JsonObject>,
	): Promise<readonly string[]>;
}
