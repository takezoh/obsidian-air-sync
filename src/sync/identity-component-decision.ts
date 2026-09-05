/* eslint max-lines: ["error", 600] -- current-fact binding and final authorization stay under one identity-policy owner. */
import type { FileEntity } from "../fs/types";
import type { IdentityComponent } from "./plan-admission-graph";
import { selectReportFamily } from "./identity-component-report-family";
import { compareContent } from "./decision-engine";
import { sameContent, sameSynchronizedContent } from "./content-identity";
import { isDotPrefixed } from "../utils/path";
import type {
	PathObservation, RenameEvidence, ScopeProjection, SyncAction, SyncRecord,
	RecordPublication, RenameContent, SyncSide,
} from "./types";

export type AdmissionFailureReason =
	| "conflicting_identity" | "identity_postcondition_unproven"
	| "incomplete_folder_mapping" | "present_unresolved"
	| "rename_mismatch" | "unknown_observation" | "unknown_scope"
	| "remote_identity_missing" | "case_alias_content_mismatch"
	| "tracked_identity_multiple_occurrences";

export interface IdentityComponentDecision {
	readonly component: IdentityComponent & { actions: SyncAction[] };
	readonly reasons: readonly AdmissionFailureReason[];
}

interface CurrentFacts {
	readonly local: ReadonlyMap<string, FileEntity>;
	readonly remote: ReadonlyMap<string, FileEntity>;
	readonly records: ReadonlyMap<string, SyncRecord>;
	readonly observations: readonly PathObservation[];
	readonly observationsByAddress: ReadonlyMap<string, readonly PathObservation[]>;
	readonly scope: ScopeProjection;
}

interface BoundFile {
	readonly path: string;
	readonly local?: FileEntity;
	readonly remote?: FileEntity;
	readonly baseline?: SyncRecord;
	readonly publication: RecordPublication;
	readonly move?: { readonly side: SyncSide; readonly from: string };
	/** Different current identities share this address: equality or preservation. */
	readonly replacement?: boolean;
	readonly localPath?: string;
	readonly remotePath?: string;
	readonly remoteIdentitySource?: FileEntity;
	readonly additionalRemote?: FileEntity;
	readonly additionalLocal?: FileEntity;
	/** A preceding bound identity leaves this address through its admitted move. */
	readonly releasedRemote?: boolean;
}

/** A current endpoint relation, without inventing report provenance for aliases. */
interface FolderRelation {
	readonly side: SyncSide;
	readonly oldPath: string;
	readonly newPath: string;
}

