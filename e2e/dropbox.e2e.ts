import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DropboxAuth } from "../src/backends/dropbox/auth";
import { DROPBOX_AUTH } from "../src/backends/shared/auth-config";
import { createPlatformTransport } from "../src/fs/platform-http-transport";
import { DropboxAdapter } from "../src/backends/dropbox/adapter";
import { ManagedRemoteFs } from "../src/fs/managed/managed-remote-fs";
import type { IFileSystem } from "../src/fs/interface";
import type { DropboxEntry } from "../src/backends/dropbox/types";
import { runIFileSystemContract, bytes } from "../tests/fs/contracts/ifilesystem.contract";
import { RetryingDropboxClient } from "./helpers/dropbox-retry-client";
import { readCreds } from "./helpers/env";
import {
	cleanupDropboxParent,
	makeDropboxChild,
	makeDropboxParent,
} from "./helpers/isolation";
import { runRenameSafetyE2E } from "./helpers/rename-safety";
import { runPriorityFidelityE2E } from "./helpers/priority-fidelity";
import type { MovedObjectIdentity } from "../tests/fs/contracts/caching-remote-fs.contract";

/**
 * What Dropbox's own entity projection makes of a moved object's identity, against the
 * LIVE API. Same disposition the family declares to the fake-backed managed contract
 * (`tests/backends/dropbox/managed.contract-harness.ts`), and the family where it is least
 * obvious: `DropboxEntry.id` is declared OPTIONAL, while `normalizeDropboxObject`
 * projects the normalized `RemoteObject` with `id: entry.id` and NO path fallback. A
 * faithful fake always hands over a complete entry; only the live feed can show whether
 * the real one does (see the id probe at the bottom of this file).
 */
const DROPBOX_MOVED_OBJECT_IDENTITY: MovedObjectIdentity = {
	determinate: true,
	reason:
		"normalizeDropboxObject sets RemoteObject.id from entry.id with NO fallback, " +
		"so the pair names the object only if the live list_folder/continue entry " +
		"carried an id. This scenario's remote-origin leg is a case-only rename, which " +
		"Dropbox's move_v2 cannot do directly: it runs as two raw moves through an " +
		"intermediate sibling path, and the delta that reports it is the one whose entry " +
		"must carry the id.",
};

/** Bound on draining `has_more`; a server that never clears it must fail, not loop. */
const DROPBOX_DRAIN_PAGE_CAP = 50;
/** Bounded wait for `list_folder/continue` to publish a just-made mutation. */
const DROPBOX_CONTINUE_POLL_ATTEMPTS = 20;
const DROPBOX_CONTINUE_POLL_INTERVAL_MS = 1500;

/**
 * What an id-less live `file`/`folder` entry would mean, carried on every failure message
 * so a red run states the finding itself rather than leaving it to be inferred.
 */
const ID_CONSEQUENCE =
	"DropboxEntry.id is declared optional only because the type also covers `deleted` " +
	"tombstones, which its doc comment says are never cached and which the normalized " +
	"cache does not project. A live file/folder entry without one means " +
	"normalizeDropboxObject cannot name the object, so buildSyncRecord refuses the " +
	"SyncRecord and the identity floor's refusal branch is a LIVE user-facing outcome, " +
	"not dead code (issue #95, `unknown-dropbox-entry-without-id`).";

/**
 * Assert that every non-`deleted` entry of one raw page names its provider object.
 *
 * A `deleted` tombstone is excluded BY KIND, not by a truthiness test that would also
 * swallow the id-less `file`/`folder` this exists to detect: the tombstone is the declared
 * reason the field is optional, it is never cached, and it never reaches a projection.
 *
 * A failure names the offending entry — `.tag`, `path_display`, `name` and `path_lower` —
 * because that entry IS the finding.
 */
function assertEveryEntryNamesItsObject(entries: readonly DropboxEntry[], source: string): void {
	for (const entry of entries) {
		if (entry[".tag"] === "deleted") continue;
		const where =
			`${source}: ${entry[".tag"]} entry ${JSON.stringify(entry.path_display)} ` +
			`(name ${JSON.stringify(entry.name)}, path_lower ${JSON.stringify(entry.path_lower)})`;
		expect(typeof entry.id, `${where} carries NO id. ${ID_CONSEQUENCE}`).toBe("string");
		expect(entry.id, `${where} carries an EMPTY id. ${ID_CONSEQUENCE}`).not.toBe("");
	}
}

