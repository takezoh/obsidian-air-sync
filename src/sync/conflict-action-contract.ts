import type { FileEntity } from "../fs/types";
import type {
	ConflictAction, ConflictExecutionPolicy, PathObservation, PreservationCoverChild,
	RecordPublication, SyncRecord,
} from "./types";
import { directConflictCandidateHint, insertConflictSuffix } from "./conflict";

/** Returns a fail-closed executor-boundary violation without performing I/O. */
export function conflictContractViolation(action: ConflictAction): string | undefined {
	const candidate = action as unknown as {
		readonly protocol?: unknown;
		readonly conflictPolicy?: unknown;
	};
	if (!isConflictExecutionPolicy(candidate.conflictPolicy)) {
		const kind = candidate.conflictPolicy === undefined ? "missing" : "invalid";
		return `Conflict execution policy ${kind}: ${action.path}`;
	}
	const protocol = candidate.protocol as { readonly kind?: unknown } | undefined;
	if (protocol?.kind !== "same_path" && protocol?.kind !== "preservation_cover") {
		return `Conflict protocol missing or invalid: ${action.path}`;
	}
	if (protocol.kind === "preservation_cover" && !isPreservationCoverProtocol(protocol, action.path)) {
		return `Conflict preservation protocol is malformed: ${action.path}`;
	}
	if (protocol.kind === "preservation_cover" && candidate.conflictPolicy.mode !== "preserve") {
		return `Conflict policy is incompatible with preservation cover: ${action.path}`;
	}
	if (protocol.kind === "same_path" && candidate.conflictPolicy.mode === "preserve" &&
		candidate.conflictPolicy.strategy === "auto_merge") {
		return `Conflict policy is incompatible with same-path Auto merge: ${action.path}`;
	}
	if (candidate.conflictPolicy.mode === "local_win" && !hasLocalWinProof(action)) {
		return `Prefer-local local-win proof is missing or invalid: ${action.path}`;
	}
	return undefined;
}

function hasLocalWinProof(action: ConflictAction): boolean {
	const { local, remote, baseline, path } = action;
	return !!local && !!remote && !local.isDirectory && !remote.isDirectory && !!baseline?.hash &&
		baseline.path === path && local.path === path && remote.path === path &&
		(!baseline.remoteIdentityKey || !remote.identityKey || baseline.remoteIdentityKey === remote.identityKey) &&
		!!local.hash && !!remote.hash && local.hash !== baseline.hash &&
		remote.hash !== baseline.hash && local.hash !== remote.hash &&
		!action.remoteIdentitySource && !action.additionalRemote && !action.additionalLocal &&
		!action.localPath && !action.remotePath;
}

function isPreservationCoverProtocol(value: unknown, anchorPath: string): boolean {
	if (!isObject(value) || value.kind !== "preservation_cover" ||
		!Array.isArray(value.collisionWitnesses) || !value.collisionWitnesses.every(isPathObservation) ||
		!isStringArray(value.candidatePaths) || !isStringArray(value.preservedPaths) ||
		!Array.isArray(value.children) ||
		!value.children.every((child) => isPreservationCoverChild(child, anchorPath)) ||
		!Array.isArray(value.cleanup) || !value.cleanup.every(isExactRecordCleanup)) return false;
	const candidatePaths = value.candidatePaths;
	const preservedPaths = value.preservedPaths;
	const children = value.children;
	const childPaths = children.map((child) => child.candidatePath);
	const preserved = new Set(preservedPaths);
	return new Set(candidatePaths).size === candidatePaths.length &&
		new Set(preservedPaths).size === preservedPaths.length &&
		candidatePaths.every((path) => isCanonicalCandidatePath(anchorPath, path)) &&
		arraysEqual(preservedPaths, candidatePaths.filter((path) => preserved.has(path))) &&
		arraysEqual(childPaths, candidatePaths.filter((path) => !preserved.has(path)));
}

