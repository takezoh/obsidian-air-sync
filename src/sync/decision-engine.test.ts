import { describe, it, expect } from "vitest";
import { planSync } from "./decision-engine";
import type { FileEntity } from "../fs/types";
import type { MixedEntity, SyncRecord, SyncActionType } from "./types";

/**
 * Decision table tests — the most safety-critical unit in the pipeline.
 *
 * `decideAction()` is a pure function of (prevSync, local, remote). The columns
 * `localChanged` / `remoteChanged` are NOT raw inputs: they are computed by
 * `hasChanged()` / `hasRemoteChanged()` (change-compare.ts), each of which can
 * reach the same boolean via several mechanisms:
 *   - mtime + size comparison       (fast path)
 *   - same-size content edit        (mtime+size match but hash differs)
 *   - remoteChecksum                (remote only — Drive md5 / pCloud content hash)
 *   - content hash                  (sha256)
 *   - conservative fallback         (undeterminable → treated as "changed")
 *
 * This suite therefore covers two layers:
 *   1. Every row of docs/sync-pipeline.md "Decision table" (1:1, canonical case).
 *   2. Mechanism invariance — the chosen Action must be stable regardless of
 *      WHICH predicate pathway makes localChanged / remoteChanged true or false.
 *
 * Note the predicate asymmetry exercised below: in the "mtime/size differ"
 * branch, hasChanged() falls back to `hash`, but hasRemoteChanged() falls back
 * to `remoteChecksum` (not `hash`). Tests are constructed to honour
 * this so the expectations match the real implementation.
 */

const BASE_HASH = "h-base";

function local(overrides: Partial<FileEntity> = {}): FileEntity {
	return {
		path: "f.md",
		isDirectory: false,
		size: 100,
		mtime: 1000,
		hash: BASE_HASH,
		...overrides,
	};
}

function remote(overrides: Partial<FileEntity> = {}): FileEntity {
	return {
		path: "f.md",
		isDirectory: false,
		size: 100,
		mtime: 1000,
		hash: BASE_HASH,
		...overrides,
	};
}

function baseline(overrides: Partial<SyncRecord> = {}): SyncRecord {
	return {
		path: "f.md",
		hash: BASE_HASH,
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 100,
		remoteSize: 100,
		syncedAt: 900,
		...overrides,
	};
}

/** Decide the single action for one entry (null = skipped / no-op). */
function decide(entry: MixedEntity): SyncActionType | null {
	return planSync([entry]).actions[0]?.action ?? null;
}

interface RowCase {
	doc: string;
	name: string;
	entry: MixedEntity;
	expected: SyncActionType | null;
}

