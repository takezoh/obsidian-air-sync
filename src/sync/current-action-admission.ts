import type { IFileSystem } from "../fs/interface";
import type { PriorityObservation } from "../fs/priority-observation";
import type { FileEntity } from "../fs/types";
import type { NoActionFreshnessWitness } from "./execution-result";
import type { LocalChangeTracker } from "./local-tracker";
import type { AuthorizedMemberObligation } from "./plan-authority";
import { planSync } from "./decision-engine";
import type { SyncStateStore } from "./state";
import type { SyncAction, SyncRecord } from "./types";

export type CurrentActionAdmission =
	| { kind: "run"; action: SyncAction; boundRemoteContent?: ArrayBuffer;
		boundLocalContent?: ArrayBuffer; validateBeforeEffect?: () => Promise<boolean>;
		validateBeforeCommit?: (expectedLocal?: FileEntity | null) => Promise<boolean> }
	| { kind: "no_action"; freshness: NoActionFreshnessWitness }
	| { kind: "nonterminal"; reason: string };

export interface CurrentActionAdmissionContext {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	stateStore: SyncStateStore;
	localTracker: LocalChangeTracker;
}

function recordFingerprint(record: SyncRecord | undefined): string {
	return record ? `record:${JSON.stringify(record)}` : "record:absent";
}

function entityStampMatches(current: FileEntity | null, expected: FileEntity | undefined): boolean {
	if (!current || !expected) return current === null && expected === undefined;
	if (current.identityKey && expected.identityKey && current.identityKey !== expected.identityKey) return false;
	if (current.hash && expected.hash) return current.hash === expected.hash && current.size === expected.size;
	return current.mtime === expected.mtime && current.size === expected.size &&
		current.isDirectory === expected.isDirectory;
}

function entityFingerprint(entity: FileEntity | null | undefined): string {
	return entity ? `entity:${JSON.stringify({
		path: entity.path, identityKey: entity.identityKey, isDirectory: entity.isDirectory,
		size: entity.size, mtime: entity.mtime, hash: entity.hash,
	})}` : "entity:absent";
}

function observationWitnessMatches(current: PriorityObservation, expected: PriorityObservation): boolean {
	if (current.kind !== expected.kind) return false;
	if (current.kind === "current" && expected.kind === "current" &&
		(current.path !== expected.path || current.identityKey !== expected.identityKey ||
			current.token !== expected.token)) return false;
	const currentOccupant = current.occupant;
	const expectedOccupant = expected.occupant;
	if (currentOccupant.kind !== expectedOccupant.kind) return false;
	if (currentOccupant.kind === "current" && expectedOccupant.kind === "current") {
		return currentOccupant.path === expectedOccupant.path &&
			currentOccupant.identityKey === expectedOccupant.identityKey &&
			currentOccupant.token === expectedOccupant.token;
	}
	if (currentOccupant.kind === "conflicting" && expectedOccupant.kind === "conflicting") {
		return JSON.stringify([...currentOccupant.identityKeys].sort()) ===
			JSON.stringify([...expectedOccupant.identityKeys].sort());
	}
	return true;
}

