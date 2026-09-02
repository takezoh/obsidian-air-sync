import { AuthError } from "../fs/errors";
import type { IFileSystem } from "../fs/interface";
import type { FileEntity, RemoteChecksum } from "../fs/types";
import type { Logger } from "../logging/logger";
import { getFileExtension } from "../utils/path";
import {
	generateConflictPath, resolveWithStrategy,
	type ConflictResolutionResult, type VerifiedConflictOutput,
} from "./conflict";
import { checksumsEqual, contentKey } from "./content-identity";
import { isMergeEligible, threeWayMerge } from "./merge";
import type { SyncStateStore } from "./state";
import type { ConflictStrategy, SyncRecord } from "./types";

export interface ConflictResolverContext {
	path: string;
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	local?: FileEntity;
	remote?: FileEntity;
	baseline?: SyncRecord;
	localPath?: string;
	remotePath?: string;
	remoteIdentitySource?: FileEntity;
	additionalRemote?: FileEntity;
	baselinePath?: string;
	stateStore?: SyncStateStore;
	logger?: Logger;
	freshRename?: boolean;
}

export type StableVersionWitness =
	| { readonly kind: "content_key"; readonly key: RemoteChecksum }
	| { readonly kind: "mtime"; readonly mtime: number; readonly size: number }
	| { readonly kind: "exact_bytes"; readonly size: number };

export interface ExactSnapshot {
	readonly path: string;
	readonly entity: FileEntity;
	readonly content: ArrayBuffer;
	readonly witness: StableVersionWitness;
}

export interface PreservationObligation {
	readonly role: "primary" | "additional";
	readonly sourcePath: string;
	readonly identityKey?: string;
}

export type PreparedConflict =
	| {
		readonly kind: "prepared_no_rotation";
		readonly primary: ExactSnapshot;
		readonly additional: readonly [] | readonly [ExactSnapshot];
		readonly obligations: readonly PreservationObligation[];
	}
	| {
		readonly kind: "prepared_rotation_required";
		readonly source: FileEntity;
		readonly sourceWitness: StableVersionWitness;
		readonly primary: ExactSnapshot;
		readonly additional: readonly [] | readonly [ExactSnapshot];
		readonly obligations: readonly PreservationObligation[];
	};

export class ConflictPreparationError extends Error {
	constructor(
		readonly kind: "external_io_failure" | "external_auth_failure" | "proof_mismatch",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ConflictPreparationError";
	}
}

export type { ConflictResolutionResult };

/** Bounded read-only capture; no path allocation, resolver call, or mutation. */
export async function prepareConflict(ctx: ConflictResolverContext): Promise<PreparedConflict> {
	if (!ctx.remote) throw new ConflictPreparationError("proof_mismatch", "Conflict primary is absent");
	const primary = await stableSnapshot(ctx.remoteFs, ctx.remotePath ?? ctx.remote.path, ctx.remote);
	const additional = ctx.additionalRemote
		? [await stableSnapshot(ctx.remoteFs, ctx.additionalRemote.path, ctx.additionalRemote)] as const
		: [] as const;
	const obligations = Object.freeze([
		obligation("primary", primary),
		...additional.map((value) => obligation("additional", value)),
	]);
	const source = ctx.remoteIdentitySource;
	if (source && source.path !== ctx.path) {
		if (source.path !== primary.path || source.identityKey !== primary.entity.identityKey) {
			throw new ConflictPreparationError("proof_mismatch", "Prepared primary does not match rotation source");
		}
		return Object.freeze({
			kind: "prepared_rotation_required", source, sourceWitness: primary.witness,
			primary, additional, obligations,
		});
	}
	return Object.freeze({ kind: "prepared_no_rotation", primary, additional, obligations });
}

/** Configured resolver entry. Fresh conflicts preserve first and return an effect intent. */
export async function resolveConflict(
	ctx: ConflictResolverContext,
	strategy: ConflictStrategy,
): Promise<ConflictResolutionResult> {
	if (!ctx.freshRename) return resolveLegacyConflict(ctx, strategy);
	if (!ctx.remote) {
		const targetContent = ctx.local ? await classifiedRead(ctx.localFs, ctx.localPath ?? ctx.path) : undefined;
		return { action: "duplicated", targetContent, targetMtime: ctx.local?.mtime ?? 0, verifiedOutputs: [] };
	}
	const prepared = await prepareConflict(ctx);
	const outputs = await preserveAll(ctx, prepared);
	const resolution = await resolvePreparedWithStrategy(
		ctx, strategy, prepared.primary, outputs[0]!.path,
	);
	return { ...resolution, verifiedOutputs: outputs };
}

