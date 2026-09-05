import { AuthError } from "../fs/errors";
import type { IFileSystem } from "../fs/interface";
import type { FileEntity, RemoteChecksum } from "../fs/types";
import { digest, isLocallyComputable } from "../utils/hash";
import { checksumsEqual, contentKey } from "./content-identity";

/** Attempt-local exact content capture shared by transfer and conflict execution. */
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

export class ContentProofError extends Error {
	constructor(
		readonly kind: "external_io_failure" | "external_auth_failure" | "proof_mismatch",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ContentProofError";
	}
}

export async function bytesMatch(content: ArrayBuffer, entity: FileEntity): Promise<boolean> {
	const key = contentKey(entity);
	return content.byteLength === entity.size && key !== null && isLocallyComputable(key.algo) &&
		await digest(content, key.algo) === key.value;
}

export async function captureContentSnapshot(fs: IFileSystem, path: string, observed: FileEntity): Promise<ExactSnapshot> {
	try {
		const before = await fs.stat(path);
		assertSameIdentity(before, observed, path);
		const first = await fs.read(path);
		const after = await fs.stat(path);
		assertSameIdentity(after, before, path);
		const key = stableContentKey(observed, before, after, path);
		if (first.byteLength !== observed.size || (key && isLocallyComputable(key.algo) &&
			await digest(first, key.algo) !== key.value)) {
			throw new ContentProofError("proof_mismatch", `Content source bytes contradict admitted content: ${path}`);
		}
		if (key) return snapshot(path, after, first, { kind: "content_key", key });
		if (observed.mtime > 0 && observed.mtime === before.mtime && before.mtime === after.mtime &&
			observed.size === before.size && before.size === after.size) {
			return snapshot(path, after, first, { kind: "mtime", mtime: after.mtime, size: after.size });
		}
		const second = await fs.read(path);
		const final = await fs.stat(path);
		assertSameIdentity(final, after, path);
		if (!buffersEqual(first, second)) {
			throw new ContentProofError("proof_mismatch", `Content source bytes changed: ${path}`);
		}
		return snapshot(path, final, second, { kind: "exact_bytes", size: second.byteLength });
	} catch (error) {
		if (error instanceof ContentProofError) throw error;
		const kind = error instanceof AuthError ? "external_auth_failure" : "external_io_failure";
		throw new ContentProofError(kind, `Content source unreadable: ${path}`, { cause: error });
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
				throw new ContentProofError("proof_mismatch", `Content source key changed: ${path}`);
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
		throw new ContentProofError("proof_mismatch", `Content source changed: ${path}`);
	}
}

function snapshot(
	path: string, entity: FileEntity, content: ArrayBuffer, witness: StableVersionWitness,
): ExactSnapshot {
	return Object.freeze({ path, entity: Object.freeze({ ...entity }), content: content.slice(0), witness });
}

function buffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const a = new Uint8Array(left);
	const b = new Uint8Array(right);
	return a.every((value, index) => value === b[index]);
}
