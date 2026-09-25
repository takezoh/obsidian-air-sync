import type {
	RemoteAddressing,
	RemoteChange,
	RemoteChecksum,
	RemoteLocation,
	RemoteObject,
	RemotePathAuthority,
} from "../../backend-api";

/**
 * Runtime validation of a `RemoteObject` at the adapter boundary.
 *
 * The Backend Module API is a runtime boundary: a future dynamically loaded module
 * is plain JavaScript, so TypeScript alone cannot make "this is a `RemoteObject`"
 * true. Core validates the normalized shape before anything downstream (the cache,
 * `FileEntity` projection, persistence) treats it as one. A malformed object is a
 * structural provider-protocol failure, not a transient blip: it is thrown with
 * `permanent: true` so the sync engine's existing classifier quarantines it rather
 * than retrying a module that will keep answering the same way.
 */

/** A malformed normalized object: a structural, non-retryable boundary failure. */
export class RemoteObjectValidationError extends Error {
	readonly permanent = true;
	readonly permanentCode = "invalid_remote_object";

	constructor(message: string) {
		super(message);
		this.name = "RemoteObjectValidationError";
	}
}

function fail(message: string): never {
	throw new RemoteObjectValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		fail(`${context}: "${key}" must be a non-empty string`);
	}
	return value;
}

function optionalString(record: Record<string, unknown>, key: string, context: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") fail(`${context}: "${key}" must be a string when present`);
	return value;
}

function optionalNonNegativeNumber(record: Record<string, unknown>, key: string, context: string): number | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		fail(`${context}: "${key}" must be a finite non-negative number when present`);
	}
	return value;
}

function validateChecksum(value: unknown, context: string): RemoteChecksum {
	if (!isRecord(value)) fail(`${context}: "checksum" must be an object`);
	return {
		algorithm: requireString(value, "algorithm", `${context}.checksum`),
		value: requireString(value, "value", `${context}.checksum`),
	};
}

function validateLocation(value: unknown, context: string): RemoteLocation {
	if (!isRecord(value)) fail(`${context}: "location" must be an object`);
	const addressing = value["addressing"];
	if (addressing === "parent_id") {
		const parentId = value["parentId"];
		if (parentId !== null && typeof parentId !== "string") {
			fail(`${context}: location.parentId must be a string or null`);
		}
		return { addressing: "parent_id", parentId };
	}
	if (addressing === "provider_path") {
		const path = value["path"];
		if (typeof path !== "string") fail(`${context}: location.path must be a string`);
		return { addressing: "provider_path", rootId: requireString(value, "rootId", context), path };
	}
	fail(`${context}: location.addressing must be "parent_id" or "provider_path"`);
}

/**
 * Validate one adapter-reported object. Returns the same value narrowed to
 * `RemoteObject`; throws {@link RemoteObjectValidationError} otherwise.
 *
 * `expectedAddressing` is the adapter's own declaration. When given, an object
 * whose `location.addressing` disagrees is a permanent failure: the cache/topology
 * would otherwise be built on a different scheme than the mutation destination
 * derived from the declaration.
 */
export function validateRemoteObject(value: unknown, expectedAddressing?: RemoteAddressing): RemoteObject {
	if (!isRecord(value)) fail("remote object must be an object");
	const id = requireString(value, "id", "remote object");
	const context = `remote object "${id}"`;
	const name = requireString(value, "name", context);
	const kind = value["kind"];
	if (kind !== "file" && kind !== "directory") fail(`${context}: "kind" must be "file" or "directory"`);
	const location = validateLocation(value["location"], context);
	if (expectedAddressing !== undefined && location.addressing !== expectedAddressing) {
		fail(
			`${context}: location.addressing "${location.addressing}" does not match the adapter's declared ` +
				`"${expectedAddressing}"`,
		);
	}
	const rawAuthority = value["pathAuthority"];
	if (rawAuthority !== undefined && rawAuthority !== "provider_resolved" && rawAuthority !== "requested_echo") {
		fail(`${context}: "pathAuthority" is not a known authority`);
	}
	const pathAuthority: RemotePathAuthority | undefined = rawAuthority;
	const size = optionalNonNegativeNumber(value, "size", context);
	const mtimeMs = optionalNonNegativeNumber(value, "mtimeMs", context);
	const versionToken = optionalString(value, "versionToken", context);
	const base = {
		id,
		name,
		location,
		pathAuthority,
		size,
		mtimeMs,
		versionToken,
	};
	if (kind === "directory") {
		if (value["checksum"] !== undefined) fail(`${context}: a directory must not carry a checksum`);
		return { ...base, kind: "directory" };
	}
	const checksum = value["checksum"] === undefined ? undefined : validateChecksum(value["checksum"], context);
	return { ...base, kind: "file", checksum };
}

/**
 * Validate every object an adapter delta carries before it can reach the cache or
 * the persisted checkpoint. Delete changes carry only an id or path and have no
 * object to validate; upserts are validated in place.
 */
export function validateRemoteChanges(
	changes: readonly RemoteChange[],
	expectedAddressing?: RemoteAddressing,
): RemoteChange[] {
	return changes.map((change) =>
		change.kind === "upsert"
			? { ...change, object: validateRemoteObject(change.object, expectedAddressing) }
			: change,
	);
}