/** Decide the configured strategy from prepared bytes without mutating original paths. */
async function resolvePreparedWithStrategy(
	ctx: ConflictResolverContext,
	strategy: ConflictStrategy,
	primary: ExactSnapshot,
	primaryDuplicatePath: string,
): Promise<ConflictResolutionResult> {
	const localContent = ctx.local
		? await classifiedRead(ctx.localFs, ctx.localPath ?? ctx.path)
		: undefined;
	if (strategy === "duplicate") {
		return {
			action: "duplicated", duplicatePath: primaryDuplicatePath,
			targetContent: localContent ?? primary.content.slice(0),
			targetMtime: ctx.local?.mtime ?? primary.entity.mtime,
		};
	}
	if (!localContent || !ctx.local) {
		return {
			action: "kept_remote", targetContent: primary.content.slice(0),
			targetMtime: primary.entity.mtime,
		};
	}
	const base = ctx.stateStore
		? await ctx.stateStore.getContent(ctx.baselinePath ?? ctx.path)
		: undefined;
	if (base && isMergeEligible(ctx.path, Math.max(ctx.local.size, primary.entity.size))) {
		const decoder = new TextDecoder();
		const merged = threeWayMerge(
			decoder.decode(base), decoder.decode(localContent), decoder.decode(primary.content),
		);
		const extension = getFileExtension(ctx.path);
		if (!((extension === ".json" || extension === ".canvas") &&
			(merged.hasConflicts || !isValidJson(merged.content)))) {
			return {
				action: "merged", hasConflictMarkers: merged.hasConflicts,
				targetContent: new TextEncoder().encode(merged.content).buffer.slice(0),
				targetMtime: Date.now(),
			};
		}
	}
	if (ctx.local.mtime > 0 && primary.entity.mtime > 0 &&
		ctx.local.mtime < primary.entity.mtime) {
		return {
			action: "kept_remote", targetContent: primary.content.slice(0),
			targetMtime: primary.entity.mtime,
		};
	}
	if (ctx.local.mtime > 0 && primary.entity.mtime > 0 &&
		ctx.local.mtime > primary.entity.mtime) {
		return { action: "kept_local", targetContent: localContent, targetMtime: ctx.local.mtime };
	}
	if (buffersEqual(localContent, primary.content)) {
		return { action: "kept_local", targetContent: localContent, targetMtime: ctx.local.mtime };
	}
	return {
		action: "duplicated", duplicatePath: primaryDuplicatePath,
		targetContent: localContent, targetMtime: ctx.local.mtime,
	};
}

async function resolveLegacyConflict(
	ctx: ConflictResolverContext,
	strategy: ConflictStrategy,
): Promise<ConflictResolutionResult> {
	return resolveWithStrategy({
		path: ctx.path, localFs: ctx.localFs, remoteFs: ctx.remoteFs,
		local: ctx.local, remote: ctx.remote, prevSync: ctx.baseline,
		stateStore: ctx.stateStore, logger: ctx.logger,
		localPath: ctx.localPath, remotePath: ctx.remotePath, baselinePath: ctx.baselinePath,
	}, strategy, strategy === "auto_merge" ? "keep_newer" : undefined);
}

