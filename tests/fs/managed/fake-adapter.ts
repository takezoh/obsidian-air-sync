import type {
	CreateDirectoryInput,
	CreateFileInput,
	DeleteInput,
	MoveInput,
	RemoteBackendAdapter,
	RemoteBackendCapabilities,
	RemoteChange,
	RemoteChangeResult,
	RemoteChecksum,
	RemoteObject,
	RemoteObjectKind,
	UpdateFileInput,
	VersionBoundReadInput,
	VersionBoundReadResult,
} from "../../../src/backend-api";
import { backendError, isRemoteDirectory } from "../../../src/backend-api";
import { normalizeSyncPath } from "../../../src/utils/path";

export type FakeAddressing = "parent_id" | "provider_path";

interface FakeNode {
	id: string;
	name: string;
	kind: RemoteObjectKind;
	/** Provider parent id; `null` means directly under the bound root. */
	parentId: string | null;
	/** Root-relative provider path. */
	path: string;
	content: ArrayBuffer;
	mtimeMs: number;
	checksum?: RemoteChecksum;
	version: number;
	trashed: boolean;
}

const text = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

/** A thrown provider error that still satisfies `BackendErrorShape`. */
function providerError(kind: Parameters<typeof backendError>[0], message: string): Error {
	return Object.assign(new Error(message), backendError(kind, message));
}

/**
 * A faithful in-memory provider for the ManagedRemoteFs tests.
 *
 * It holds only provider facts: a tree of nodes with a stable id, a name and a
 * parent (or a resolved provider path in `provider_path` mode), plus an
 * append-only change log the adapter reports from a cursor. It does NOT know
 * about `IFileSystem`, `FileEntity`, the metadata cache, cursors-as-core-state,
 * or checkpoints — those are exactly what the managed filesystem under test is
 * supposed to own.
 *
 * Every mutation appends the change(s) the provider would report. `simulate*`
 * helpers mutate the provider and RETURN those changes without appending, so a
 * test can replay the same set in a different order and prove convergence.
 */
export class FakeRemoteAdapter implements RemoteBackendAdapter {
	readonly rootId: string;
	readonly capabilities: RemoteBackendCapabilities = {
		exclusiveCreate: true,
		conditionalContentUpdate: "all",
		conditionalMetadataMutation: true,
		versionBoundRead: "reobserve" as const,
	};
	readonly addressing: FakeAddressing;
	private readonly nodes = new Map<string, FakeNode>();

	private readonly changes: RemoteChange[] = [];
	private readonly root: FakeNode;
	private rootAlive = true;
	private invalidateNextCursor = false;
	private unverifiableNextRead = false;
	private seq = 0;

	constructor(rootId = "root", addressing: FakeAddressing = "parent_id") {
		this.rootId = rootId;
		this.addressing = addressing;
		this.root = {
			id: rootId, name: "", kind: "directory", parentId: null, path: "",
			content: new ArrayBuffer(0), mtimeMs: 0, version: 0, trashed: false,
		};
		this.nodes.set(rootId, this.root);
	}

	// ── Test seeding / staging (provider facts only) ──

	seedDirectory(path: string): string {
		const normalized = normalizeSyncPath(path);
		const parent = this.parentForPath(normalized);
		const node = this.newNode(parent, this.leaf(normalized), "directory", new ArrayBuffer(0), 0, undefined);
		return node.id;
	}

	seedFile(path: string, content = path, checksum?: RemoteChecksum, mtimeMs = 1_000): string {
		const normalized = normalizeSyncPath(path);
		const parent = this.parentForPath(normalized);
		const node = this.newNode(parent, this.leaf(normalized), "file", text(content), mtimeMs, checksum);
		return node.id;
	}

	/** Remove any tree at `path` and create a DIFFERENT object there (new id). */
	simulateRecreate(path: string): string {
		const existing = this.findByPath(normalizeSyncPath(path));
		const tombstone = existing ? this.deleteNode(existing) : [];
		const id = this.seedFile(path, `${path}+recreated`);
		this.changes.push(...tombstone, { kind: "upsert", object: this.objectOf(this.nodes.get(id)!) });
		return id;
	}

