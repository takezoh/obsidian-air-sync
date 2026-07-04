import type { ErrorClassification } from "../fs/errors";
import type { FailedAction } from "./execution-result";
import type { SyncAction, SyncActionType } from "./types";

// 2 回目の同一 permanent failure で初めて block する。これにより、失敗後の
// cold recovery を 1 回は必ず支払い、3 cycle 目から poison action だけを抑制する。
const FAILED_ACTION_BLOCK_THRESHOLD = 2;
// mobile で同じ poison action を短時間に回し続けないための短い冷却時間。
// 永続化しないので plugin reload / Obsidian restart では解除される。
const FAILED_ACTION_BLOCK_TTL_MS = 5 * 60 * 1000;
const BLOCKABLE_LOCAL_ORIGIN_ACTIONS = new Set<SyncActionType>(["push", "delete_remote", "rename_remote"]);

interface FailedActionEntry {
	key: string;
	actionFingerprint: string;
	consecutiveFailures: number;
	blockedUntil: number;
}

export class FailedActionTracker {
	private readonly entries = new Map<string, FailedActionEntry>();

	isBlocked(backendType: string, action: SyncAction, now = Date.now()): string | null {
		if (!isBlockableLocalOriginAction(action)) return null;
		this.expire(now);
		const prefix = this.actionPrefix(backendType, action);
		const fingerprint = actionFingerprint(action);
		for (const entry of this.entries.values()) {
			if (!entry.key.startsWith(prefix)) continue;
			if (entry.actionFingerprint !== fingerprint) {
				this.entries.delete(entry.key);
				continue;
			}
			if (entry.blockedUntil > now) {
				return `blocked after ${entry.consecutiveFailures} repeated failures; retry after ${new Date(entry.blockedUntil).toISOString()}`;
			}
		}
		return null;
	}

	recordSuccess(backendType: string, action: SyncAction): void {
		this.clearAction(backendType, action);
	}

	recordFailure(
		backendType: string,
		failed: FailedAction,
		classification: ErrorClassification,
		now = Date.now(),
	): void {
		if (!isBlockableLocalOriginAction(failed.action)) return;
		this.expire(now);
		const failureCode = quarantineFailureCode(classification);
		if (!failureCode) {
			this.clearAction(backendType, failed.action);
			return;
		}
		const key = this.key(backendType, failed.action, failureCode);
		const fingerprint = actionFingerprint(failed.action);
		const existing = this.entries.get(key);
		const consecutiveFailures = existing?.actionFingerprint === fingerprint
			? existing.consecutiveFailures + 1
			: 1;
		this.clearAction(backendType, failed.action);
		this.entries.set(key, {
			key,
			actionFingerprint: fingerprint,
			consecutiveFailures,
			blockedUntil: consecutiveFailures >= FAILED_ACTION_BLOCK_THRESHOLD
				? now + FAILED_ACTION_BLOCK_TTL_MS
				: 0,
		});
	}

	isBlockingFailure(
		backendType: string,
		failed: FailedAction,
		classification: ErrorClassification,
		now = Date.now(),
	): boolean {
		if (!isBlockableLocalOriginAction(failed.action)) return false;
		const failureCode = quarantineFailureCode(classification);
		if (!failureCode) return false;
		const entry = this.entries.get(this.key(backendType, failed.action, failureCode));
		return !!entry && entry.actionFingerprint === actionFingerprint(failed.action) && entry.blockedUntil > now;
	}

	private expire(now: number): void {
		for (const [key, entry] of this.entries) {
			if (entry.blockedUntil > 0 && entry.blockedUntil <= now) this.entries.delete(key);
		}
	}

	private actionPrefix(backendType: string, action: SyncAction): string {
		return `${backendType}\u0000${action.action}\u0000${action.path}\u0000`;
	}

	private clearAction(backendType: string, action: SyncAction): void {
		const prefix = this.actionPrefix(backendType, action);
		for (const key of [...this.entries.keys()]) {
			if (key.startsWith(prefix)) this.entries.delete(key);
		}
	}

	private key(backendType: string, action: SyncAction, failureCode: string): string {
		return `${this.actionPrefix(backendType, action)}permanent\u0000${failureCode}`;
	}
}

function isBlockableLocalOriginAction(action: SyncAction): boolean {
	return BLOCKABLE_LOCAL_ORIGIN_ACTIONS.has(action.action);
}

function quarantineFailureCode(classification: ErrorClassification): string | null {
	return classification.kind === "permanent" && classification.permanentCode
		? classification.permanentCode
		: null;
}

function actionFingerprint(action: SyncAction): string {
	return JSON.stringify({
		action: action.action,
		path: action.path,
		oldPath: "oldPath" in action ? action.oldPath : undefined,
		local: entityFingerprint(action.local),
		remote: entityFingerprint(action.remote),
		baseline: action.baseline
			? {
				hash: action.baseline.hash,
				localMtime: action.baseline.localMtime,
				remoteMtime: action.baseline.remoteMtime,
				localSize: action.baseline.localSize,
				remoteSize: action.baseline.remoteSize,
			}
			: undefined,
	});
}

function entityFingerprint(entity: SyncAction["local"]): unknown {
	if (!entity) return undefined;
	return {
		isDirectory: entity.isDirectory,
		size: entity.size,
		mtime: entity.mtime,
		hash: entity.hash,
	};
}