/** Bind current topology first. No proposed action participates in this decision. */
export function decideIdentityComponent(
	component: IdentityComponent,
	scope: ScopeProjection,
	baselinePaths?: ReadonlySet<string>,
): IdentityComponentDecision {
	const fail = (reason: AdmissionFailureReason): IdentityComponentDecision => ({
		component: { ...component, actions: [] }, reasons: [reason],
	});
	const current = indexFacts(component, scope);
	if (typeof current === "string") return fail(current);
	for (const path of component.paths) {
		if (baselinePaths?.has(path) && !current.records.has(path)) return fail("unknown_observation");
	}
	const reports = selectReportFamily(component.evidence.filter(
		(item): item is RenameEvidence => item.kind === "rename",
	));
	if (reports.kind === "conflicting") return fail("rename_mismatch");
	for (const entry of component.entries) {
		for (const entity of [entry.local, entry.remote]) {
			if (entity && !compatible(current, entry.path, entity.path)) return fail("unknown_scope");
		}
	}
	const selected = reports.kind === "reported" ? reports.reports : [];
	for (const report of selected) {
		if (!compatible(current, report.oldPath, report.newPath)) return fail("unknown_scope");
		if (report.side === "remote" && report.identityKey &&
			current.remote.get(report.newPath)?.identityKey !== report.identityKey) return fail("conflicting_identity");
	}
	for (const claim of component.evidence) {
		if (claim.kind !== "alias") continue;
		if (!compatible(current, claim.requestedPath, claim.resolvedPath)) return fail("unknown_scope");
		if (!observationsAt(current, claim.side, claim.requestedPath).some((item) =>
			item.kind === "alias" && item.resolvedPath === claim.resolvedPath)) return fail("unknown_observation");
	}
	for (const observation of component.observations) {
		if (observation.kind === "alias" &&
			!compatible(current, observation.requestedPath, observation.resolvedPath)) return fail("unknown_scope");
	}
	const folders = reports.kind === "reported"
		? reports.governingReports.filter((report) => report.isFolder) : [];
	const folder = folders.find((report) => !settledRelation(current, report)) ??
		aliasFolder(current);
	if (folder) {
		const actions = decideFolder(current, folder);
		return typeof actions === "string" ? fail(actions) : { component: { ...component, actions }, reasons: [] };
	}
	const bound = bindFiles(current, selected.filter((report) => !committedRelation(current, report)));
	if (typeof bound === "string") return fail(bound);
	const actions: SyncAction[] = [];
	for (const file of bound) {
		const action = materializeStandaloneFile(file, current);
		if (typeof action === "string") return fail(action);
		if (action) actions.push(action);
	}
	for (const report of selected) {
		if (settledRelation(current, report)) continue;
		// A notification may describe an intermediate address that no longer
		// exists. Only complete current absence and no committed keys retire it.
		if (report.side === "local" && [report.oldPath, report.newPath].every((path) =>
			!current.records.has(path) && absent(current, "local", path) && absent(current, "remote", path))) continue;
		const accounted = bound.some((file) =>
			(file.path === report.newPath || (report.side === "remote" && file.remote?.path === report.newPath)) &&
			(file.publication.source?.path === report.oldPath || file.move?.from === report.oldPath ||
				(!file.baseline && (absent(current, "remote", report.oldPath) ||
					(report.side === "remote" && file.remote?.identityKey !== undefined &&
						current.remote.get(report.oldPath)?.identityKey !== undefined &&
						file.remote.identityKey !== current.remote.get(report.oldPath)?.identityKey)))));
		if (!accounted) return fail("rename_mismatch");
	}
	return { component: { ...component, actions }, reasons: [] };
}

function indexFacts(component: IdentityComponent, scope: ScopeProjection): CurrentFacts | AdmissionFailureReason {
	const local = new Map<string, FileEntity>();
	const remote = new Map<string, FileEntity>();
	const records = new Map<string, SyncRecord>();
	const observationsByAddress = new Map<string, PathObservation[]>();
	const insert = (side: SyncSide, entity: FileEntity): boolean => {
		const target = side === "local" ? local : remote;
		const prior = target.get(entity.path);
		if (prior && ((prior.identityKey && entity.identityKey && prior.identityKey !== entity.identityKey) ||
			(prior.hash && entity.hash && prior.hash !== entity.hash) || prior.isDirectory !== entity.isDirectory)) return false;
		// An empty list hash cannot erase stat/hash-enriched current facts.
		target.set(entity.path, prior?.hash && !entity.hash ? prior : entity);
		return true;
	};
	for (const observation of component.observations) {
		const key = `${observation.side}\0${observation.requestedPath}`;
		const atAddress = observationsByAddress.get(key) ?? [];
		atAddress.push(observation);
		observationsByAddress.set(key, atAddress);
		if (observation.kind === "unknown") return "unknown_observation";
		if (observation.kind === "present_unresolved") return "present_unresolved";
		if (observation.kind === "exact" || observation.kind === "alias") {
			if (observation.entity.pathAuthority !== "actual_resolved") return "present_unresolved";
			const actual = observation.kind === "exact" ? observation.requestedPath : observation.resolvedPath;
			if (observation.entity.path !== actual || !insert(observation.side, observation.entity)) return "conflicting_identity";
		}
	}
	for (const entry of component.entries) {
		if (scope.byEndpoint.get(entry.path) !== "included") return "unknown_scope";
		if ([entry.local, entry.remote].some((entity) => entity && entity.pathAuthority !== "actual_resolved")) return "present_unresolved";
		if (entry.local && !insert("local", entry.local)) return "conflicting_identity";
		if (entry.remote && !insert("remote", entry.remote)) return "conflicting_identity";
		if (entry.prevSync) {
			const prior = records.get(entry.prevSync.path);
			if (prior && JSON.stringify(prior) !== JSON.stringify(entry.prevSync)) return "conflicting_identity";
			records.set(entry.prevSync.path, entry.prevSync);
		}
	}
	const identities = new Map<string, string>();
	for (const entity of remote.values()) {
		const counterpart = local.get(entity.path);
		if (counterpart && counterpart.isDirectory !== entity.isDirectory) return "conflicting_identity";
		if (!entity.identityKey) continue;
		const prior = identities.get(entity.identityKey);
		if (prior && prior !== entity.path) return "tracked_identity_multiple_occurrences";
		identities.set(entity.identityKey, entity.path);
	}
	for (const evidence of component.evidence) {
		if (evidence.kind !== "stable_identity") continue;
		const paths = new Set(evidence.occurrences.filter((item) => item.phase === "current").map((item) => item.path));
		if (paths.size > 1) return "tracked_identity_multiple_occurrences";
		for (const path of paths) {
			if (remote.get(path)?.identityKey !== evidence.identityKey) return "conflicting_identity";
		}
	}
	for (const observation of component.observations) {
		if (observation.kind === "absent" &&
			(observation.side === "local" ? local : remote).has(observation.requestedPath)) return "conflicting_identity";
	}
	return { local, remote, records, observations: component.observations, observationsByAddress, scope };
}