	simulateDelete(path: string): RemoteChange[] {
		const node = this.findByPath(normalizeSyncPath(path));
		if (!node) throw new Error(`simulateDelete: no path "${path}"`);
		return this.deleteNode(node);
	}
	simulateUpdate(path: string, content: string): RemoteChange[] {
		const node = this.findByPath(normalizeSyncPath(path));
		if (!node) throw new Error(`simulateUpdate: no path "${path}"`);
		node.content = text(content);
		node.version++;
		return [{ kind: "upsert", object: this.objectOf(node) }];
	}

	/** Advance a node's version in place (test convenience; distinct id→token pairs). */
	bumpVersion(id: string): void {
		const node = this.nodes.get(id);
		if (node) node.version++;
	}

	simulateCreate(path: string, content = path): RemoteChange[] {
		const normalized = normalizeSyncPath(path);
		const parent = this.parentForPath(normalized);
		const node = this.newNode(parent, this.leaf(normalized), "file", text(content), 1_000, undefined);
		return [{ kind: "upsert", object: this.objectOf(node) }];
	}


	simulateRename(oldPath: string, newPath: string): RemoteChange[] {
		const node = this.findByPath(normalizeSyncPath(oldPath));
		if (!node) throw new Error(`simulateRename: no path "${oldPath}"`);
		return this.relocate(node, normalizeSyncPath(newPath));
	}

	simulateMoveIntoRoot(node: FakeNode, newPath: string): RemoteChange[] {
		return this.relocate(node, normalizeSyncPath(newPath));
	}

	/** Append pre-computed changes to the provider's log, in the given order. */
	enqueueChanges(changes: readonly RemoteChange[]): void {
		for (const change of changes) this.changes.push(change);
	}

	/** Expire the next `getChanges` call, forcing a full scan. */
	expireNextCursor(): void {
		this.invalidateNextCursor = true;
	}

	makeReadUnverifiable(): void {
		this.unverifiableNextRead = true;
	}

	killRoot(): void {
		this.rootAlive = false;
	}

	nodeById(id: string): RemoteObject | null {
		const node = this.nodes.get(id);
		return node === undefined ? null : this.objectOf(node);
	}

	// ── RemoteBackendAdapter ──

	getStartCursor(): Promise<string> {
		return Promise.resolve(String(this.changes.length));
	}

	listAll(): Promise<readonly RemoteObject[]> {
		if (!this.rootAlive) return Promise.resolve([]);
		return Promise.resolve(this.reachableNodes().map((node) => this.objectOf(node)));
	}

	assertRootAlive(): Promise<void> {
		if (!this.rootAlive) return Promise.reject(new Error("remote root was deleted"));
		return Promise.resolve();
	}

	getChanges(cursor: string): Promise<RemoteChangeResult> {
		if (this.invalidateNextCursor) {
			this.invalidateNextCursor = false;
			return Promise.resolve({ kind: "cursor_invalid" });
		}
		const start = cursor === "" ? 0 : Number(cursor);
		if (!Number.isFinite(start)) return Promise.resolve({ kind: "cursor_invalid" });
		return Promise.resolve({
			kind: "changes",
			nextCursor: String(this.changes.length),
			changes: this.changes.slice(start),
		});
	}

	getById(id: string): Promise<RemoteObject | null> {
		return Promise.resolve(this.nodeById(id));
	}

	getByPath(path: string): Promise<readonly RemoteObject[]> {
		const target = normalizeSyncPath(path);
		const matches = this.reachableNodes().filter((node) => node.path === target);
		return Promise.resolve(matches.map((node) => this.objectOf(node)));
	}

	read(input: VersionBoundReadInput): Promise<VersionBoundReadResult> {
		if (this.unverifiableNextRead) {
			this.unverifiableNextRead = false;
			return Promise.resolve({ kind: "unverifiable", reason: "injected" });
		}
		const node = this.nodes.get(input.id);
		if (!node || node.trashed) {
			return Promise.resolve({ kind: "unverifiable", reason: "not found" });
		}
		if (this.tokenOf(node) !== input.versionToken) return Promise.resolve({ kind: "target_changed" });
		return Promise.resolve({ kind: "content", object: this.objectOf(node), content: node.content });
	}

