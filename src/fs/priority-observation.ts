import type { FileEntity } from "./types";

export interface PriorityObservationRequest {
	path: string;
	/** Stable admitted identity when one exists; new paths legitimately omit it. */
	identityKey?: string;
}

export type PriorityPathOccupant =
	| { kind: "absent" }
	| { kind: "unverifiable" }
	| { kind: "conflicting"; identityKeys: string[] }
	| { kind: "current"; path: string; identityKey: string; token: string; entity: FileEntity };

export type PriorityObservation =
	| { kind: "missing" | "unverifiable" | "structural"; occupant: PriorityPathOccupant }
	| {
		kind: "current";
		path: string;
		identityKey: string;
		token: string;
		entity: FileEntity;
		occupant: Extract<PriorityPathOccupant, { kind: "current" }>;
	};

export type PriorityReadResult =
	| { kind: "content"; content: ArrayBuffer }
	| { kind: "target_changed" | "unverifiable" };

export interface PriorityObservationCapability {
	observe(request: PriorityObservationRequest): Promise<PriorityObservation>;
	read(observation: Extract<PriorityObservation, { kind: "current" }>): Promise<PriorityReadResult>;
}

interface IdEntryShape<T> {
	id(entry: T): string | undefined;
	name(entry: T): string | undefined;
	parents(entry: T): readonly string[] | undefined;
	isFolder(entry: T): boolean;
}

/** Resolve exactly one complete, request-local parent chain to the configured root. */
export async function resolveDetachedIdPath<T>(
	target: T,
	rootId: string,
	fetch: (id: string) => Promise<T | null>,
	shape: IdEntryShape<T>,
): Promise<string | null> {
	const memo = new Map<string, string[] | null>();
	const resolve = async (entry: T, visiting: Set<string>, depth: number): Promise<string[] | null> => {
		if (depth > 128) return null;
		const id = shape.id(entry);
		const name = shape.name(entry);
		const parents = shape.parents(entry);
		if (!id || !name || name.includes("/") || !parents || parents.length === 0) return null;
		const cached = memo.get(id);
		if (cached !== undefined) return cached;
		if (visiting.has(id)) return null;
		visiting.add(id);
		const candidates = new Set<string>();
		for (const parentId of parents) {
			if (!parentId) continue;
			if (parentId === rootId) {
				candidates.add(name);
				continue;
			}
			const parent = await fetch(parentId);
			if (!parent || !shape.isFolder(parent)) continue;
			const parentPaths = await resolve(parent, visiting, depth + 1);
			if (parentPaths) for (const parentPath of parentPaths) candidates.add(`${parentPath}/${name}`);
		}
		visiting.delete(id);
		const result = candidates.size === 1 ? [...candidates] : null;
		memo.set(id, result);
		return result;
	};
	const paths = await resolve(target, new Set(), 0);
	return paths?.[0] ?? null;
}