function bindFiles(facts: CurrentFacts, reports: readonly RenameEvidence[]): BoundFile[] | AdmissionFailureReason {
	const bound: BoundFile[] = [];
	const claimedLocal = new Set<string>();
	const claimedRemote = new Set<string>();
	const relocated = new Set<string>();
	const currentByIdentity = new Map([...facts.remote.values()].flatMap((entity) =>
		entity.identityKey ? [[entity.identityKey, entity] as const] : []));
	// Bind unbaselined reports before destination history can claim their endpoints.
	// A destination record is a replacement expectation, not the reported source.
	for (const report of reports) {
		if (report.side !== "local" || report.isFolder || facts.records.has(report.oldPath)) continue;
		const local = facts.local.get(report.newPath);
		const remote = facts.remote.get(report.oldPath);
		if (!local || !remote || local.isDirectory || remote.isDirectory) continue;
		const additionalRemote = facts.remote.get(report.newPath);
		if (!additionalRemote && !vacant(facts, "remote", report.newPath, report.oldPath)) return "unknown_observation";
		bound.push({ path: report.newPath, local, remote, move: { side: "remote", from: report.oldPath },
			remoteIdentitySource: remote, additionalRemote, replacement: !!additionalRemote,
			publication: { source: undefined, destination: facts.records.get(report.newPath) } });
		claimedLocal.add(local.path);
		claimedRemote.add(remote.path);
		if (additionalRemote) claimedRemote.add(additionalRemote.path);
		relocated.add(report.oldPath);
	}
	for (const baseline of facts.records.values()) {
		const remoteReport = reports.find((report) => report.side === "remote" &&
			!report.isFolder && report.oldPath === baseline.path);
		const trackedRemote = baseline.remoteIdentityKey
			? currentByIdentity.get(baseline.remoteIdentityKey)
			: facts.remote.get(remoteReport?.newPath ?? baseline.path);
		const localReport = reports.find((report) => report.side === "local" &&
			!report.isFolder && report.oldPath === baseline.path);
		const remote = trackedRemote ?? (localReport ? facts.remote.get(localReport.newPath) : undefined);
		const local = localReport ? facts.local.get(localReport.newPath) : resolveLocal(facts, baseline.path) ??
			(remote && absent(facts, "local", baseline.path) ? facts.local.get(remote.path) : undefined);
		if (remote?.isDirectory || local?.isDirectory) continue;
		// Historical records at another identity's current destination are exact
		// replacement expectations, not duplicate current-identity claims.
		if (!remote && baseline.remoteIdentityKey && facts.remote.get(baseline.path)?.identityKey &&
			facts.remote.get(baseline.path)?.identityKey !== baseline.remoteIdentityKey) continue;
		const path = localReport && local ? local.path : remote?.path !== baseline.path && remote
			? remote.path : local?.path ?? remote?.path ?? baseline.path;
		if (!compatible(facts, baseline.path, path)) return "unknown_scope";
		if (remote && claimedRemote.has(remote.path)) continue;
		const recreated = path !== baseline.path && facts.remote.has(baseline.path) &&
			facts.remote.get(baseline.path)?.identityKey !== baseline.remoteIdentityKey;
		const destinationLocal = recreated ? facts.local.get(path) : local;
		const move: BoundFile["move"] = !recreated && local && remote && local.path !== remote.path
			? { side: path === local.path ? "remote" : "local",
				from: path === local.path ? remote.path : local.path } : undefined;
		const additionalRemote = move?.side === "remote" && remote?.path !== path ? facts.remote.get(path) : undefined;
		if (move && !additionalRemote && !vacant(facts, move.side, path, move.from)) return "conflicting_identity";
		bound.push({ path, local: destinationLocal, remote,
			// The local source belongs to the later source-address decision. Its
			// existence cannot turn an unmaterialized destination into a deletion.
			baseline: recreated ? undefined : baseline, move,
			remoteIdentitySource: trackedRemote, additionalRemote,
			additionalLocal: recreated && destinationLocal && remote && !equal(destinationLocal, remote) ? destinationLocal : undefined,
			replacement: (recreated && !!destinationLocal) || !!additionalRemote ||
				(!!remote && !!baseline.remoteIdentityKey && remote.identityKey !== baseline.remoteIdentityKey),
			publication: { source: baseline, destination: facts.records.get(path) } });
		if (destinationLocal) claimedLocal.add(destinationLocal.path);
		if (remote) claimedRemote.add(remote.path);
		if (additionalRemote) claimedRemote.add(additionalRemote.path);
		if (baseline.path !== path) relocated.add(baseline.path);
	}
	// A provider relation can connect two distinct current remote resources even
	// when no source baseline was captured. Bind the destination before comparing
	// the independent source-address contents; neither operation moves that source.
	for (const report of reports) {
		if (report.side !== "remote" || report.isFolder || claimedRemote.has(report.newPath)) continue;
		const remote = facts.remote.get(report.newPath);
		const occupant = facts.remote.get(report.oldPath);
		if (!remote?.identityKey || !occupant?.identityKey || remote.identityKey === occupant.identityKey) continue;
		const local = facts.local.get(report.newPath);
		bound.push({ path: report.newPath, local, remote, replacement: !!local,
			additionalLocal: local && !equal(local, remote) ? local : undefined,
			publication: { source: undefined, destination: facts.records.get(report.newPath) } });
		if (local) claimedLocal.add(local.path);
		claimedRemote.add(remote.path);
	}
	for (const observation of facts.observations) {
		if (observation.kind !== "alias" || observation.side !== "local" || observation.entity.isDirectory) continue;
		const local = facts.local.get(observation.resolvedPath);
		const remote = facts.remote.get(observation.requestedPath);
		if (!local || !remote || claimedLocal.has(local.path) || claimedRemote.has(remote.path)) continue;
		if (!remote.identityKey) return "remote_identity_missing";
		if (!vacant(facts, "remote", local.path, remote.path)) {
			return facts.remote.has(local.path) ? "conflicting_identity" : "unknown_observation";
		}
		if (!equal(local, remote)) return "case_alias_content_mismatch";
		bound.push({ path: local.path, local, remote, move: { side: "remote", from: remote.path },
			publication: { source: undefined, destination: facts.records.get(local.path) } });
		claimedLocal.add(local.path);
		claimedRemote.add(remote.path);
	}
	for (const path of new Set([...facts.local.keys(), ...facts.remote.keys()])) {
		const local = claimedLocal.has(path) ? undefined : facts.local.get(path);
		const remote = claimedRemote.has(path) ? undefined : facts.remote.get(path);
		if ((!local && !remote) || local?.isDirectory || remote?.isDirectory) continue;
		const baseline = facts.records.get(path);
		const expected = relocated.has(path) ? undefined : baseline;
		const releasedRemote = !remote && claimedRemote.has(path) &&
			bound.some((file) => file.move?.side === "remote" && file.move.from === path);
		bound.push({ path, local, remote, baseline: releasedRemote ? undefined : baseline, releasedRemote,
			publication: { source: expected, destination: expected },
			replacement: relocated.has(path) || (!!baseline?.remoteIdentityKey && !!remote?.identityKey &&
				baseline.remoteIdentityKey !== remote.identityKey) });
	}
	return bound;
}