	createFile(input: CreateFileInput): Promise<RemoteObject> {
		const { parent, name } = this.resolveDestination(input.destination);
		const node = this.newNode(parent, name, "file", input.content, input.mtimeMs, undefined);
		this.emit([{ kind: "upsert", object: this.objectOf(node) }]);
		return Promise.resolve(this.objectOf(node));
	}

	updateFile(input: UpdateFileInput): Promise<RemoteObject> {
		const node = this.nodes.get(input.id);
		if (!node || node.trashed) return Promise.reject(providerError("not_found", "no such object"));
		if (this.tokenOf(node) !== input.expected.versionToken) {
			return Promise.reject(providerError("target_changed", "version changed"));
		}
		node.content = input.content;
		node.mtimeMs = input.mtimeMs;
		node.version++;
		this.emit([{ kind: "upsert", object: this.objectOf(node) }]);
		return Promise.resolve(this.objectOf(node));
	}

	createDirectory(input: CreateDirectoryInput): Promise<RemoteObject> {
		const { parent, name } = this.resolveDestination(input.destination);
		const node = this.newNode(parent, name, "directory", new ArrayBuffer(0), 0, undefined);
		this.emit([{ kind: "upsert", object: this.objectOf(node) }]);
		return Promise.resolve(this.objectOf(node));
	}

	move(input: MoveInput): Promise<RemoteObject> {
		const node = this.nodes.get(input.id);
		if (!node || node.trashed) return Promise.reject(providerError("not_found", "no such object"));
		if (input.expected && this.tokenOf(node) !== input.expected.versionToken) {
			return Promise.reject(providerError("target_changed", "version changed"));
		}
		const { parent, name } = this.resolveDestination(input.destination);
		node.version++;
		const changes = this.relocateTo(node, parent, name);
		this.emit(changes);
		return Promise.resolve(this.objectOf(node));
	}

	delete(input: DeleteInput): Promise<void> {
		const node = this.nodes.get(input.id);
		if (!node || node.trashed) {
			this.emit([]);
			return Promise.resolve();
		}
		if (input.expected && this.tokenOf(node) !== input.expected.versionToken) {
			return Promise.reject(providerError("target_changed", "version changed"));
		}
		this.emit(this.deleteNode(node));
		return Promise.resolve();
	}

	// ── Internals ──

	private emit(changes: RemoteChange[]): void {
		for (const change of changes) this.changes.push(change);
	}

	private tokenOf(node: FakeNode): string {
		return `v${node.version}`;
	}

	private leaf(path: string): string {
		return path.split("/").pop() ?? path;
	}

	private objectOf(node: FakeNode): RemoteObject {
		const location = this.addressing === "provider_path"
			? { addressing: "provider_path" as const, rootId: this.rootId, path: node.path }
			: { addressing: "parent_id" as const, parentId: node.parentId };
		const base = {
			id: node.id,
			name: node.name,
			location,
			pathAuthority: "provider_resolved" as const,
			mtimeMs: node.mtimeMs,
			versionToken: this.tokenOf(node),
		};
		if (node.kind === "directory") return { ...base, kind: "directory" };
		return {
			...base,
			kind: "file",
			size: node.content.byteLength,
			...(node.checksum ? { checksum: node.checksum } : {}),
		};
	}

	private newNode(
		parent: FakeNode,
		name: string,
		kind: RemoteObjectKind,
		content: ArrayBuffer,
		mtimeMs: number,
		checksum: RemoteChecksum | undefined,
	): FakeNode {
		const id = `${kind === "directory" ? "d" : "f"}${++this.seq}`;
		const node: FakeNode = {
			id, name, kind, parentId: parent.id === this.rootId ? null : parent.id,
			path: parent.path === "" ? name : `${parent.path}/${name}`,
			content, mtimeMs, version: 1, trashed: false,
			...(checksum ? { checksum } : {}),
		};
		this.nodes.set(id, node);
		return node;
	}

	private parentForPath(path: string): FakeNode {
		const parentPath = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
		if (parentPath === "") return this.root;
		const parent = this.findByPath(parentPath);
		if (!parent) throw new Error(`no parent directory at "${parentPath}"`);
		return parent;
	}

