/**
 * JSON-safe data carried across the Backend Module boundary (API v2).
 *
 * The runtime is JavaScript — a module may return data that TypeScript would
 * reject. Core therefore validates every JSON boundary value structurally: only
 * finite numbers, strings, booleans, `null`, arrays, and plain objects are
 * accepted. `undefined`, `Date`, `Map`/`Set`, functions, class instances,
 * prototype-polluting keys, and cycles are rejected (see `isJsonValue`).
 */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
	[key: string]: JsonValue;
}

/** Keys that would let a value mutate an object's prototype chain. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

/**
 * Depth guard for {@link isJsonValue}. A cyclic structure can never exceed it,
 * so cycles are rejected without a separate visited-set.
 */
const MAX_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Whether `value` is a JSON-safe object with no forbidden or non-JSON keys. */
export function isJsonObject(value: unknown, depth = 0): value is JsonObject {
	if (!isPlainObject(value) || depth > MAX_DEPTH) return false;
	for (const key of Object.keys(value)) {
		if (FORBIDDEN_KEYS.has(key)) return false;
		if (!isJsonValue(value[key], depth + 1)) return false;
	}
	return true;
}

/** Whether `value` is a JSON-safe value per the API v2 contract. */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
	if (depth > MAX_DEPTH) return false;
	switch (typeof value) {
		case "string":
		case "boolean":
			return true;
		case "number":
			return Number.isFinite(value);
		case "object":
			break;
		default:
			return false;
	}
	if (value === null) return true;
	if (Array.isArray(value)) {
		return value.every((item) => isJsonValue(item, depth + 1));
	}
	return isJsonObject(value, depth + 1);
}