async function preserveAll(
	ctx: ConflictResolverContext,
	prepared: PreparedConflict,
): Promise<readonly VerifiedConflictOutput[]> {
	const snapshots = [
		{ role: "primary" as const, snapshot: prepared.primary },
		...prepared.additional.map((snapshot) => ({ role: "additional" as const, snapshot })),
	];
	const outputs: VerifiedConflictOutput[] = [];
	for (const { role, snapshot } of snapshots) {
		const path = await generateConflictPath(ctx.path, ctx.localFs, ctx.remoteFs);
		await ctx.localFs.write(path, snapshot.content.slice(0), snapshot.entity.mtime);
		await ctx.remoteFs.write(path, snapshot.content.slice(0), snapshot.entity.mtime);
		const [localCopy, remoteCopy] = await Promise.all([ctx.localFs.read(path), ctx.remoteFs.read(path)]);
		if (!buffersEqual(snapshot.content, localCopy) || !buffersEqual(snapshot.content, remoteCopy)) {
			throw new ConflictPreparationError("proof_mismatch", `Conflict output readback mismatch: ${path}`);
		}
		outputs.push(Object.freeze({ role, path, sourcePath: snapshot.path }));
	}
	return Object.freeze(outputs);
}

async function stableSnapshot(fs: IFileSystem, path: string, observed: FileEntity): Promise<ExactSnapshot> {
	try {
		const before = await fs.stat(path);
		assertSameIdentity(before, observed, path);
		const first = await fs.read(path);
		const after = await fs.stat(path);
		assertSameIdentity(after, before, path);
		const key = stableContentKey(observed, before, after, path);
		if (key) return snapshot(path, after, first, { kind: "content_key", key });
		if (observed.mtime > 0 && observed.mtime === before.mtime && before.mtime === after.mtime &&
			observed.size === before.size && before.size === after.size) {
			return snapshot(path, after, first, { kind: "mtime", mtime: after.mtime, size: after.size });
		}
		const second = await fs.read(path);
		const final = await fs.stat(path);
		assertSameIdentity(final, after, path);
		if (!buffersEqual(first, second)) {
			throw new ConflictPreparationError("proof_mismatch", `Conflict source bytes changed: ${path}`);
		}
		return snapshot(path, final, second, { kind: "exact_bytes", size: second.byteLength });
	} catch (error) {
		if (error instanceof ConflictPreparationError) throw error;
		const kind = error instanceof AuthError ? "external_auth_failure" : "external_io_failure";
		throw new ConflictPreparationError(kind, `Conflict source unreadable: ${path}`, { cause: error });
	}
}

function stableContentKey(
	observed: FileEntity, before: FileEntity, after: FileEntity, path: string,
): RemoteChecksum | undefined {
	const keys = [contentKey(observed), contentKey(before), contentKey(after)];
	for (let left = 0; left < keys.length; left++) {
		for (let right = left + 1; right < keys.length; right++) {
			const a = keys[left];
			const b = keys[right];
			if (a && b && a.algo === b.algo && !checksumsEqual(a, b)) {
				throw new ConflictPreparationError("proof_mismatch", `Conflict source key changed: ${path}`);
			}
		}
	}
	const [observedKey, beforeKey, afterKey] = keys;
	if (!observedKey || !beforeKey || !afterKey) return undefined;
	return checksumsEqual(observedKey, beforeKey) && checksumsEqual(beforeKey, afterKey)
		? afterKey
		: undefined;
}

function assertSameIdentity(
	current: FileEntity | null,
	previous: FileEntity,
	path: string,
): asserts current is FileEntity {
	if (!current || current.path !== path || current.identityKey !== previous.identityKey ||
		current.size !== previous.size) {
		throw new ConflictPreparationError("proof_mismatch", `Conflict source changed: ${path}`);
	}
}

function snapshot(
	path: string, entity: FileEntity, content: ArrayBuffer, witness: StableVersionWitness,
): ExactSnapshot {
	return Object.freeze({ path, entity: Object.freeze({ ...entity }), content: content.slice(0), witness });
}

function obligation(role: "primary" | "additional", value: ExactSnapshot): PreservationObligation {
	return Object.freeze({ role, sourcePath: value.path, identityKey: value.entity.identityKey });
}

async function classifiedRead(fs: IFileSystem, path: string): Promise<ArrayBuffer> {
	try {
		return await fs.read(path);
	} catch (error) {
		const kind = error instanceof AuthError ? "external_auth_failure" : "external_io_failure";
		throw new ConflictPreparationError(kind, `Conflict source unreadable: ${path}`, { cause: error });
	}
}

function isValidJson(content: string): boolean {
	try {
		JSON.parse(content);
		return true;
	} catch {
		return false;
	}
}

function buffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	return a.every((value, index) => value === b[index]);
}