	private findByPath(path: string): FakeNode | undefined {
		if (path === "") return this.root;
		for (const node of this.nodes.values()) {
			if (node.id !== this.rootId && !node.trashed && node.path === path) return node;
		}
		return undefined;
	}

	private reachableNodes(): FakeNode[] {
		return [...this.nodes.values()].filter((node) => node.id !== this.rootId && !node.trashed);
	}

	private subtree(node: FakeNode): FakeNode[] {
		const all = [node];
		for (const candidate of this.nodes.values()) {
			if (candidate.id === node.id) continue;
			if (`${candidate.path}/`.startsWith(`${node.path}/`)) all.push(candidate);
		}
		return all;
	}

	private removeSubtree(node: FakeNode): void {
		for (const child of this.subtree(node).reverse()) this.nodes.delete(child.id);
	}

	private deleteNode(node: FakeNode): RemoteChange[] {
		const oldPath = node.path;
		this.removeSubtree(node);
		if (this.addressing === "provider_path") {
			return [{ kind: "delete", path: oldPath, pathAuthority: "provider_resolved" }];
		}
		return [{ kind: "delete", id: node.id }];
	}

	private relocate(node: FakeNode, targetPath: string): RemoteChange[] {
		const parentPath = targetPath.includes("/") ? targetPath.substring(0, targetPath.lastIndexOf("/")) : "";
		const parent = parentPath === "" ? this.root : this.findByPath(parentPath);
		if (!parent) throw new Error(`relocate: no parent at "${parentPath}"`);
		return this.relocateTo(node, parent, this.leaf(targetPath));
	}

	private relocateTo(node: FakeNode, parent: FakeNode, name: string): RemoteChange[] {
		const oldPath = node.path;
		const descendants = this.subtree(node).filter((child) => child.id !== node.id);
		const oldPaths = new Map(descendants.map((child) => [child.id, child.path]));
		node.parentId = parent.id === this.rootId ? null : parent.id;
		node.name = name;
		node.path = parent.path === "" ? name : `${parent.path}/${name}`;
		for (const child of descendants) {
			const prior = oldPaths.get(child.id)!;
			child.path = `${node.path}${prior.slice(oldPath.length)}`;
		}
		if (this.addressing === "parent_id") {
			return [{ kind: "upsert", object: this.objectOf(node) }];
		}
		return [
			{ kind: "delete", path: oldPath, pathAuthority: "provider_resolved" },
			{ kind: "upsert", object: this.objectOf(node) },
		];
	}

	private resolveDestination(destination: CreateFileInput["destination"]): { parent: FakeNode; name: string } {
		// Mirror the real adapters, which reject a destination whose form is not the
		// one this adapter reports: a bridge that guessed/addressed wrongly must fail
		// here instead of silently landing under the fake's own scheme.
		if (destination.addressing !== this.addressing) {
			throw new Error(
				`fake adapter requires ${this.addressing} addressing, got ${destination.addressing}`,
			);
		}
		if (destination.addressing === "parent_id") {
			const parent = destination.parentId === null ? this.root : this.nodes.get(destination.parentId);
			if (!parent) throw new Error(`destination parent "${destination.parentId}" not found`);
			return { parent, name: destination.name };
		}
		const parentPath = destination.path.includes("/")
			? destination.path.substring(0, destination.path.lastIndexOf("/"))
			: "";
		const parent = parentPath === "" ? this.root : this.findByPath(parentPath);
		if (!parent) throw new Error(`destination parent path "${parentPath}" not found`);
		return { parent, name: this.leaf(destination.path) };
	}

	/** Expose whether a path currently holds a provider object (test convenience). */
	hasPath(path: string): boolean {
		return this.findByPath(normalizeSyncPath(path)) !== undefined;
	}

	/** Expose a seeded node id by path (test convenience). */
	idAtPath(path: string): string | undefined {
		return this.findByPath(normalizeSyncPath(path))?.id;
	}

	/** Expose an object for staging (test convenience). */
	objectAtPath(path: string): RemoteObject | null {
		const node = this.findByPath(normalizeSyncPath(path));
		return node ? this.objectOf(node) : null;
	}

	isDirectoryAt(path: string): boolean {
		const node = this.findByPath(normalizeSyncPath(path));
		return node !== undefined && isRemoteDirectory(this.objectOf(node));
	}
}