// One canonical case per row of docs/sync-pipeline.md "Decision table".
const TABLE: RowCase[] = [
	// --- prevSync present ---
	{
		doc: "yes | exists | exists | yes | yes",
		name: "both changed → conflict",
		entry: {
			path: "f.md",
			local: local({ mtime: 2000, hash: "h-local" }),
			remote: remote({ mtime: 3000, hash: "h-remote" }),
			prevSync: baseline(),
		},
		expected: "conflict",
	},
	{
		doc: "yes | exists | exists | yes | no",
		name: "local changed, remote unchanged → push",
		entry: {
			path: "f.md",
			local: local({ mtime: 2000, hash: "h-local" }),
			remote: remote(),
			prevSync: baseline(),
		},
		expected: "push",
	},
	{
		doc: "yes | exists | exists | no | yes",
		name: "local unchanged, remote changed → pull",
		entry: {
			path: "f.md",
			local: local(),
			remote: remote({ mtime: 2000, hash: "h-remote" }),
			prevSync: baseline(),
		},
		expected: "pull",
	},
	{
		doc: "yes | exists | exists | no | no",
		name: "neither changed → skip",
		entry: {
			path: "f.md",
			local: local(),
			remote: remote(),
			prevSync: baseline(),
		},
		expected: null,
	},
	{
		doc: "yes | exists | missing | yes | --",
		name: "remote deleted, local changed → conflict",
		entry: {
			path: "f.md",
			local: local({ mtime: 2000, hash: "h-local" }),
			prevSync: baseline(),
		},
		expected: "conflict",
	},
	{
		doc: "yes | exists | missing | no | --",
		name: "remote deleted, local unchanged → delete_local",
		entry: { path: "f.md", local: local(), prevSync: baseline() },
		expected: "delete_local",
	},
	{
		doc: "yes | missing | exists | -- | yes",
		name: "local deleted, remote changed → conflict",
		entry: {
			path: "f.md",
			remote: remote({ mtime: 2000, hash: "h-remote" }),
			prevSync: baseline(),
		},
		expected: "conflict",
	},
	{
		doc: "yes | missing | exists | -- | no",
		name: "local deleted, remote unchanged → delete_remote",
		entry: { path: "f.md", remote: remote(), prevSync: baseline() },
		expected: "delete_remote",
	},
	{
		doc: "yes | missing | missing | -- | --",
		name: "both deleted → cleanup",
		entry: { path: "f.md", prevSync: baseline() },
		expected: "cleanup",
	},
	// --- no baseline ---
	{
		doc: "no | exists | missing | -- | --",
		name: "local created → push",
		entry: { path: "f.md", local: local() },
		expected: "push",
	},
	{
		doc: "no | missing | exists | -- | --",
		name: "remote created → pull",
		entry: { path: "f.md", remote: remote() },
		expected: "pull",
	},
	{
		doc: "no | exists | exists | same hash+size | same hash+size",
		name: "both created identical → match",
		entry: {
			path: "f.md",
			local: local({ hash: "h", size: 42 }),
			remote: remote({ hash: "h", size: 42 }),
		},
		expected: "match",
	},
	{
		doc: "no | exists | exists | (otherwise) | (otherwise)",
		name: "both created divergent → conflict",
		entry: {
			path: "f.md",
			local: local({ hash: "h1", size: 42 }),
			remote: remote({ hash: "h2", size: 42 }),
		},
		expected: "conflict",
	},
	// --- branch present in code but absent from the doc table (see decision-engine.ts return null) ---
	{
		doc: "no | missing | missing | -- | -- (undocumented)",
		name: "nothing exists, no baseline → skip",
		entry: { path: "f.md" },
		expected: null,
	},
];

describe("planSync — decision table (docs/sync-pipeline.md)", () => {
	it("returns an empty plan for empty input", () => {
		const plan = planSync([]);
		expect(plan.actions).toHaveLength(0);
	});

	for (const c of TABLE) {
		it(`[${c.doc}] ${c.name}`, () => {
			expect(decide(c.entry)).toBe(c.expected);
		});
	}
});

describe("match condition — all four conjuncts (no baseline, both exist)", () => {
	// match ⟺ local.hash && remote.hash && local.hash === remote.hash && local.size === remote.size
	it("same hash + same size → match", () => {
		expect(
			decide({
				path: "f.md",
				local: local({ hash: "h", size: 42 }),
				remote: remote({ hash: "h", size: 42 }),
			}),
		).toBe("match");
	});

	it("same hash + different size → conflict (degenerate, but the size conjunct must hold)", () => {
		expect(
			decide({
				path: "f.md",
				local: local({ hash: "h", size: 42 }),
				remote: remote({ hash: "h", size: 43 }),
			}),
		).toBe("conflict");
	});

	it("different hash + same size → conflict", () => {
		expect(
			decide({
				path: "f.md",
				local: local({ hash: "h1", size: 42 }),
				remote: remote({ hash: "h2", size: 42 }),
			}),
		).toBe("conflict");
	});

	it("empty local hash → conflict (cannot prove equality → keep both)", () => {
		expect(
			decide({
				path: "f.md",
				local: local({ hash: "", size: 42 }),
				remote: remote({ hash: "h", size: 42 }),
			}),
		).toBe("conflict");
	});

	it("empty remote hash → conflict", () => {
		expect(
			decide({
				path: "f.md",
				local: local({ hash: "h", size: 42 }),
				remote: remote({ hash: "", size: 42 }),
			}),
		).toBe("conflict");
	});

	it("both hashes empty → conflict (conservative)", () => {
		expect(
			decide({
				path: "f.md",
				local: local({ hash: "", size: 42 }),
				remote: remote({ hash: "", size: 42 }),
			}),
		).toBe("conflict");
	});

	it("remote proves identity via same-algo remoteChecksum (hash empty) → match", () => {
		// A remote backend that returns hash:"" but a same-algorithm remoteChecksum
		// whose value equals the local hash provably holds identical content. The
		// match must be recognized through the same content-key abstraction the
		// conflict resolver uses — NOT only via a raw `.hash === .hash` compare that
		// silently depends on hashes having been pre-normalized upstream.
		expect(
			decide({
				path: "f.md",
				local: local({ hash: "h", size: 42 }),
				remote: remote({ hash: "", size: 42, remoteChecksum: { algo: "sha256", value: "h" } }),
			}),
		).toBe("match");
	});

	it("remote remoteChecksum of a different algo cannot prove identity → conflict", () => {
		// Cross-algorithm checksums are not comparable; never a definitive match.
		expect(
			decide({
				path: "f.md",
				local: local({ hash: "h", size: 42 }),
				remote: remote({ hash: "", size: 42, remoteChecksum: { algo: "md5", value: "h" } }),
			}),
		).toBe("conflict");
	});
});

