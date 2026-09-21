// The scope-entry case below drives a real MetadataStore, so this file owns the
// IndexedDB shim rather than inheriting it from a helper imported for another scenario.
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GoogleDriveClient } from "../src/backends/googledrive/client";
import { createPlatformTransport } from "../src/fs/platform-http-transport";
import { GoogleDriveAdapter } from "../src/backends/googledrive/adapter";
import { ManagedRemoteFs } from "../src/fs/managed/managed-remote-fs";
import type { IFileSystem } from "../src/fs/interface";
import type { GoogleDriveFile } from "../src/backends/googledrive/types";
import type { IncrementalCheckpoint } from "../src/fs/interface";
import { bytes, decode, runIFileSystemContract } from "../tests/fs/contracts/ifilesystem.contract";
import { insertConflictSuffix } from "../src/sync/conflict";
import { planAddressContentionRemediation } from "../src/sync/plan-admission-address-contention";
import {
	createGoogleE2EAuth,
	GOOGLE_E2E_REFRESH_TOKEN_ENV,
	readGoogleE2ECreds,
} from "./helpers/google-auth";
import {
	cleanupGoogleDriveParent,
	makeGoogleDriveChild,
	makeGoogleDriveParent,
} from "./helpers/isolation";
import { runRenameSafetyE2E } from "./helpers/rename-safety";
import { runPriorityFidelityE2E } from "./helpers/priority-fidelity";
import type { MovedObjectIdentity } from "../tests/fs/contracts/caching-remote-fs.contract";

/**
 * What Google Drive's own entity projection makes of a moved object's identity, against
 * the LIVE API. Same disposition the family declares to the fake-backed managed contract
 * (`tests/backends/googledrive/managed.contract-harness.ts`) — stated separately here
 * because a fake that always hands over a complete resource cannot establish it for
 * `changes.list`, which is the whole point of ADR 0003.
 */
const GOOGLE_DRIVE_MOVED_OBJECT_IDENTITY: MovedObjectIdentity = {
	determinate: true,
	reason:
		"normalizeGoogleDriveObject sets RemoteObject.id from the Drive resource id for " +
		"files and folders alike, with no fallback, and every Drive resource carries an " +
		"id — googledrive/types.ts declares `id: string`, not an optional. A live " +
		"changes.list payload that omitted it would project no identity, so the pair would " +
		"name nothing and buildSyncRecord would refuse the record it feeds.",
};

/** The subtree `F` carries across the bound-root boundary, in sorted path order. */
const SCOPE_ENTRY_SUBTREE = ["F", "F/a.md", "F/sub", "F/sub/b.md"];
const SCOPE_ENTRY_POLL_ATTEMPTS = 20;
const SCOPE_ENTRY_POLL_INTERVAL_MS = 1500;

/** One name, two Drive objects — the provider fact issue #90's whole change rests on. */
const CONTENDED_NAME = "Contended.md";
/** One folder name, two Drive folders — the owner's example for same-named folders. */
const MERGED_FOLDER = "docs";
/** Which sibling carries which bytes, so the no-loss check can't be satisfied by a swap. */
const FIRST_CONTENT = "first-upload";
const SECOND_CONTENT = "second-upload";

/**
 * Prefix for the failures that mean the CHANGE's justification is wrong rather than
 * its code. A premise failure is the most valuable result this file can produce, so
 * it is raised as a named, self-explaining error — never as an assertion that would
 * read the same whichever way the real API answered.
 */
const PREMISE = "ISSUE #90 PREMISE FALSIFIED:";

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

type RemoteDelta = NonNullable<Awaited<ReturnType<IncrementalCheckpoint["getChangedPaths"]>>>;

/**
 * Poll `getChangedPaths()` until `hasArrived` accepts a result, and return THAT result.
 *
 * Two live facts force this shape. Google Drive publishes a mutation to `changes.list`
 * some time AFTER the mutation response returns, so a single fixed read would be flaky.
 * And each read CONSUMES what it returns — the cursor advances — so the change is
 * reported exactly once: the first result carrying it is the only one that can be
 * asserted on, and a later read would see it gone rather than incomplete.
 *
 * Exhausting the bound is a hard failure naming `changes.list` propagation: it means the
 * scenario was not observable through this API. It never skips and never passes.
 */