function isPreservationCoverChild(value: unknown, anchorPath: string): value is PreservationCoverChild {
	if (!isObject(value) || !isObject(value.source) ||
		(value.source.side !== "local" && value.source.side !== "remote") ||
		!isFileEntity(value.source.entity) || value.source.entity.isDirectory ||
		!isPreservationContent(value.content) || !isNonEmptyString(value.candidatePath) ||
		value.candidatePath !== insertConflictSuffix(anchorPath, value.content.sha256) ||
		!(value.expectedLocal === null || isResolvedFileEntity(value.expectedLocal)) ||
		!(value.expectedRemote === null || isResolvedFileEntity(value.expectedRemote)) ||
		!Array.isArray(value.missingSides) ||
		!value.missingSides.every((side) => side === "local" || side === "remote") ||
		new Set(value.missingSides).size !== value.missingSides.length ||
		!isRecordPublication(value.publication)) return false;
	const missing = new Set(value.missingSides);
	return matchesPreservationContent(value.source.entity, value.content) &&
		(value.expectedLocal === null || matchesPreservationContent(value.expectedLocal, value.content)) &&
		(value.expectedRemote === null || matchesPreservationContent(value.expectedRemote, value.content)) &&
		missing.has("local") === (value.expectedLocal === null) &&
		missing.has("remote") === (value.expectedRemote === null);
}

function isPreservationContent(
	value: unknown,
): value is { readonly sha256: string; readonly size: number } {
	return isObject(value) && isSha256(value.sha256) && isNonNegativeNumber(value.size);
}

function matchesPreservationContent(
	entity: FileEntity,
	content: { readonly sha256: string; readonly size: number },
): boolean {
	return entity.hash === content.sha256 && entity.size === content.size;
}

function isCanonicalCandidatePath(anchorPath: string, candidatePath: string): boolean {
	const hint = directConflictCandidateHint(candidatePath);
	return hint?.basePath === anchorPath &&
		candidatePath === insertConflictSuffix(anchorPath, hint.sha256);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isExactRecordCleanup(value: unknown): boolean {
	return isObject(value) && isNonEmptyString(value.path) && isSyncRecord(value.expected) &&
		value.expected.path === value.path;
}

function isRecordPublication(value: unknown): value is RecordPublication {
	return isObject(value) && hasOwn(value, "source") && hasOwn(value, "destination") &&
		(value.source === undefined || isSyncRecord(value.source)) &&
		(value.destination === undefined || isSyncRecord(value.destination));
}

function isPathObservation(value: unknown): value is PathObservation {
	if (!isObject(value) || (value.side !== "local" && value.side !== "remote") ||
		!isNonEmptyString(value.requestedPath)) return false;
	if (value.kind === "exact") return isFileEntity(value.entity);
	if (value.kind === "alias") return isNonEmptyString(value.resolvedPath) && isFileEntity(value.entity);
	if (value.kind === "present_unresolved") return isNonEmptyString(value.returnedPath) &&
		isFileEntity(value.entity) && (value.source === "list" || value.source === "stat");
	if (value.kind === "absent") return value.authority === "stat" || value.authority === "checkpoint_deleted";
	return value.kind === "unknown" &&
		(value.reason === "not_observed" || value.reason === "outside_tracked_root");
}

function isResolvedFileEntity(value: unknown): value is FileEntity {
	return isFileEntity(value) && !value.isDirectory && value.pathAuthority === "actual_resolved";
}

function isFileEntity(value: unknown): value is FileEntity {
	return isObject(value) && isNonEmptyString(value.path) && typeof value.isDirectory === "boolean" &&
		isNonNegativeNumber(value.size) && isNonNegativeNumber(value.mtime) && typeof value.hash === "string" &&
		(value.pathAuthority === undefined || value.pathAuthority === "actual_resolved" || value.pathAuthority === "requested_echo") &&
		(value.identityKey === undefined || typeof value.identityKey === "string");
}

function isSyncRecord(value: unknown): value is SyncRecord {
	return isObject(value) && isNonEmptyString(value.path) && typeof value.hash === "string" &&
		isNonNegativeNumber(value.localMtime) && isNonNegativeNumber(value.remoteMtime) &&
		isNonNegativeNumber(value.localSize) && isNonNegativeNumber(value.remoteSize) &&
		isNonNegativeNumber(value.syncedAt) &&
		(value.remoteIdentityKey === undefined || typeof value.remoteIdentityKey === "string");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function hasOwn(value: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isNonEmptyString);
}

function isConflictExecutionPolicy(value: unknown): value is ConflictExecutionPolicy {
	if (!value || typeof value !== "object") return false;
	const policy = value as { readonly mode?: unknown; readonly strategy?: unknown };
	const strategy = policy.strategy;
	if (strategy !== "auto_merge" && strategy !== "prefer_local" && strategy !== "duplicate") return false;
	if (policy.mode === "auto_merge") return strategy === "auto_merge";
	if (policy.mode === "local_win") return strategy === "prefer_local";
	return policy.mode === "preserve";
}