describe("mechanism invariance — the Action is stable regardless of how the predicate flips", () => {
	describe("localChanged → true via different mechanisms (remote unchanged ⇒ push)", () => {
		it("via mtime difference", () => {
			expect(
				decide({
					path: "f.md",
					local: local({ mtime: 2000, hash: "h-local" }),
					remote: remote(),
					prevSync: baseline(),
				}),
			).toBe("push");
		});

		it("via same-size content edit (mtime+size match, hash differs)", () => {
			expect(
				decide({
					path: "f.md",
					local: local({ mtime: 1000, size: 100, hash: "h-edited" }),
					remote: remote(),
					prevSync: baseline(),
				}),
			).toBe("push");
		});

		it("via conservative fallback (mtime=0 and no hash → undeterminable)", () => {
			expect(
				decide({
					path: "f.md",
					local: local({ mtime: 0, hash: "" }),
					remote: remote(),
					prevSync: baseline(),
				}),
			).toBe("push");
		});
	});

	describe("remoteChanged → true via different mechanisms (local unchanged ⇒ pull)", () => {
		it("via mtime difference", () => {
			expect(
				decide({
					path: "f.md",
					local: local(),
					remote: remote({ mtime: 2000, hash: "h-remote" }),
					prevSync: baseline(),
				}),
			).toBe("pull");
		});

		it("via size-only change", () => {
			expect(
				decide({
					path: "f.md",
					local: local(),
					remote: remote({ mtime: 1000, size: 200, hash: BASE_HASH }),
					prevSync: baseline(),
				}),
			).toBe("pull");
		});

		it("via remoteChecksum (Drive md5) when mtime drifts", () => {
			expect(
				decide({
					path: "f.md",
					local: local(),
					remote: remote({
						mtime: 2000,
						remoteChecksum: { algo: "md5", value: "md5-new" },
					}),
					prevSync: baseline({
						remoteChecksum: { algo: "md5", value: "md5-old" },
					}),
				}),
			).toBe("pull");
		});
	});

	describe("both predicates false despite noisy metadata ⇒ skip", () => {
		it("local proven unchanged by hash, remote by remoteChecksum, even though mtimes drift", () => {
			expect(
				decide({
					path: "f.md",
					local: local({ mtime: 5000, hash: BASE_HASH }),
					remote: remote({
						mtime: 6000,
						hash: BASE_HASH,
						remoteChecksum: { algo: "md5", value: "md5-x" },
					}),
					prevSync: baseline({
						remoteChecksum: { algo: "md5", value: "md5-x" },
					}),
				}),
			).toBe(null);
		});
	});

	describe("delete vs conflict hinges purely on the surviving side's predicate", () => {
		it("remote gone, local unchanged via hash (mtime drift) → delete_local", () => {
			expect(
				decide({
					path: "f.md",
					local: local({ mtime: 9000, hash: BASE_HASH }),
					prevSync: baseline(),
				}),
			).toBe("delete_local");
		});

		it("local gone, remote changed via remoteChecksum → conflict", () => {
			expect(
				decide({
					path: "f.md",
					remote: remote({
						mtime: 2000,
						remoteChecksum: { algo: "md5", value: "md5-new" },
					}),
					prevSync: baseline({
						remoteChecksum: { algo: "md5", value: "md5-old" },
					}),
				}),
			).toBe("conflict");
		});
	});
});

