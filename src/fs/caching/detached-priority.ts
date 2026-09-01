import type { FileEntity } from "../types";
import type {
	PriorityObservation,
	PriorityObservationRequest,
	PriorityPathOccupant,
	PriorityReadResult,
} from "../priority-observation";

export interface DetachedPrioritySeams<TFile> {
	fetchIdentity(identityKey: string): Promise<TFile | null>;
	fetchPath(path: string): Promise<TFile[] | null>;
	resolvePath(file: TFile): Promise<string | null>;
	toEntity(path: string, file: TFile): FileEntity;
	versionToken(file: TFile): string | null;
}

/** Pair an admitted identity with an independent authoritative path observation. */
export async function observeDetachedPriority<TFile>(
	request: PriorityObservationRequest,
	seams: DetachedPrioritySeams<TFile>,
): Promise<PriorityObservation> {
	const [fresh, pathEntries] = await Promise.all([
		request.identityKey ? seams.fetchIdentity(request.identityKey) : Promise.resolve(null),
		seams.fetchPath(request.path),
	]);
	const occupant = classifyPathOccupant(request.path, pathEntries, seams);
	if (occupant.kind === "unverifiable" || occupant.kind === "conflicting") {
		return { kind: "unverifiable", occupant };
	}
	if (!request.identityKey) {
		return occupant.kind === "current" ? { ...occupant, occupant } : { kind: "missing", occupant };
	}
	if (!fresh) {
		return occupant.kind === "absent" ? { kind: "missing", occupant } : { kind: "structural", occupant };
	}
	const resolvedPath = await seams.resolvePath(fresh);
	if (resolvedPath !== request.path || occupant.kind !== "current") {
		return { kind: resolvedPath ? "structural" : "unverifiable", occupant };
	}
	const token = seams.versionToken(fresh);
	if (!token || occupant.identityKey !== request.identityKey || occupant.token !== token) {
		return { kind: "structural", occupant };
	}
	const entity = seams.toEntity(request.path, fresh);
	if (entity.identityKey !== request.identityKey || entity.path !== request.path) {
		return { kind: "unverifiable", occupant };
	}
	return { kind: "current", path: request.path, identityKey: request.identityKey, token, entity, occupant };
}

/** Read an observed identity and verify that the paired observation did not change. */
export async function readDetachedPriority(
	observation: Extract<PriorityObservation, { kind: "current" }>,
	download: (identityKey: string) => Promise<ArrayBuffer>,
	reobserve: (request: PriorityObservationRequest) => Promise<PriorityObservation>,
): Promise<PriorityReadResult> {
	const content = await download(observation.identityKey);
	const after = await reobserve({ path: observation.path, identityKey: observation.identityKey });
	if (after.kind !== "current" || after.token !== observation.token) return { kind: "target_changed" };
	return { kind: "content", content };
}

function classifyPathOccupant<TFile>(
	path: string,
	entries: TFile[] | null,
	seams: DetachedPrioritySeams<TFile>,
): PriorityPathOccupant {
	if (entries === null) return { kind: "unverifiable" };
	if (entries.length === 0) return { kind: "absent" };
	if (entries.length > 1) {
		return { kind: "conflicting", identityKeys: entries.map((entry) =>
			seams.toEntity(path, entry).identityKey ?? "").filter(Boolean).sort() };
	}
	const entity = seams.toEntity(path, entries[0]!);
	const token = seams.versionToken(entries[0]!);
	if (!entity.identityKey || !token || entity.path !== path) return { kind: "unverifiable" };
	return { kind: "current", path, identityKey: entity.identityKey, token, entity };
}