export async function admitCurrentAction(
	ctx: CurrentActionAdmissionContext,
	action: SyncAction,
	member: AuthorizedMemberObligation,
): Promise<CurrentActionAdmission> {
	const { localFs, remoteFs, stateStore, localTracker } = ctx;
	if (action.action === "rename_remote" || action.action === "rename_local") {
		if (!remoteFs.priority) return { kind: "run", action };
		const baselinePath = action.baseline?.path ?? action.oldPath;
		const expectedIdentity = action.remote?.identityKey ?? action.baseline?.remoteIdentityKey;
		const [baselineNow, localSource, localDestination, remoteSource, remoteDestination] =
			await Promise.all([
				stateStore.get(baselinePath), localFs.stat(action.oldPath), localFs.stat(action.path),
				remoteFs.priority.observe({
					path: action.action === "rename_remote" ? action.oldPath : action.path,
					identityKey: expectedIdentity,
				}),
				action.action === "rename_remote"
					? remoteFs.priority.observe({ path: action.path }) : Promise.resolve(null),
			]);
		const extraPaths = member.componentPaths.filter((path) =>
			path !== action.oldPath && path !== action.path);
		const [, extraRemote] = await Promise.all([
			Promise.all(extraPaths.map((path) => localFs.stat(path))),
			Promise.all(extraPaths.map((path) => {
				const identityKey = member.componentRemoteIdentities[path];
				return remoteFs.priority!.observe({ path,
					identityKey: identityKey ?? undefined });
			})),
		]);
		if (extraRemote.some((observation, index) => {
			const expected = member.componentRemoteIdentities[extraPaths[index]!];
			if (expected === undefined) return true;
			if (expected === null) {
				return observation.kind !== "missing" || observation.occupant.kind !== "absent";
			}
			return observation.kind !== "current" || observation.identityKey !== expected;
		}) ||
			recordFingerprint(baselineNow) !== recordFingerprint(action.baseline) ||
			remoteSource.kind !== "current" || remoteSource.identityKey !== expectedIdentity) {
			return { kind: "nonterminal", reason: "structural_reobservation_required" };
		}
		if (action.action === "rename_remote") {
			const destinationAbsent = remoteDestination?.kind === "missing" &&
				remoteDestination.occupant.kind === "absent";
			if (!destinationAbsent || !entityStampMatches(localDestination, action.local)) {
				return { kind: "nonterminal", reason: "structural_reobservation_required" };
			}
			return { kind: "run", action };
		}
		const destinationIsSourceAlias = !!localDestination && !!localSource &&
			localDestination.path.toLocaleLowerCase() === localSource.path.toLocaleLowerCase() &&
			entityStampMatches(localDestination, localSource);
		if (!entityStampMatches(localSource, action.local) ||
			(localDestination !== null && !destinationIsSourceAlias)) {
			return { kind: "nonterminal", reason: "structural_reobservation_required" };
		}
		return { kind: "run", action };
	}

	const expectedGeneration = localTracker.generation(action.path);
	const [currentRecord, currentLocal] = await Promise.all([
		stateStore.get(action.path), localFs.stat(action.path),
	]);
	const observed = remoteFs.priority ? await remoteFs.priority.observe({
		path: action.path,
		identityKey: currentRecord?.remoteIdentityKey ?? action.remote?.identityKey,
	}) : null;
	if (observed?.kind === "unverifiable" || observed?.kind === "structural") {
		return { kind: "nonterminal", reason: `current_observation_${observed.kind}` };
	}
	const currentRemote = observed
		? (observed.kind === "current" ? observed.entity : undefined)
		: await remoteFs.stat(action.path) ?? undefined;
	const replanned = planSync([{ path: action.path, local: currentLocal ?? undefined,
		remote: currentRemote, prevSync: currentRecord }]).actions[0];
	if (replanned) {
		let boundLocalContent: ArrayBuffer | undefined;
		let validateBeforeEffect: (() => Promise<boolean>) | undefined;
		let validateBeforeCommit:
			((expectedLocal?: FileEntity | null) => Promise<boolean>) | undefined;
		const validateOriginalLocal = async () => {
			const [recordAtEffect, localAtEffect] = await Promise.all([
				stateStore.get(action.path), localFs.stat(action.path),
			]);
			return localTracker.generation(action.path) === expectedGeneration &&
				recordFingerprint(recordAtEffect) === recordFingerprint(currentRecord) &&
				entityStampMatches(localAtEffect, currentLocal ?? undefined);
		};
		if (replanned.action === "conflict") {
			validateBeforeEffect = validateOriginalLocal;
			validateBeforeCommit = async (expectedLocal = currentLocal) => {
				const [recordAtCommit, localAtCommit] = await Promise.all([
					stateStore.get(action.path), localFs.stat(action.path),
				]);
				const originalPathUnchanged = entityStampMatches(
					expectedLocal, currentLocal ?? undefined,
				);
				return (!originalPathUnchanged ||
					localTracker.generation(action.path) === expectedGeneration) &&
					recordFingerprint(recordAtCommit) === recordFingerprint(currentRecord) &&
					entityStampMatches(localAtCommit, expectedLocal ?? undefined);
			};
		}
		if ((replanned.action === "push" || replanned.action === "conflict") && currentLocal) {
			boundLocalContent = await localFs.read(action.path);
			const [recordAfterRead, localAfterRead] = await Promise.all([
				stateStore.get(action.path), localFs.stat(action.path),
			]);
			if (localTracker.generation(action.path) !== expectedGeneration ||
				recordFingerprint(recordAfterRead) !== recordFingerprint(currentRecord) ||
				!entityStampMatches(localAfterRead, currentLocal)) {
				return { kind: "nonterminal", reason: "current_local_content_invalidated" };
			}
			if (replanned.action === "push") {
				validateBeforeCommit = validateOriginalLocal;
			}
		}
		if ((replanned.action === "push" || replanned.action === "conflict") &&
			observed && remoteFs.priority) {
			const validateLocalAndRecord = validateBeforeEffect ?? validateOriginalLocal;
			const expectedRemote = observed;
			validateBeforeEffect = async () => {
				const [localAndRecordCurrent, remoteCurrent] = await Promise.all([
					validateLocalAndRecord(),
					remoteFs.priority!.observe({
						path: action.path,
						identityKey: expectedRemote.kind === "current"
							? expectedRemote.identityKey
							: currentRecord?.remoteIdentityKey ?? action.remote?.identityKey,
					}),
				]);
				return localAndRecordCurrent &&
					observationWitnessMatches(remoteCurrent, expectedRemote);
			};
		}
		if ((replanned.action === "pull" || replanned.action === "conflict") &&
			observed?.kind === "current" && remoteFs.priority) {
			const read = await remoteFs.priority.read(observed);
			if (read.kind !== "content") {
				return { kind: "nonterminal", reason: `current_remote_${read.kind}` };
			}
			const [recordAfterRemoteRead, localAfterRemoteRead] = await Promise.all([
				stateStore.get(action.path), localFs.stat(action.path),
			]);
			if (localTracker.generation(action.path) !== expectedGeneration ||
				recordFingerprint(recordAfterRemoteRead) !== recordFingerprint(currentRecord) ||
				!entityStampMatches(localAfterRemoteRead, currentLocal ?? undefined)) {
				return { kind: "nonterminal", reason: "current_local_during_remote_read" };
			}
			return { kind: "run", action: replanned, boundRemoteContent: read.content,
				boundLocalContent, validateBeforeEffect, validateBeforeCommit };
		}
		return { kind: "run", action: replanned, boundLocalContent,
			validateBeforeEffect, validateBeforeCommit };
	}

	if (!observed || observed.occupant.kind === "unverifiable" ||
		observed.occupant.kind === "conflicting") {
		return { kind: "nonterminal", reason: "current_path_occupant_unverifiable" };
	}
	const [recordAfter, localAfter] = await Promise.all([
		stateStore.get(action.path), localFs.stat(action.path),
	]);
	if (localTracker.generation(action.path) !== expectedGeneration ||
		recordFingerprint(recordAfter) !== recordFingerprint(currentRecord) ||
		!entityStampMatches(localAfter, currentLocal ?? undefined)) {
		return { kind: "nonterminal", reason: "current_no_action_invalidated" };
	}
	const pathOccupant = observed.occupant.kind === "absent"
		? { kind: "absent" as const }
		: { kind: "current" as const, identityKey: observed.occupant.identityKey,
			token: observed.occupant.token };
	return { kind: "no_action", freshness: {
		localGeneration: expectedGeneration,
		localFingerprint: entityFingerprint(currentLocal),
		recordFingerprint: recordFingerprint(currentRecord),
		identityKey: observed.kind === "current" ? observed.identityKey : null,
		pathOccupant, frozenDeltaWitness: member.frozenDeltaWitness,
		componentId: member.componentId, memberObligationId: member.id,
		admissionEpoch: member.admissionEpoch,
	} };
}

export async function validateNoActionFreshness(
	ctx: CurrentActionAdmissionContext,
	path: string,
	witness: NoActionFreshnessWitness,
): Promise<boolean> {
	const { localFs, remoteFs, stateStore, localTracker } = ctx;
	if (!remoteFs.priority || localTracker.generation(path) !== witness.localGeneration) return false;
	const observation = await remoteFs.priority.observe({
		path, identityKey: witness.identityKey ?? undefined,
	});
	const [record, local] = await Promise.all([stateStore.get(path), localFs.stat(path)]);
	if (localTracker.generation(path) !== witness.localGeneration ||
		entityFingerprint(local) !== witness.localFingerprint) return false;
	if (recordFingerprint(record) !== witness.recordFingerprint) return false;
	if (witness.pathOccupant.kind === "absent") {
		return observation.kind === "missing" && observation.occupant.kind === "absent";
	}
	return observation.kind === "current" && observation.identityKey === witness.identityKey &&
		observation.occupant.kind === "current" &&
		observation.occupant.identityKey === witness.pathOccupant.identityKey &&
		observation.occupant.token === witness.pathOccupant.token;
}
