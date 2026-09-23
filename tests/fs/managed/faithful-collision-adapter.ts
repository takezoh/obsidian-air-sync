/**
 * A tiny faithful `RemoteBackendAdapter` for the r2 collision RED.
 *
 * The repository's `tests/fs/managed/fake-adapter.ts` cannot model this shape: its
 * `relocateTo` treats every same-path node as a descendant via a string-prefix test
 * (`"Note.md/" startsWith "Note.md/"`), so renaming one of two colliding siblings
 * rewrites the other's path too. Real providers allow two objects with one derived
 * address; this adapter keeps nodes by id and computes each path from its parent
 * chain on demand, so a collision is representable and a rename of one sibling does
 * not move the other.
 *
 * Parent-id addressing mirrors Google Drive: a bound-root node's parent is the root
 * id, so a full scan resolves its authority to `actual_resolved`.
 */
import type {
	CreateDirectoryInput,
	CreateFileInput,
	DeleteInput,
	MoveInput,
	RemoteBackendAdapter,
	RemoteBackendCapabilities,
	RemoteChange,
	RemoteChangeResult,
	RemoteObject,
	UpdateFileInput,
	VersionBoundReadInput,
	VersionBoundReadResult,
} from "../../../src/backend-api";

interface Node {
	id: string;
	name: string;
	parentId: string;
	isFolder: boolean;
	content: ArrayBuffer;
	version: number;
}

const text = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

export class FaithfulCollisionAdapter implements RemoteBackendAdapter {
	readonly capabilities: RemoteBackendCapabilities = {
		exclusiveCreate: false,
		conditionalContentUpdate: "none",
		conditionalMetadataMutation: false,
		versionBoundRead: "reobserve",
	};
	readonly addressing = "parent_id" as const;
	readonly rootId = "root";

	private readonly nodes = new Map<string, Node>();
	private readonly log: RemoteChange[] = [];
	private seq = 0;

	constructor() {
		this.nodes.set(this.rootId, {
			id: this.rootId, name: "", parentId: this.rootId, isFolder: true,
			content: new ArrayBuffer(0), version: 0,
		});
	}

	seedFile(path: string, content = path): string {
		const parent = this.ensureParent(path);
		const name = path.split("/").pop()!;
		const node: Node = { id: `f${++this.seq}`, name, parentId: parent, isFolder: false, content: text(content), version: 1 };
		this.nodes.set(node.id, node);
		return node.id;
	}

	/** Mutate the provider WITHOUT logging (like the repo fake's `simulate*`). */
	simulateRename(id: string, newName: string): RemoteChange {
		const node = this.nodes.get(id)!;
		node.name = newName;
		node.version++;
		return { kind: "upsert", object: this.objectOf(node) };
	}

	/** Append a pre-computed change to the log the way a provider reports it. */
	enqueue(change: RemoteChange): void {
		this.log.push(change);
	}

	// ── RemoteBackendAdapter ──

	getStartCursor(): Promise<string> {
		return Promise.resolve(String(this.log.length));
	}

	listAll(): Promise<readonly RemoteObject[]> {
		return Promise.resolve([...this.nodes.values()].filter((n) => n.id !== this.rootId).map((n) => this.objectOf(n)));
	}

	assertRootAlive(): Promise<void> {
		return Promise.resolve();
	}

	getChanges(cursor: string): Promise<RemoteChangeResult> {
		const start = cursor === "" ? 0 : Number(cursor);
		if (!Number.isFinite(start)) return Promise.resolve({ kind: "cursor_invalid" });
		return Promise.resolve({ kind: "changes", nextCursor: String(this.log.length), changes: this.log.slice(start) });
	}

	getById(id: string): Promise<RemoteObject | null> {
		const node = this.nodes.get(id);
		return Promise.resolve(node && node.id !== this.rootId ? this.objectOf(node) : null);
	}

