/* eslint max-lines: ["error", 350] -- one resolver owns stable version capture, selected-strategy resolution, and verified preservation of those exact inputs. */
import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { Logger } from "../logging/logger";
import { getFileExtension } from "../utils/path";
import {
	generateConflictPath,
	type ConflictResolutionResult, type VerifiedConflictOutput,
} from "./conflict";
import { bytesMatch, captureContentSnapshot, ContentProofError, type ExactSnapshot, type StableVersionWitness } from "./content-snapshot";
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
	additionalLocal?: FileEntity;
	baselinePath?: string;
	stateStore?: SyncStateStore;
	logger?: Logger;
}


export interface PreservationObligation {
	readonly role: "primary" | "additional" | "local";
	readonly sourcePath: string;
	readonly identityKey?: string;
}

export type PreparedConflict =
	| {
		readonly kind: "prepared_no_rotation";
		readonly primary: ExactSnapshot;
		readonly additional: readonly [] | readonly [ExactSnapshot];
		readonly local?: ExactSnapshot;
		readonly obligations: readonly PreservationObligation[];
	}
	| {
		readonly kind: "prepared_rotation_required";
		readonly source: FileEntity;
		readonly sourceWitness: StableVersionWitness;
		readonly primary: ExactSnapshot;
		readonly additional: readonly [] | readonly [ExactSnapshot];
		readonly local?: ExactSnapshot;
		readonly obligations: readonly PreservationObligation[];
	};


export type { ConflictResolutionResult };

/** Bounded read-only capture; no path allocation, resolver call, or mutation. */
export async function prepareConflict(ctx: ConflictResolverContext): Promise<PreparedConflict> {
	if (!ctx.remote) throw new ContentProofError("proof_mismatch", "Conflict primary is absent");
	const primary = await captureContentSnapshot(ctx.remoteFs, ctx.remotePath ?? ctx.remote.path, ctx.remote);
	const additional = ctx.additionalRemote
		? [await captureContentSnapshot(ctx.remoteFs, ctx.additionalRemote.path, ctx.additionalRemote)] as const
		: [] as const;
	const local = ctx.additionalLocal
		? await captureContentSnapshot(ctx.localFs, ctx.additionalLocal.path, ctx.additionalLocal) : undefined;
	const obligations = Object.freeze([
		obligation("primary", primary),
		...additional.map((value) => obligation("additional", value)),
		...(local ? [obligation("local", local)] : []),
	]);
	const source = ctx.remoteIdentitySource;
	if (source && source.path !== ctx.path) {
		if (source.path !== primary.path || source.identityKey !== primary.entity.identityKey) {
			throw new ContentProofError("proof_mismatch", "Prepared primary does not match rotation source");
		}
		return Object.freeze({
			kind: "prepared_rotation_required", source, sourceWitness: primary.witness,
			primary, additional, local, obligations,
		});
	}
	return Object.freeze({ kind: "prepared_no_rotation", primary, additional, local, obligations });
}

/** One resolver: capture inputs, select policy, verify required copies; never mutate originals. */
export async function resolveConflict(
	ctx: ConflictResolverContext,
	strategy: ConflictStrategy,
): Promise<ConflictResolutionResult> {
	const local = ctx.local ? await captureContentSnapshot(ctx.localFs, ctx.localPath ?? ctx.local.path, ctx.local) : undefined;
	if (!ctx.remote) {
		return { action: local ? "duplicated" : "kept_local", targetContent: local?.content, targetMtime: ctx.local?.mtime ?? 0,
			verifiedOutputs: [], capturedInputs: { local } };
	}
	const prepared = await prepareConflict(ctx);
	const resolution = await resolvePreparedWithStrategy(
		ctx, strategy, prepared.primary, local,
	);
	const compound = !!ctx.remoteIdentitySource && ctx.remoteIdentitySource.path !== ctx.path || !!ctx.additionalRemote || !!ctx.additionalLocal ||
		ctx.local?.path !== undefined && ctx.local.path !== ctx.path || ctx.remote.path !== ctx.path;
	const outputs = compound || (resolution.action === "duplicated" && local)
		? await preserveAll(ctx, prepared) : [];
	return { ...resolution, duplicatePath: resolution.action === "duplicated" ? outputs[0]?.path : undefined,
		verifiedOutputs: outputs, capturedInputs: { local, remote: prepared.primary } };
}

/** Decide the configured strategy from prepared bytes without mutating original paths. */
async function resolvePreparedWithStrategy(
	ctx: ConflictResolverContext,
	strategy: ConflictStrategy,
	primary: ExactSnapshot,
	localSnapshot?: ExactSnapshot,
): Promise<ConflictResolutionResult> {
	const localContent = localSnapshot?.content.slice(0);
	if (strategy === "duplicate") {
		return {
			action: "duplicated",
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
	const base = ctx.baseline && ctx.stateStore
		? await ctx.stateStore.getContent(ctx.baselinePath ?? ctx.path)
		: undefined;
	if (base && isMergeEligible(ctx.path, Math.max(ctx.local.size, primary.entity.size))) {
		const decoder = new TextDecoder();
		const merged = threeWayMerge(
			decoder.decode(base), decoder.decode(localContent), decoder.decode(primary.content),
		);
		const extension = getFileExtension(ctx.path);
		if ((extension === ".json" || extension === ".canvas") &&
			(merged.hasConflicts || !isValidJson(merged.content))) {
			return { action: "duplicated", targetContent: localContent, targetMtime: ctx.local.mtime };
		}
		return {
			action: "merged", hasConflictMarkers: merged.hasConflicts,
			targetContent: new TextEncoder().encode(merged.content).buffer.slice(0),
			targetMtime: Date.now(),
		};
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
		action: "duplicated",
		targetContent: localContent, targetMtime: ctx.local.mtime,
	};
}

async function preserveAll(
	ctx: ConflictResolverContext,
	prepared: PreparedConflict,
): Promise<readonly VerifiedConflictOutput[]> {
	const snapshots = [
		{ role: "primary" as const, snapshot: prepared.primary },
		...prepared.additional.map((snapshot) => ({ role: "additional" as const, snapshot })),
		...(prepared.local ? [{ role: "local" as const, snapshot: prepared.local }] : []),
	];
	const outputs: VerifiedConflictOutput[] = [];
	for (const { role, snapshot } of snapshots) {
		const path = await generateConflictPath(ctx.path, ctx.localFs, ctx.remoteFs);
		await ctx.localFs.write(path, snapshot.content.slice(0), snapshot.entity.mtime);
		await ctx.remoteFs.write(path, snapshot.content.slice(0), snapshot.entity.mtime);
		for (const fs of [ctx.localFs, ctx.remoteFs]) {
			const entity = await fs.stat(path);
			if (!entity || (!await bytesMatch(snapshot.content, entity) &&
				!buffersEqual(snapshot.content, await fs.read(path)))) {
				throw new ContentProofError("proof_mismatch", `Conflict output readback mismatch: ${path}`);
			}
		}
		outputs.push(Object.freeze({
			role, path, sourcePath: snapshot.path,
			sourceEntity: snapshot.entity,
			sourceContent: snapshot.content.slice(0),
		}));
	}
	return Object.freeze(outputs);
}


function obligation(role: PreservationObligation["role"], value: ExactSnapshot): PreservationObligation {
	return Object.freeze({ role, sourcePath: value.path, identityKey: value.entity.identityKey });
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
