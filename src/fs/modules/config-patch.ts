import type { JsonObject, JsonPatch } from "../../backend-api";
import { isJsonObject } from "../../backend-api";

/** A module-returned patch that is not JSON-safe; fail closed rather than persist it. */
export class InvalidConfigPatchError extends Error {
	constructor(detail: string) {
		super(`Invalid config patch: ${detail}`);
		this.name = "InvalidConfigPatchError";
	}
}

/**
 * Apply a top-level `set`/`unset` patch to the LATEST backendData bag,
 * returning a new bag. `set` replaces whole top-level fields (nested changes
 * are expressed by replacing the containing field), and `unset` removes keys.
 *
 * This is the runtime JSON boundary: a module is plain JavaScript, so the patch
 * it returns is validated structurally before it can reach settings. A non-JSON
 * value (`undefined`, `Date`, `Map`, function, cycle, prototype-polluting key)
 * makes the whole patch fail closed.
 */
export function applyJsonPatch(bag: Readonly<JsonObject>, patch: JsonPatch): JsonObject {
	if (patch.set !== undefined && !isJsonObject(patch.set)) {
		throw new InvalidConfigPatchError(`"set" must be a JSON object`);
	}
	if (
		patch.unset !== undefined
		&& (!Array.isArray(patch.unset) || !patch.unset.every((key) => typeof key === "string"))
	) {
		throw new InvalidConfigPatchError(`"unset" must be an array of keys`);
	}
	const next: Record<string, unknown> = { ...bag };
	if (patch.set) {
		for (const [key, value] of Object.entries(patch.set)) next[key] = value;
	}
	if (patch.unset) {
		for (const key of patch.unset) delete next[key];
	}
	if (!isJsonObject(next)) {
		throw new InvalidConfigPatchError("the resulting config bag is not JSON-safe");
	}
	return next;
}