function materializeStandaloneFile(file: BoundFile, facts: CurrentFacts): SyncAction | AdmissionFailureReason | null {
	const action = materializeFile(file, facts);
	if (!action && file.baseline?.path !== file.path && file.local && file.remote) {
		if (!sameSynchronizedContent(file.local, file.remote, file.baseline)) return "identity_postcondition_unproven";
		return { action: "match", path: file.path, local: file.local, remote: file.remote,
			baseline: file.baseline, publication: file.publication };
	}
	return action;
}

function materializeFile(file: BoundFile, facts: CurrentFacts): SyncAction | AdmissionFailureReason | null {
	const { path, local, remote, baseline, publication, move } = file;
	if (!local && !absent(facts, "local", file.localPath ?? path)) return "unknown_observation";
	if (!remote && !file.releasedRemote && !absent(facts, "remote", file.remotePath ?? path)) return "unknown_observation";
	const compared = compareContent({ path, local, remote, prevSync: baseline });
	const kind = file.replacement && local && remote
		? !file.additionalRemote && equal(local, remote) ? "match" : "conflict" : compared;
	if (!move && kind === "delete_local" && !observationsAt(facts, "remote", file.remotePath ?? path).some((item) =>
		item.kind === "absent" && item.authority === "checkpoint_deleted")) return "unknown_observation";
	if (kind === "delete_local" || kind === "delete_remote") {
		// Delete the captured record at its committed key, and perform I/O at the
		// current endpoint. A parent's spelling must not redirect a child delete.
		return { action: kind, path: baseline?.path ?? path, local, remote, baseline,
			localPath: local?.path ?? file.localPath ?? path,
			remotePath: remote?.path ?? file.remotePath ?? path,
			publication: { source: baseline, destination: baseline } };
	}
	if (move) {
		if (!local || !remote || (!remote.identityKey && !equal(local, remote))) return "remote_identity_missing";
		if (kind === "conflict") return {
			action: "conflict", path, local, remote, baseline, publication,
			remoteIdentitySource: file.remoteIdentitySource, additionalRemote: file.additionalRemote, additionalLocal: file.additionalLocal,
		};
		let content: RenameContent;
		if (sameSynchronizedContent(local, remote, baseline)) content = { mode: "equal" };
		else if (kind === "push" || kind === "pull") {
			const readSide = kind === "push" ? "local" : "remote";
			content = { mode: "copy", read: { side: readSide, entity: kind === "push" ? local : remote },
				write: { side: kind === "push" ? "remote" : "local", path } };
		} else return "identity_postcondition_unproven";
		return { action: move.side === "local" ? "rename_local" : "rename_remote",
			oldPath: move.from, path, local, remote, baseline, publication, content };
	}
	if (kind) return { action: kind, path, local, remote, baseline, publication,
		...(kind === "conflict" ? { remoteIdentitySource: file.remoteIdentitySource,
			additionalRemote: file.additionalRemote, additionalLocal: file.additionalLocal } : {}),
		...(file.localPath ? { localPath: file.localPath } : {}),
		...(file.remotePath ? { remotePath: file.remotePath } : {}),
	};
	return null;
}