describe("emitted SyncAction structure", () => {
	it("carries the entry's path and the original local/remote/baseline object references", () => {
		const l = local({
			path: "notes/deep/x.md",
			mtime: 2000,
			hash: "h-local",
		});
		const r = remote({ path: "notes/deep/x.md" });
		const b = baseline({ path: "notes/deep/x.md" });
		const action = planSync([
			{ path: "notes/deep/x.md", local: l, remote: r, prevSync: b },
		]).actions[0]!;
		expect(action.path).toBe("notes/deep/x.md");
		expect(action.local).toBe(l);
		expect(action.remote).toBe(r);
		expect(action.baseline).toBe(b);
	});

	it("preserves input order and decides each entry independently (skips removed)", () => {
		const entries: MixedEntity[] = [
			{ path: "a-push.md", local: local({ path: "a-push.md" }) },
			{
				path: "b-skip.md",
				local: local({ path: "b-skip.md" }),
				remote: remote({ path: "b-skip.md" }),
				prevSync: baseline({ path: "b-skip.md" }),
			},
			{ path: "c-pull.md", remote: remote({ path: "c-pull.md" }) },
			{
				path: "d-del.md",
				remote: remote({ path: "d-del.md" }),
				prevSync: baseline({ path: "d-del.md" }),
			},
		];
		const actions = planSync(entries).actions;
		expect(actions.map((a) => [a.path, a.action])).toEqual([
			["a-push.md", "push"],
			["c-pull.md", "pull"],
			["d-del.md", "delete_remote"],
		]);
	});
});

describe("one plan action per path (ADR 0001 T7 invariant)", () => {
	// The `withCacheMutex` stale-guard is dormant only because no two CONCURRENT
	// (Group-A: push/pull/match/cleanup) actions ever target the same path — a parallel
	// write then can't re-key another write's guarded path mid-upload. The source of
	// that uniqueness is here: planSync mints exactly one action per changeset entry,
	// and entries are unique by path. (refinePlan only removes/reclassifies Group-A
	// actions into Group-B renames — see rename-optimizer.test.ts — so it preserves it.)
	it("emits exactly one action per path across every action type", () => {
		const entries: MixedEntity[] = [
			{ path: "push.md", local: local({ mtime: 2000, hash: "h-local" }), remote: remote(), prevSync: baseline() },
			{ path: "pull.md", local: local(), remote: remote({ mtime: 3000, hash: "h-remote" }), prevSync: baseline() },
			{ path: "match.md", local: local(), remote: remote() },
			{ path: "del-remote.md", remote: remote(), prevSync: baseline() },
			{ path: "del-local.md", local: local(), prevSync: baseline() },
			{ path: "cleanup.md", prevSync: baseline() },
		];
		const actions = planSync(entries).actions;

		// Every entry produced exactly one action (none collapsed two onto one path).
		expect(actions).toHaveLength(entries.length);
		const paths = actions.map((a) => a.path);
		expect(new Set(paths).size).toBe(paths.length);
		// Sanity: this changeset really did exercise the parallel Group-A op (push).
		expect(actions.some((a) => a.action === "push")).toBe(true);
	});
});

describe("cold safety: no baseline never deletes", () => {
	// The volume-based safety-check was removed (it caused §2-1 data loss by
	// aborting legitimate all-deletion batches). The decision rules are now the
	// sole guard against data loss, so pin the cold-start invariant explicitly:
	// a missing baseline must never produce a deletion — an empty/incomplete
	// baseline reconciles via push/pull/match/conflict, never delete_*/cleanup.
	it("no prevSync never yields delete_* or cleanup for any local/remote combo", () => {
		const combos: MixedEntity[] = [
			{ path: "f.md", local: local() },
			{ path: "f.md", remote: remote() },
			{ path: "f.md", local: local(), remote: remote() },
			{ path: "f.md", local: local({ hash: "x" }), remote: remote({ hash: "y", size: 200 }) },
			{ path: "f.md" },
		];
		for (const entry of combos) {
			const action = decide(entry);
			expect(["delete_local", "delete_remote", "cleanup"]).not.toContain(action);
		}
	});
});