/**
 * Opt-in real-cloud e2e (ADR 0003): runs the SAME `runIFileSystemContract` the
 * fake-backed unit tests run, but against the live Dropbox API, to catch drift
 * between `makeFakeDropboxClient` and the real `DropboxClient`.
 *
 * Skips (with a warning, never failing) when the refresh token is absent. Get one
 * via `npm run e2e:bootstrap -- dropbox`. See docs/e2e-testing.md.
 */
const creds = readCreds("AIRSYNC_E2E_DROPBOX_REFRESH_TOKEN");

if (!creds) {
	console.warn(
		"[e2e] Skipping Dropbox: set AIRSYNC_E2E_DROPBOX_REFRESH_TOKEN " +
			"(run `npm run e2e:bootstrap -- dropbox`; see docs/e2e-testing.md).",
	);
	describe.skip("IFileSystem contract — ManagedRemoteFs<dropbox> (real) [no creds]", () => {
		/* skipped */
	});
} else {
	// PKCE refresh needs only the public client id. Empty access token + expiry 0
	// forces a refresh on the first getAccessToken().
	const auth = new DropboxAuth(DROPBOX_AUTH.clientId, createPlatformTransport());
	auth.setTokens(creds.refreshToken, "", 0);
	// Inject a node-safe sleep: the client's default sleep uses window.setTimeout,
	// which is undefined under vitest's node environment — a 429 backoff (the very
	// reason this suite runs fileParallelism:false) would otherwise crash with
	// "window is not defined" instead of retrying. RetryingDropboxClient adds a
	// retry for the fresh-folder-id propagation transient (see its docstring).
	const client = new RetryingDropboxClient(
		(force) => auth.getAccessToken(force),
		createPlatformTransport(),
		undefined,
		(ms) => new Promise((r) => setTimeout(r, ms)),
	);
	let parentPath = "";

	beforeAll(async () => {
		parentPath = await makeDropboxParent(client);
	});
	afterAll(async () => {
		// Best-effort: a cleanup failure must not fail an otherwise-green run.
		if (!parentPath) return;
		try {
			await cleanupDropboxParent(client, parentPath);
		} catch (err) {
			console.warn(
				`[e2e] Dropbox cleanup failed (delete airsync-e2e-* by hand): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	/** The production composition's filesystem: real adapter + core-managed cache. */
	function makeManagedDropboxFs(childId: string, dbNamePrefix: string): ManagedRemoteFs {
		return new ManagedRemoteFs({
			adapter: new DropboxAdapter(client, childId),
			name: "dropbox",
			rootFolderId: childId,
			vaultId: crypto.randomUUID(),
			store: { dbNamePrefix, version: 1 },
			addressing: "provider_path",
		});
	}

	runIFileSystemContract(
		"ManagedRemoteFs<dropbox> (real)",
		async () => makeManagedDropboxFs(await makeDropboxChild(client, parentPath), "air-sync-dropbox-e2e-contract"),
		// Same live Dropbox divergence as the legacy run: mtime is server_modified.
		{ computesHashOnStat: false, preservesWrittenMtime: false, stableIdentity: true },
	);

	runPriorityFidelityE2E(
		"ManagedRemoteFs<dropbox>",
		async () => makeManagedDropboxFs(await makeDropboxChild(client, parentPath), "air-sync-dropbox-e2e-priority"),
	);

	runRenameSafetyE2E("ManagedRemoteFs<dropbox>", {
		backendType: "dropbox",
		movedObjectIdentity: DROPBOX_MOVED_OBJECT_IDENTITY,
		makeBackend: async () => {
			const childId = await makeDropboxChild(client, parentPath);
			const fs = makeManagedDropboxFs(childId, "air-sync-dropbox-e2e-rename");
			return {
				fs,
				renameOutOfBand: async (file, newPath) => {
					const tempPath = `${childId}/.airsync-e2e-case-${crypto.randomUUID()}`;
					await client.move(`${childId}/${file.path}`, tempPath);
					await client.move(tempPath, `${childId}/${newPath}`);
				},
			};
		},
	});

	// The IFileSystem contract above never drives `getChangedPaths()`, so the delta's
	// rename SHAPE is unverified against real Dropbox — exactly the ADR 0003 blind spot.
	// This pins it: an out-of-band folder rename must come back as ONE renamed pair, not
	// a subtree of delete+add (ADR 0006). Lives in the one Dropbox e2e file on purpose —
	// a second `*.e2e.ts` matching "dropbox" would run concurrently and share its
	// rate-limit bucket (vitest fileParallelism; see vitest.e2e.config.ts).
	function registerDeltaRename(label: string, makeFs: (childId: string) => IFileSystem): void {
		describe(`${label} delta — out-of-band rename via getChangedPaths (real)`, () => {
			it("reports a remote folder rename as a single renamed pair", async () => {
				const childId = await makeDropboxChild(client, parentPath);
				const fs = makeFs(childId);

				// Seed a folder with two files, then drain + commit so the cursor is at "now".
				await fs.write("dir/b.md", bytes("beta"), 1000);
				await fs.write("dir/c.md", bytes("gamma"), 1000);
				await fs.list();
				await fs.checkpoint!.commitCheckpoint();

				// Rename the folder OUT-OF-BAND (as a second device / the web UI would),
				// bypassing the FS cache, so the delta is the only source of truth.
				const movedFolder = await client.move(`${childId}/dir`, `${childId}/papers`);
				// `move_v2`'s own response names the folder it moved. Taking the identity
				// expectation from THERE — not from a post-delta `fs.stat`, which reads the cache
				// this same delta payload wrote — keeps the check cross-source.
				if (!movedFolder.id) {
					throw new Error(
						"Dropbox move_v2 returned folder metadata with no id, so the reported pair's " +
							`carried identity has nothing independent to be checked against. ${ID_CONSEQUENCE}`,
					);
				}

				const delta = await fs.checkpoint!.getChangedPaths();
				expect(delta).not.toBeNull();
				expect(delta!.renamed ?? []).toContainEqual({
					oldPath: "dir",
					newPath: "papers",
					isFolder: true,
					// The pair now NAMES the folder it moved (issue #95): the same single-pair
					// shape as before, plus the identity the producer carried from its own
					// projection over Dropbox's delta payload.
					identityKey: movedFolder.id,
				});
				// Exactly one folder pair — not N per-file renames, and not delete+add.
				expect((delta!.renamed ?? []).filter((p) => p.isFolder)).toHaveLength(1);
			});
		});
	}

	registerDeltaRename("ManagedRemoteFs<dropbox>", (childId) => makeManagedDropboxFs(childId, "air-sync-dropbox-e2e-delta"));

	/**
	 * Drain one `list_folder/continue` window, asserting every page it returns.
	 *
	 * Returns the entries and the cursor to resume from, so a caller can poll the same
	 * window again without re-reading entries Dropbox has already handed over.
	 */
	const drainContinue = async (
		from: string,
		label: string,
	): Promise<{ entries: DropboxEntry[]; cursor: string; pages: number }> => {
		const entries: DropboxEntry[] = [];
		let cursor = from;
		for (let pages = 1; ; pages++) {
			const res = await client.listFolderContinue(cursor);
			assertEveryEntryNamesItsObject(res.entries, `${label} page ${pages}`);
			entries.push(...res.entries);
			cursor = res.cursor;
			if (!res.has_more) return { entries, cursor, pages };
			if (pages >= DROPBOX_DRAIN_PAGE_CAP) {
				throw new Error(
					`${label}: has_more still set after ${DROPBOX_DRAIN_PAGE_CAP} pages — refusing to loop.`,
				);
			}
		}
	};

	// Issue #95's `unknown-dropbox-entry-without-id`, settled by assertion rather than by a
	// raw dump someone has to read. `DropboxEntry.id` is declared OPTIONAL, but the declared
	// reason is narrow: the type also covers `deleted` tombstones, whose doc comment says
	// they are never cached and which `buildFromFiles` skips — while `googledrive/types.ts`
	// and `onedrive/types.ts` declare `id: string` outright. The open question is whether a
	// LIVE `list_folder` / `list_folder/continue` page can carry a `file` or `folder` entry
	// with no id, because that entry projects `identityKey: undefined` and so meets the
	// identity floor's refusal branch — making it a live user-facing outcome rather than
	// dead code. Every non-deleted entry of every page this case reads is asserted, and a
	// violation fails the run naming the entry.
	//
	// Lives in this one Dropbox e2e file for the same reason as the block above: a second
	// `*.e2e.ts` matching "dropbox" would run concurrently and share its rate-limit bucket.
	describe("Dropbox raw pages — every live file/folder entry names its object (real)", () => {
		it("carries a non-empty id on every non-deleted entry of a list_folder AND a list_folder/continue page", async () => {
			const childId = await makeDropboxChild(client, parentPath);
			// Seeded through the client, not through DropboxFs: the probe must read the
			// provider's own listing pages, never a mutation echo (`upload` returns a bare
			// FileMetadata that the client stamps itself, which would prove nothing about
			// what `list_folder` returns).
			await client.createFolder(`${childId}/dir`);
			await client.upload(`${childId}/dir/a.md`, bytes("alpha"), 1000);
			await client.upload(`${childId}/keep.md`, bytes("keep"), 1000);
			await client.upload(`${childId}/drop.md`, bytes("drop"), 1000);

			// ── The initial `files/list_folder` page (recursive, id-addressed — exactly the
			// shape `DropboxFs.fullList` drives), drained through any `has_more` pages. ──
			let page = await client.listFolder(childId, true);
			const initial: DropboxEntry[] = [...page.entries];
			let initialPages = 1;
			assertEveryEntryNamesItsObject(page.entries, "files/list_folder page 1");
			while (page.has_more) {
				if (initialPages >= DROPBOX_DRAIN_PAGE_CAP) {
					throw new Error(
						`files/list_folder: has_more still set after ${DROPBOX_DRAIN_PAGE_CAP} pages — refusing to loop.`,
					);
				}
				page = await client.listFolderContinue(page.cursor);
				initialPages++;
				assertEveryEntryNamesItsObject(
					page.entries,
					`files/list_folder/continue page ${initialPages} (has_more pagination of the initial listing)`,
				);
				initial.push(...page.entries);
			}
			// Premise, not a finding: the listing must have carried the four seeded objects,
			// or the assertions above ran against nothing and a green result means nothing.
			const initialNamed = initial.filter((entry) => entry[".tag"] !== "deleted");
			if (initialNamed.length < 4) {
				throw new Error(
					`files/list_folder returned ${initialNamed.length} file/folder entries for a root ` +
						"seeded with dir, dir/a.md, keep.md and drop.md, so the id assertions had " +
						"nothing to run against.",
				);
			}

			// ── A real `files/list_folder/continue` page. ───────────────────────────────
			// It is reached through the completed listing's cursor (the documented
			// "what changed since" continuation), NOT by paginating one oversized listing:
			// `DropboxClient.listFolder` exposes no `limit`, and staging the thousands of
			// entries Dropbox needs to split a page is not something this harness should do
			// to a live account. Stated rather than glossed — if the `has_more` loop above
			// ever does fire, its pages are asserted by the same helper.
			// One delete first, so the window also carries the tombstone kind the assertion
			// excludes — the exclusion is then a live fact, not a hypothetical.
			await client.deletePath(`${childId}/drop.md`);
			await client.upload(`${childId}/dir/b.md`, bytes("beta"), 1000);
			await client.createFolder(`${childId}/later`);
			await client.upload(`${childId}/later/c.md`, bytes("gamma"), 1000);

			const awaiting = new Set(["b.md", "later", "c.md"]);
			let cursor = page.cursor;
			let continuePages = 0;
			let continueNamed = 0;
			let tombstones = 0;
			for (let attempt = 0; attempt < DROPBOX_CONTINUE_POLL_ATTEMPTS && awaiting.size > 0; attempt++) {
				if (attempt > 0) {
					await new Promise((resolve) => setTimeout(resolve, DROPBOX_CONTINUE_POLL_INTERVAL_MS));
				}
				const drained = await drainContinue(cursor, "files/list_folder/continue");
				cursor = drained.cursor;
				continuePages += drained.pages;
				for (const entry of drained.entries) {
					// A tombstone is the declared reason `id` is optional. Counted, never
					// asserted on, and never allowed to satisfy the premise below.
					if (entry[".tag"] === "deleted") {
						tombstones++;
						continue;
					}
					continueNamed++;
					awaiting.delete(entry.name);
				}
			}
			if (awaiting.size > 0) {
				const seconds = (DROPBOX_CONTINUE_POLL_ATTEMPTS * DROPBOX_CONTINUE_POLL_INTERVAL_MS) / 1000;
				throw new Error(
					`list_folder/continue never reported ${[...awaiting].join(", ")} after ` +
						`${DROPBOX_CONTINUE_POLL_ATTEMPTS} polls over ~${seconds}s ` +
						`(${continuePages} pages, ${continueNamed} file/folder entries, ` +
						`${tombstones} deleted tombstones). Without a continue page carrying live ` +
						"entries this case proves nothing about that endpoint, so it fails rather " +
						"than passing on an empty window.",
				);
			}
			expect(
				continueNamed,
				"the continue window carried no file/folder entry, so its id assertions were vacuous",
			).toBeGreaterThan(0);

			// The verdict is the assertions above; this line only records WHAT was covered,
			// so the measurement that settles `unknown-dropbox-entry-without-id` is on the
			// run's record without anyone having to interpret a page dump.
			console.info(
				`[e2e] Dropbox id probe: ${initialNamed.length} file/folder entries over ` +
					`${initialPages} list_folder page(s), ${continueNamed} over ${continuePages} ` +
					`list_folder/continue page(s), ${tombstones} deleted tombstone(s) skipped; ` +
					"every non-deleted entry carried a non-empty id.",
			);
		});
	});
}