async function pollForChange(
	checkpoint: IncrementalCheckpoint,
	step: string,
	hasArrived: (delta: RemoteDelta) => boolean,
): Promise<RemoteDelta> {
	for (let attempt = 0; attempt < SCOPE_ENTRY_POLL_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			await new Promise((resolve) => setTimeout(resolve, SCOPE_ENTRY_POLL_INTERVAL_MS));
		}
		const delta = await checkpoint.getChangedPaths();
		if (delta && hasArrived(delta)) return delta;
	}
	const seconds = (SCOPE_ENTRY_POLL_ATTEMPTS * SCOPE_ENTRY_POLL_INTERVAL_MS) / 1000;
	throw new Error(
		`changes.list propagation never reported "${step}": ${SCOPE_ENTRY_POLL_ATTEMPTS} ` +
			`getChangedPaths polls over ~${seconds}s all came back without it.`,
	);
}

/**
 * A filesystem under test, so the Google-specific scenarios below run over the
 * production `GoogleDriveAdapter` + `ManagedRemoteFs` composition. `make` builds a fresh
 * store-backed filesystem (WARM delta route); `makeCold` builds one with no store (a pure
 * full scan).
 */
interface DriveFsUnderTest {
	readonly label: string;
	make: (rootId: string, dbNamePrefix: string) => IFileSystem;
	makeCold: (rootId: string) => IFileSystem;
}

/**
 * Opt-in real-cloud e2e (ADR 0003): runs the SAME `runIFileSystemContract` the
 * fake-backed unit tests run, but against the live Google Drive API, to catch
 * drift between `makeFakeGoogleDriveClient` and the real `GoogleDriveClient`.
 *
 * Skips (with a warning, never failing) when the refresh token is absent. Get one
 * via `npm run e2e:bootstrap -- google`. See docs/e2e-testing.md.
 */
const creds = readGoogleE2ECreds();

