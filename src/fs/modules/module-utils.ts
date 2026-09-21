import type { BackendTarget, JsonObject } from "../../backend-api";

/** Coerce an untrusted module config value to a string; anything else is `""`. */
export function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * The bound target of an App-Folder-scoped backend, read from the flat config
 * bag without a network call. Shared because all three built-ins bind the same
 * `remoteVaultFolderId` field; a provider-specific target shape would not use it.
 */
export function resolveFolderTarget(config: Readonly<JsonObject>): BackendTarget | null {
	const id = asString(config.remoteVaultFolderId);
	return id ? { id } : null;
}

/** Parse an ISO-8601 provider timestamp to epoch ms; `undefined` when absent/invalid. */
export function parseIsoTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : ms;
}