function equal(local: FileEntity, remote: FileEntity): boolean {
	return local.size === remote.size && sameContent(local, remote);
}

function aliasFolder(facts: CurrentFacts): FolderRelation | undefined {
	const candidates = facts.observations.filter((item) => item.kind === "alias" && item.entity.isDirectory)
		.sort((left, right) => left.requestedPath.length - right.requestedPath.length);
	for (const item of candidates) {
		if (item.kind !== "alias") continue;
		const other = item.side === "local" ? facts.remote : facts.local;
		if (other.has(item.requestedPath) && !other.has(item.resolvedPath)) {
			return { side: item.side, oldPath: item.requestedPath, newPath: item.resolvedPath };
		}
	}
	return undefined;
}

/** Bind the complete managed suffix mapping before creating child or root actions. */
function decideFolder(facts: CurrentFacts, folder: FolderRelation): SyncAction[] | AdmissionFailureReason {
	const { oldPath, newPath } = folder;
	if (!compatible(facts, oldPath, newPath)) return "unknown_scope";
	const moveSide = folder.side === "local" ? "remote" : "local";
	const moving = moveSide === "local" ? facts.local : facts.remote;
	const settled = moveSide === "local" ? facts.remote : facts.local;
	const source = moving.get(oldPath);
	const destination = settled.get(newPath);
	// LocalFs can move files, but not directories, across its hidden-path adapter
	// boundary. Select the supported mechanism from current paths, not failures.
	const moveRoot = moveSide !== "local" || isDotPrefixed(oldPath) === isDotPrefixed(newPath);
	if (!source?.isDirectory || !destination?.isDirectory ||
		(moveRoot ? !vacant(facts, moveSide, newPath, oldPath)
			: moving.has(newPath) && !moving.get(newPath)!.isDirectory)) {
		return "incomplete_folder_mapping";
	}
	// A root relation moves suffixes unchanged. An observed alias is a current
	// topology claim too; equal bytes cannot excuse a different suffix binding.
	for (const item of facts.observations) {
		if (item.kind !== "alias") continue;
		const from = item.side === moveSide ? newPath : oldPath;
		const to = item.side === moveSide ? oldPath : newPath;
		if ((item.requestedPath === from || item.requestedPath.startsWith(from + "/")) &&
			item.resolvedPath !== to + item.requestedPath.slice(from.length)) return "incomplete_folder_mapping";
	}
	const suffixes = new Set<string>();
	for (const entity of [...facts.local.values(), ...facts.remote.values()]) {
		if (entity.isDirectory) continue;
		if (entity.path.startsWith(oldPath + "/")) suffixes.add(entity.path.slice(oldPath.length + 1));
		else if (entity.path.startsWith(newPath + "/")) suffixes.add(entity.path.slice(newPath.length + 1));
		else return "incomplete_folder_mapping";
	}
	for (const record of facts.records.values()) {
		if (record.path.startsWith(oldPath + "/")) suffixes.add(record.path.slice(oldPath.length + 1));
		else if (record.path.startsWith(newPath + "/")) suffixes.add(record.path.slice(newPath.length + 1));
		else return "incomplete_folder_mapping";
	}
	const bindings: BoundFile[] = [];
	for (const suffix of [...suffixes].sort()) {
		const from = oldPath + "/" + suffix;
		const to = newPath + "/" + suffix;
		if (!compatible(facts, from, to)) return "unknown_scope";
		const localPath = moveSide === "remote" ? to : !moveRoot && !moving.has(from) ? to : from;
		const remotePath = moveSide === "remote" ? from : to;
		const local = facts.local.get(localPath);
		const remote = facts.remote.get(remotePath);
		if (local?.isDirectory || remote?.isDirectory) return "incomplete_folder_mapping";
		if ((moveRoot ? moving.has(to) : moving.has(to) && !absent(facts, "local", from)) || settled.has(from)) return "conflicting_identity";
		if (!moveRoot && !moving.has(from) && !absent(facts, "local", from)) return "unknown_observation";
		const baseline = facts.records.get(from) ?? facts.records.get(to);
		if (baseline?.remoteIdentityKey && remote?.identityKey !== baseline.remoteIdentityKey && remote) {
			return "conflicting_identity";
		}
		bindings.push({ path: remotePath, local, remote, baseline, localPath, remotePath,
			publication: { source: baseline, destination: facts.records.get(remotePath) } });
	}
	const actions: SyncAction[] = [];
	const descendantRecords: NonNullable<Extract<SyncAction, { action: "rename_remote" | "rename_local" }>["descendantRecords"]>[number][] = [];
	for (const file of bindings) {
		const child = moveRoot ? materializeFile(file, facts) : materializeStandaloneFile(
			file.local && file.remote && file.local.path !== file.path
				? { ...file, move: { side: "local", from: file.local.path } } : file, facts);
		if (typeof child === "string") return child;
		if (!child && (!file.local || !file.remote || !sameSynchronizedContent(file.local, file.remote, file.baseline))) {
			return "identity_postcondition_unproven";
		}
		if (child) actions.push(child);
		if (child?.action === "delete_local" || child?.action === "delete_remote" || child?.action === "cleanup") continue;
		const suffix = file.path.slice((moveSide === "remote" ? oldPath : newPath).length + 1);
		const target = newPath + "/" + suffix;
		descendantRecords.push({ oldPath: file.path, newPath: target,
			source: file.baseline,
			destination: child?.publication?.source?.path === target && child.path !== target
				? undefined : facts.records.get(target),
			...(child ? { after: child } : {}),
		});
	}
	if (!moveRoot) return actions;
	actions.push({ action: moveSide === "remote" ? "rename_remote" : "rename_local",
		oldPath, path: newPath, isFolder: true,
		local: moveSide === "remote" ? destination : source,
		remote: moveSide === "remote" ? source : destination,
		descendants: [...suffixes].sort().map((suffix) => ({ oldPath: oldPath + "/" + suffix, newPath: newPath + "/" + suffix })),
		descendantRecords,
	});
	return actions;
}