if (!creds) {
	console.warn(
		`[e2e] Skipping Google Drive: set ${GOOGLE_E2E_REFRESH_TOKEN_ENV} ` +
			"(run `npm run e2e:bootstrap -- google`; see docs/e2e-testing.md).",
	);
	describe.skip("IFileSystem contract — ManagedRemoteFs<googledrive> (real) [no creds]", () => {
		/* skipped */
	});
} else {
	const auth = createGoogleE2EAuth(creds.refreshToken);
	const client = new GoogleDriveClient((force) => auth.getAccessToken(force), createPlatformTransport());
	let parentId = "";

	beforeAll(async () => {
		parentId = await makeGoogleDriveParent(client);
	});
	afterAll(async () => {
		// Best-effort: cleanup is housekeeping, not an assertion. drive.file can't
		// hard-delete and may 403 on trash under load — don't fail a green run over
		// leftover folders (they're uniquely named; delete airsync-e2e-* manually).
		if (!parentId) return;
		try {
			await cleanupGoogleDriveParent(client, parentId);
		} catch (err) {
			console.warn(
				`[e2e] Google Drive cleanup failed (delete airsync-e2e-* by hand): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	/** The production composition's filesystem: real adapter + core-managed cache. */
	function makeManagedGoogleDriveFs(rootId: string, dbNamePrefix: string): ManagedRemoteFs {
		return new ManagedRemoteFs({
			adapter: new GoogleDriveAdapter(client, rootId),
			name: "googledrive",
			rootFolderId: rootId,
			vaultId: crypto.randomUUID(),
			store: { dbNamePrefix, version: 1 },
			addressing: "parent_id",
		});
	}

	const MANAGED_DRIVE: DriveFsUnderTest = {
		label: "ManagedRemoteFs<googledrive>",
		make: (rootId, dbNamePrefix) => makeManagedGoogleDriveFs(rootId, dbNamePrefix),
		makeCold: (rootId) => makeManagedGoogleDriveFs(rootId, "air-sync-googledrive-e2e-cold"),
	};

	runIFileSystemContract(
		"ManagedRemoteFs<googledrive> (real)",
		async () => makeManagedGoogleDriveFs(await makeGoogleDriveChild(client, parentId), "air-sync-googledrive-e2e-contract"),
		{ computesHashOnStat: false, stableIdentity: true },
	);

	runPriorityFidelityE2E(
		"ManagedRemoteFs<googledrive>",
		async () => makeManagedGoogleDriveFs(await makeGoogleDriveChild(client, parentId), "air-sync-googledrive-e2e-priority"),
	);

	runRenameSafetyE2E("ManagedRemoteFs<googledrive>", {
		backendType: "googledrive",
		movedObjectIdentity: GOOGLE_DRIVE_MOVED_OBJECT_IDENTITY,
		makeBackend: async () => {
			const childId = await makeGoogleDriveChild(client, parentId);
			const fs = makeManagedGoogleDriveFs(childId, "air-sync-googledrive-e2e-rename");
			return {
				fs,
				renameOutOfBand: async (file, newPath) => {
					await client.updateFileMetadata(file.identityKey!, { name: newPath });
				},
			};
		},
	});

	// Live backstop for the scope-entry fix: `changes.list` reports ONLY the folder that
	// moved, never its unchanged descendants, so a backend that trusts the delta page
	// alone reports just "F" here. The fake-backed shared contract pins the same fact;
	// this proves it against the real API, including on RE-entry — the shape the live
	// probe reproduced, where F is absent from the cache and its own change is all Drive
	// sends. Runs in its own fresh root, cleaned up by the per-run parent trash.
	function registerScopeEntry(drive: DriveFsUnderTest): void {
		describe(`${drive.label} scope entry — folder moved into the bound root (real)`, () => {
			it("reports an entered folder's whole pre-existing subtree, including on re-entry", async () => {
				const rootId = await makeGoogleDriveChild(client, parentId);
				// A sibling of the root, not a descendant: F is genuinely outside the bound
				// scope, so nothing about it can reach the cache until it is moved in.
				const outsideId = await makeGoogleDriveChild(client, parentId);
				const folder = await client.createFolder("F", outsideId);
				await client.uploadFile("a.md", folder.id, bytes("entered-a"));
				const sub = await client.createFolder("sub", folder.id);
				await client.uploadFile("b.md", sub.id, bytes("entered-b"));

				const fs = drive.make(rootId, "air-sync-googledrive-e2e-scope-entry");
				const checkpoint = fs.checkpoint!;
				try {
					// The empty baseline is load-bearing twice over: it proves F is outside the
					// scope, and committing it is what makes every later read a WARM delta from
					// a real persisted cursor instead of another cold scan.
					expect((await fs.list()).map((entry) => entry.path)).toEqual([]);
					await checkpoint.commitCheckpoint();

					await client.updateFileMetadata(folder.id, {}, rootId, outsideId);
					const entered = await pollForChange(checkpoint, "F moved into the root",
						(delta) => delta.modified.includes("F"));
					expect(entered.modified).toEqual(expect.arrayContaining(SCOPE_ENTRY_SUBTREE));
					await checkpoint.commitCheckpoint();

					await client.updateFileMetadata(folder.id, {}, outsideId, rootId);
					const left = await pollForChange(checkpoint, "F moved out of the root",
						(delta) => delta.deleted.includes("F"));
					expect(left.deleted).toEqual(expect.arrayContaining(SCOPE_ENTRY_SUBTREE));
					await checkpoint.commitCheckpoint();

					await client.updateFileMetadata(folder.id, {}, rootId, outsideId);
					const reentered = await pollForChange(checkpoint, "F moved back into the root",
						(delta) => delta.modified.includes("F"));
					expect(reentered.modified).toEqual(expect.arrayContaining(SCOPE_ENTRY_SUBTREE));
					// The working view must now hold what a cold scan would: the deepest
					// descendant is addressable, not merely named in the delta.
					expect(await fs.stat("F/sub/b.md")).not.toBeNull();
				} finally {
					await fs.close?.();
				}
			});
		});
	}

	// Live backstop for issue #90 (the cache path↔id bijection). Every part of that
	// change — the arbiter, the displacement facts, the absence attribution, the
	// identity-addressed repair — rests on ONE provider fact no test had ever checked
	// against the real API: Google Drive lets two objects with the SAME NAME live under
	// ONE parent, so the cache derives one address for two live stable ids. It also
	// adds a real provider mutation (`renameById` → `files.update {name}`) that no e2e
	// exercised. Each case runs in its own fresh root under the per-run parent, which
	// `afterAll` trashes recursively — the renamed object included, because it keeps
	// the parent it started with (which is case 4's own assertion).
	function registerContendedAddress(drive: DriveFsUnderTest): void {
		describe(`${drive.label} contended derived address (real)`, () => {
			it("holds one address for two live ids, calls neither a deletion, and repairs it by id", async () => {
				const rootId = await makeGoogleDriveChild(client, parentId);
				const fs = drive.make(rootId, "air-sync-googledrive-e2e-contention");
				const checkpoint = fs.checkpoint!;
				try {
					// The committed empty baseline is what makes every later read a WARM delta
					// from a real persisted cursor, which is the route this case asserts on. (A
					// fresh full scan announces through `drainWorkingViewContentions` instead;
					// the same-named-folders case below checks that channel live.)
					expect((await fs.list()).map((entry) => entry.path)).toEqual([]);
					await checkpoint.commitCheckpoint();

					// ── 1. The premise: two same-named siblings, two distinct stable ids ──
					const first = await client.uploadFile(CONTENDED_NAME, rootId, bytes(FIRST_CONTENT));
					let second: GoogleDriveFile;
					try {
						second = await client.uploadFile(CONTENDED_NAME, rootId, bytes(SECOND_CONTENT));
					} catch (err) {
						throw new Error(
							`${PREMISE} Drive REFUSED a second child named "${CONTENDED_NAME}" under one ` +
								`parent (${describeError(err)}). Two live ids could then never claim one ` +
								"derived cache address on this backend, and the arbiter, the displacement " +
								"facts and the identity-addressed repair would have no condition to repair.",
						);
					}
					if (second.id === first.id || first.name !== CONTENDED_NAME || second.name !== CONTENDED_NAME) {
						throw new Error(
							`${PREMISE} Drive did not create two distinct same-named siblings: ` +
								`first=${first.id} "${first.name}", second=${second.id} "${second.name}". ` +
								"A returned duplicate id or a silent rename means the collision this change " +
								"exists to settle cannot occur on the real API.",
						);
					}
					const siblings = await client.listChildrenByName(rootId, CONTENDED_NAME);
					if (siblings.length !== 2 || new Set(siblings.map((file) => file.id)).size !== 2) {
						throw new Error(
							`${PREMISE} both creates succeeded (${first.id}, ${second.id}) but Drive's own ` +
								`enumeration reports ${siblings.length} object(s) named "${CONTENDED_NAME}" ` +
								`under the parent (ids: ${siblings.map((file) => file.id).join(", ")}) — so the ` +
								"listing the cache builds its claim set from never carries the collision.",
						);
					}

					// ── 2. The contention reaches the cache AS a contention ──
					// Every drain in the window is kept, not just the one carrying the fact: the
					// two siblings may arrive in one page or across several, and an intermediate
					// drain that mis-attributed a displaced address would otherwise be consumed
					// unobserved.
					const observed: RemoteDelta[] = [];
					const cycle = await pollForChange(
						checkpoint,
						`two siblings named "${CONTENDED_NAME}"`,
						(delta) => {
							observed.push(delta);
							return (delta.contended ?? []).some((fact) => fact.path === CONTENDED_NAME);
						},
					);
					const fact = (cycle.contended ?? []).find((entry) => entry.path === CONTENDED_NAME)!;
					expect([fact.admittedId, fact.withheldId].sort()).toEqual([first.id, second.id].sort());
					// Tier 2 of the arbiter, decided over the real ids. Asserting the rule rather
					// than "whichever arrived first" is what makes this independent of the order
					// Drive's change feed happened to report the two creations in.
					expect(fact.admittedId).toBe([first.id, second.id].sort()[0]);
					// Both claims are provider-resolved, so the loser is repairable — which is
					// what separates this from a contention nothing can be done about.
					expect(fact.owesRemediation).toBe(true);
					// THE DATA-LOSS ROUTE. An address a contention displaced is absent from the
					// working view but still present on the provider; reporting it in `deleted`
					// would authorise deleting a live file locally.
					for (const delta of observed) expect(delta.deleted).toEqual([]);
					// Exactly one claimant is addressable, it is the admitted one, and the other
					// holds no address ANYWHERE in the working view — not merely not this one.
					expect((await fs.list()).map((entry) => entry.path)).toEqual([CONTENDED_NAME]);
					expect((await fs.stat(CONTENDED_NAME))?.identityKey).toBe(fact.admittedId);

					// ── 3. The repair, against the real API ──
					// The target address comes from the production planner, so this exercises the
					// address the plugin would actually ask for rather than one restated here.
					const remediation = planAddressContentionRemediation({
						contentions: cycle.contended ?? [],
						recordHolders: new Set(),
						renameByIdentity: fs.identityRename !== undefined,
					});
					expect(remediation.checkpointBlocked).toBe(true);
					expect(remediation.actions).toHaveLength(1);
					const repair = remediation.actions[0]!;
					expect(repair.oldPath).toBe(CONTENDED_NAME);
					expect(repair.providerIdentity).toBe(fact.withheldId);
					expect(repair.path).toBe(insertConflictSuffix(CONTENDED_NAME, `id-${fact.withheldId}`));

					const parentsBefore = (await client.getFile(fact.withheldId)).parents;
					await fs.identityRename!.renameById(repair.providerIdentity!, repair.path);

					// The no-loss invariant, end to end: both objects reachable at distinct
					// addresses, each with its own bytes, and the keeper's identity unmoved.
					// `stat`/`read` do not replay a delta, so this reads the working view the
					// repair itself produced rather than a later re-observation of it.
					expect((await fs.stat(CONTENDED_NAME))?.identityKey).toBe(fact.admittedId);
					expect((await fs.stat(repair.path))?.identityKey).toBe(fact.withheldId);
					const contentById = new Map([[first.id, FIRST_CONTENT], [second.id, SECOND_CONTENT]]);
					expect(decode(await fs.read(CONTENDED_NAME))).toBe(contentById.get(fact.admittedId));
					expect(decode(await fs.read(repair.path))).toBe(contentById.get(fact.withheldId));

					// ── 4. Only the leaf name moved ──
					// `updateFileMetadata(id, { name })` sends no addParents/removeParents, and a
					// real-API parent check is the part a fake cannot give: it is also what keeps
					// the renamed object inside the tree `afterAll` trashes.
					const movedOnDrive = await client.getFile(fact.withheldId);
					expect(movedOnDrive.name).toBe(repair.path.split("/").pop());
					expect(movedOnDrive.parents).toEqual(parentsBefore);
					expect(movedOnDrive.parents).toEqual([rootId]);
					const keeperOnDrive = await client.getFile(fact.admittedId);
					expect(keeperOnDrive.name).toBe(CONTENDED_NAME);
					expect(keeperOnDrive.parents).toEqual([rootId]);
				} finally {
					await fs.close?.();
				}
			});

			// The orphan-collapse mechanism (a cached claim that falls back to its BARE NAME
			// with `requested_echo` authority and loses the authority tier to a real
			// root-level namesake) cannot be staged from outside the plugin: the only
			// producer of such a claim is `resolveFilePathCached` inside `buildFromFiles`,
			// and `fullList()` is `listAllFiles(rootFolderId)` — a parent-driven walk — so
			// every file in that claim set has its own resolved parent chain in the same
			// claim set. This case pins THAT, live: an out-of-root namesake reaches the
			// account-wide change feed and must produce no claim, no contention, no
			// deletion and no provider mutation. The day it produces one, the collapse is
			// reachable after all and this goes red instead of the fact living only in prose.
			it("derives no cache address for an out-of-root namesake, and does not touch it", async () => {
				const rootId = await makeGoogleDriveChild(client, parentId);
				// A sibling of the bound root, not a descendant: genuinely out of scope.
				const outsideId = await makeGoogleDriveChild(client, parentId);
				const fs = drive.make(rootId, "air-sync-googledrive-e2e-out-of-root");
				const checkpoint = fs.checkpoint!;
				try {
					expect((await fs.list()).map((entry) => entry.path)).toEqual([]);
					await checkpoint.commitCheckpoint();

					// Both creations land INSIDE the delta window, and `changes.list` is
					// account-wide rather than root-scoped, so the out-of-root object really is
					// offered to the drain — it is declined, not unseen.
					const outside = await client.uploadFile(CONTENDED_NAME, outsideId, bytes("outside-root"));
					const inside = await client.uploadFile(CONTENDED_NAME, rootId, bytes("inside-root"));

					const observed: RemoteDelta[] = [];
					const cycle = await pollForChange(
						checkpoint,
						`"${CONTENDED_NAME}" created in the bound root`,
						(delta) => {
							observed.push(delta);
							return delta.modified.includes(CONTENDED_NAME);
						},
					);
					for (const delta of observed) {
						expect(delta.contended ?? []).toEqual([]);
						expect(delta.deleted).toEqual([]);
					}
					expect(cycle.modified).toEqual([CONTENDED_NAME]);
					const entry = await fs.stat(CONTENDED_NAME);
					expect(entry?.identityKey).toBe(inside.id);
					// Provider-resolved, never the `requested_echo` bare-name echo a collapse
					// would have written at this very address.
					expect(entry?.pathAuthority).toBe("actual_resolved");
					expect((await fs.list()).map((listed) => listed.path)).toEqual([CONTENDED_NAME]);

					// No provider mutation: the out-of-root namesake still carries its own name
					// under its own parent. A repair that had reached for it would show here.
					const outsideAfter = await client.getFile(outside.id);
					expect(outsideAfter.name).toBe(CONTENDED_NAME);
					expect(outsideAfter.parents).toEqual([outsideId]);
				} finally {
					await fs.close?.();
				}
			});

			// Premise probe only, for the `/`-in-a-provider-name collision shape. Air Sync
			// composes names from vault path segments, which cannot contain `/`, so the
			// plugin does not reach the shape on its own — but that DRIVE ACCEPTS SUCH A
			// NAME is the mechanism's premise and was never checked. One create and one read
			// by id: no cache, no delta, no polling. Observing the collision itself would
			// need its own root, a folder and its own delta poll, which is why only the
			// premise is probed here.
			it("stores a provider name containing a path separator verbatim", async () => {
				const rootId = await makeGoogleDriveChild(client, parentId);
				const slashName = "slash/name.md";
				let created: GoogleDriveFile;
				try {
					created = await client.uploadFile(slashName, rootId, bytes("slash-named"));
				} catch (err) {
					throw new Error(
						`${PREMISE} Drive REFUSED a name containing "/" (${describeError(err)}). A ` +
							"provider name can then never compose a derived cache address carrying a " +
							"separator, so that collision shape is unreachable on this backend and the " +
							"arbiter's handling of it is dead code here.",
					);
				}
				const stored = await client.getFile(created.id);
				if (stored.name !== slashName) {
					throw new Error(
						`${PREMISE} Drive stored "${stored.name}" for a requested name of ` +
							`"${slashName}" — it rewrites the separator instead of keeping it, so that ` +
							"collision shape is unreachable on this backend.",
					);
				}
			});

			// The owner's model for same-named FOLDERS, live: docs(A)/a.md and
			// docs(B)/{a.md, b.md} are one vault folder holding all three, and only the two
			// a.md collide. It rests on a second provider fact — Drive lets two folders with
			// one name live under one parent — and on the drain seeing both folders' contents.
			it("holds two same-named folders as one vault folder, contending only the colliding file", async () => {
				const rootId = await makeGoogleDriveChild(client, parentId);
				const fs = drive.make(rootId, "air-sync-googledrive-e2e-folder-merge");
				const cold = drive.makeCold(rootId);
				const checkpoint = fs.checkpoint!;
				try {
					expect((await fs.list()).map((entry) => entry.path)).toEqual([]);
					await checkpoint.commitCheckpoint();

					// ── 1. The premise: two same-named folders under one parent ──
					const folderA = await client.createFolder(MERGED_FOLDER, rootId);
					const folderB = await client.createFolder(MERGED_FOLDER, rootId);
					const folders = await client.listChildrenByName(rootId, MERGED_FOLDER);
					if (folderA.id === folderB.id || folders.length !== 2) {
						throw new Error(
							`${PREMISE} Drive did not keep two folders named "${MERGED_FOLDER}" under one ` +
								`parent (created ${folderA.id}, ${folderB.id}; enumeration reports ` +
								`${folders.length}). Same-named folders then never reach the cache, and ` +
								"merging them is a rule with no condition to apply to.",
						);
					}
					const aInA = await client.uploadFile("a.md", folderA.id, bytes("a-in-A"));
					const aInB = await client.uploadFile("a.md", folderB.id, bytes("a-in-B"));
					const bInB = await client.uploadFile("b.md", folderB.id, bytes("b-in-B"));
					const content = new Map([[aInA.id, "a-in-A"], [aInB.id, "a-in-B"]]);

					// ── 2. One vault folder, one contended file, nothing deleted ──
					// Every drain in the window is kept: the folders and their contents may
					// arrive across several, and each one must call nothing a deletion.
					const observed: RemoteDelta[] = [];
					const facts = () => observed.flatMap((delta) => delta.contended ?? [])
						.filter((fact) => fact.path === `${MERGED_FOLDER}/a.md`);
					await pollForChange(checkpoint, "two same-named folders and their contents", (delta) => {
						observed.push(delta);
						return facts().length > 0 &&
							observed.some((seen) => seen.modified.includes(`${MERGED_FOLDER}/b.md`));
					});
					for (const delta of observed) expect(delta.deleted).toEqual([]);
					expect((await fs.list()).map((entry) => entry.path).sort())
						.toEqual([MERGED_FOLDER, `${MERGED_FOLDER}/a.md`, `${MERGED_FOLDER}/b.md`]);
					expect((await fs.stat(MERGED_FOLDER))?.identityKey).toBe([folderA.id, folderB.id].sort()[0]);
					expect((await fs.stat(`${MERGED_FOLDER}/b.md`))?.identityKey).toBe(bInB.id);
					const fact = facts().at(-1)!;
					expect(fact.admittedId).toBe([aInA.id, aInB.id].sort()[0]);
					expect([fact.admittedId, fact.withheldId].sort()).toEqual([aInA.id, aInB.id].sort());
					expect(fact.owesRemediation).toBe(true);

					// ── 3. A full scan reaches the same fact through its own channel ──
					expect((await cold.list()).map((entry) => entry.path).sort())
						.toEqual([MERGED_FOLDER, `${MERGED_FOLDER}/a.md`, `${MERGED_FOLDER}/b.md`]);
					expect(cold.checkpoint!.drainWorkingViewContentions?.()).toEqual([
						expect.objectContaining({ path: fact.path, admittedId: fact.admittedId, withheldId: fact.withheldId }),
					]);

					// ── 4. The repair moves one FILE, inside its own Drive folder ──
					const remediation = planAddressContentionRemediation({
						contentions: [fact], recordHolders: new Set(), renameByIdentity: true,
					});
					const repair = remediation.actions[0]!;
					expect(repair.path).toBe(insertConflictSuffix(`${MERGED_FOLDER}/a.md`, `id-${fact.withheldId}`));
					const parentsBefore = (await client.getFile(fact.withheldId)).parents;
					await fs.identityRename!.renameById(fact.withheldId, repair.path);
					expect((await fs.stat(`${MERGED_FOLDER}/a.md`))?.identityKey).toBe(fact.admittedId);
					expect((await fs.stat(repair.path))?.identityKey).toBe(fact.withheldId);
					expect(decode(await fs.read(`${MERGED_FOLDER}/a.md`))).toBe(content.get(fact.admittedId));
					expect(decode(await fs.read(repair.path))).toBe(content.get(fact.withheldId));
					expect((await client.getFile(fact.withheldId)).parents).toEqual(parentsBefore);

					// ── 5. The vault folder moves as one, and loses only what is really gone ──
					await fs.rename(MERGED_FOLDER, "notes");
					expect((await client.getFile(folderA.id)).name).toBe("notes");
					expect((await client.getFile(folderB.id)).name).toBe("notes");
					await checkpoint.commitCheckpoint();

					const survivors = new Set([aInA.id]);
					await client.deleteFile(folderB.id);
					const gone = await pollForChange(checkpoint, `Drive folder ${folderB.id} deleted`,
						(delta) => delta.deleted.includes("notes/b.md"));
					expect((await fs.stat("notes"))?.identityKey).toBe(folderA.id);
					const remaining = await fs.list();
					expect(remaining.filter((entry) => !entry.isDirectory).map((entry) => entry.identityKey))
						.toEqual([...survivors]);
					for (const entry of remaining) expect(gone.deleted).not.toContain(entry.path);
				} finally {
					await fs.close?.();
					await cold.close?.();
				}
			});
		});
	}

	registerScopeEntry(MANAGED_DRIVE);
	registerContendedAddress(MANAGED_DRIVE);
}