	getByPath(path: string): Promise<readonly RemoteObject[]> {
		const matches = [...this.nodes.values()].filter((n) => n.id !== this.rootId && this.pathOf(n) === path);
		return Promise.resolve(matches.map((n) => this.objectOf(n)));
	}

	read(input: VersionBoundReadInput): Promise<VersionBoundReadResult> {
		const node = this.nodes.get(input.id);
		if (!node) return Promise.resolve({ kind: "unverifiable", reason: "not found" });
		if (`v${node.version}` !== input.versionToken) return Promise.resolve({ kind: "target_changed" });
		return Promise.resolve({ kind: "content", object: this.objectOf(node), content: node.content });
	}

	createFile(_input: CreateFileInput): Promise<RemoteObject> {
		throw new Error("FaithfulCollisionAdapter.createFile: not implemented");
	}
	updateFile(input: UpdateFileInput): Promise<RemoteObject> {
		const node = this.nodes.get(input.id);
		if (!node) return Promise.reject(new Error(`no such object ${input.id}`));
		if (`v${node.version}` !== input.expected.versionToken) {
			return Promise.reject(new Error(`version mismatch on ${input.id}`));
		}
		node.content = input.content;
		node.version++;
		const object = this.objectOf(node);
		this.log.push({ kind: "upsert", object });
		return Promise.resolve(object);
	}
	createDirectory(_input: CreateDirectoryInput): Promise<RemoteObject> {
		throw new Error("FaithfulCollisionAdapter.createDirectory: not implemented");
	}

	move(input: MoveInput): Promise<RemoteObject> {
		const node = this.nodes.get(input.id);
		if (!node) return Promise.reject(new Error(`no such object ${input.id}`));
		const dest = input.destination;
		if (dest.addressing !== "parent_id") return Promise.reject(new Error("wrong addressing"));
		node.name = dest.name;
		node.parentId = dest.parentId ?? this.rootId;
		node.version++;
		const object = this.objectOf(node);
		this.log.push({ kind: "upsert", object });
		return Promise.resolve(object);
	}

	delete(input: DeleteInput): Promise<void> {
		this.nodes.delete(input.id);
		this.log.push({ kind: "delete", id: input.id });
		return Promise.resolve();
	}

	// ── internals ──

	private ensureParent(path: string): string {
		const parts = path.split("/");
		if (parts.length === 1) return this.rootId;
		let currentParent = this.rootId;
		for (let i = 0; i < parts.length - 1; i++) {
			const name = parts[i]!;
			let node = [...this.nodes.values()].find((n) => n.isFolder && n.parentId === currentParent && n.name === name);
			if (!node) {
				node = { id: `d${++this.seq}`, name, parentId: currentParent, isFolder: true, content: new ArrayBuffer(0), version: 1 };
				this.nodes.set(node.id, node);
			}
			currentParent = node.id;
		}
		return currentParent;
	}

	private pathOf(node: Node): string {
		const parts = [node.name];
		let parentId = node.parentId;
		const seen = new Set<string>([node.id]);
		while (parentId !== this.rootId) {
			if (seen.has(parentId)) return parts.join("/");
			seen.add(parentId);
			const parent = this.nodes.get(parentId);
			if (!parent) return parts.join("/");
			parts.unshift(parent.name);
			parentId = parent.parentId;
		}
		return parts.join("/");
	}

	private objectOf(node: Node): RemoteObject {
		const base = {
			id: node.id,
			name: node.name,
			// Mirror Google Drive: a bound-root node's parent IS the root folder id (the
			// repo fake normalizes it to null, which the cache reads as `requested_echo`).
			location: { addressing: "parent_id" as const, parentId: node.parentId },
			pathAuthority: "provider_resolved" as const,
			mtimeMs: 1_000,
			versionToken: `v${node.version}`,
		};
		if (node.isFolder) return { ...base, kind: "directory" };
		return { ...base, kind: "file", size: node.content.byteLength };
	}
}