function compatible(facts: CurrentFacts, from: string, to: string): boolean {
	return facts.scope.byEndpoint.get(from) === "included" && facts.scope.byEndpoint.get(to) === "included" &&
		facts.scope.isConfiguredScopeCompatible(from, to);
}

function absent(facts: CurrentFacts, side: SyncSide, path: string): boolean {
	return observationsAt(facts, side, path).some((item) => item.kind === "absent");
}

function vacant(facts: CurrentFacts, side: SyncSide, path: string, source: string): boolean {
	return observationsAt(facts, side, path).some((item) =>
		((item.kind === "absent" && item.authority === "stat") ||
			(item.kind === "alias" && item.resolvedPath === source)));
}

function resolveLocal(facts: CurrentFacts, path: string): FileEntity | undefined {
	const alias = observationsAt(facts, "local", path).find((item) => item.kind === "alias");
	return alias?.kind === "alias" ? facts.local.get(alias.resolvedPath) : facts.local.get(path);
}

function committedRelation(facts: CurrentFacts, report: RenameEvidence): boolean {
	const targetRecord = facts.records.get(report.newPath);
	const sourceRecord = facts.records.get(report.oldPath);
	const aligned = (path: string, record: SyncRecord) => {
		const local = facts.local.get(path);
		const remote = facts.remote.get(path);
		return local && remote && remote.identityKey === record.remoteIdentityKey &&
			sameSynchronizedContent(local, remote, record);
	};
	const sourceLocal = facts.local.get(report.oldPath);
	const sourceRemote = facts.remote.get(report.oldPath);
	const sourceAccounted = absent(facts, report.side === "local" ? "remote" : "local", report.oldPath) ||
		(!!report.identityKey && report.identityKey === targetRecord?.remoteIdentityKey) ||
		(!!sourceLocal && !!sourceRemote && sourceRemote.identityKey !== targetRecord?.remoteIdentityKey &&
			sameSynchronizedContent(sourceLocal, sourceRemote));
	return !!(!report.isFolder && targetRecord && aligned(report.newPath, targetRecord) &&
		(sourceRecord ? sourceRecord.remoteIdentityKey !== targetRecord.remoteIdentityKey && aligned(report.oldPath, sourceRecord)
			: sourceAccounted));
}

function settledRelation(facts: CurrentFacts, report: RenameEvidence): boolean {
	if (committedRelation(facts, report)) return true;
	return (["local", "remote"] as const).every((side) => {
		const target = (side === "local" ? facts.local : facts.remote).get(report.newPath);
		return target !== undefined && (absent(facts, side, report.oldPath) || observationsAt(facts, side, report.oldPath).some((item) =>
			item.kind === "alias" && item.resolvedPath === report.newPath));
	});
}

function observationsAt(facts: CurrentFacts, side: SyncSide, path: string): readonly PathObservation[] {
	return facts.observationsByAddress.get(`${side}\0${path}`) ?? [];
}
