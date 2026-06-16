import { describe, it, expect, vi, beforeEach } from "vitest";

// DOM-event handlers captured via the registerWindowEvent / registerDocumentEvent
// deps below (in production the plugin wires these through Component#registerDomEvent).
const windowListeners = new Map<string, EventListener>();
const documentListeners = new Map<string, EventListener>();

// The visibility handler reads document.visibilityState; stub a visible document.
vi.stubGlobal("document", { visibilityState: "visible" as string });

import { SyncScheduler } from "./scheduler";
import type { SyncSchedulerDeps } from "./scheduler";
import type { EventRef, TAbstractFile } from "obsidian";
import { LocalChangeTracker } from "./local-tracker";
import {
	createMockFs,
	createMockStateStore,
} from "../__mocks__/sync-test-helpers";
import { sha256 } from "../utils/hash";
import type { SyncRecord } from "./types";

type VaultHandler = (file: TAbstractFile) => void;
type RenameHandler = (file: TAbstractFile, oldPath: string) => void;
type WorkspaceHandler = (...args: unknown[]) => Promise<void> | void;

function createDeps(
	overrides: Partial<SyncSchedulerDeps> = {},
	opts: { layoutReady?: boolean } = {},
) {
	const vaultHandlers = new Map<string, WorkspaceHandler>();
	const workspaceHandlers = new Map<string, WorkspaceHandler>();
	let layoutReady = opts.layoutReady ?? true;
	const layoutReadyCbs: (() => void)[] = [];
	const fireLayoutReady = () => {
		layoutReady = true;
		const cbs = layoutReadyCbs.splice(0);
		for (const cb of cbs) cb();
	};

	const runSync = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
	const pullSingle = vi
		.fn<(path: string) => Promise<void>>()
		.mockResolvedValue(undefined);

	const deps: SyncSchedulerDeps & {
		vaultHandlers: Map<string, WorkspaceHandler>;
		workspaceHandlers: Map<string, WorkspaceHandler>;
		runSync: typeof runSync;
		pullSingle: typeof pullSingle;
		fireLayoutReady: () => void;
	} = {
		workspace: {
			on: vi.fn((event: string, handler: WorkspaceHandler) => {
				workspaceHandlers.set(event, handler);
				return {} as EventRef;
			}),
			get layoutReady() {
				return layoutReady;
			},
			onLayoutReady: (cb: () => void) => {
				if (layoutReady) cb();
				else layoutReadyCbs.push(cb);
			},
		} as unknown as SyncSchedulerDeps["workspace"],
		vault: {
			on: vi.fn((event: string, handler: WorkspaceHandler) => {
				vaultHandlers.set(event, handler);
				return {} as EventRef;
			}),
		} as unknown as SyncSchedulerDeps["vault"],
		localFs: () => createMockFs("local"),
		remoteFs: () => createMockFs("remote"),
		stateStore: createMockStateStore(),
		localTracker: new LocalChangeTracker(),
		orchestrator: { runSync, pullSingle, isSyncing: () => false },
		isExcluded: () => false,
		registerEvent: vi.fn(),
		registerWindowEvent: (type: keyof WindowEventMap, cb: () => void) => {
			windowListeners.set(type, cb);
		},
		registerDocumentEvent: (type: keyof DocumentEventMap, cb: () => void) => {
			documentListeners.set(type, cb);
		},
		vaultHandlers,
		workspaceHandlers,
		runSync,
		pullSingle,
		fireLayoutReady,
		...overrides,
	};
	return deps;
}

function makeFile(path: string): TAbstractFile {
	return { path } as TAbstractFile;
}

describe("SyncScheduler", () => {
	let deps: ReturnType<typeof createDeps>;
	let scheduler: SyncScheduler;

	beforeEach(() => {
		vi.useFakeTimers();
		// Reset captured handlers so a stale closure from a prior test can't leak.
		windowListeners.clear();
		documentListeners.clear();
		// Reset visibility (a test may set it hidden) so each starts foregrounded.
		(document as unknown as { visibilityState: string }).visibilityState = "visible";
		deps = createDeps();
		scheduler = new SyncScheduler(deps);
		scheduler.start();
	});

	// Foreground signals (focus / visibilitychange→visible) only sync after a
	// departure (ADR 0007). These helpers drive a departure and a return.
	const fireBlur = () => windowListeners.get("blur")!(new Event("blur"));
	const fireFocus = () => windowListeners.get("focus")!(new Event("focus"));
	const fireVisibility = (state: string) => {
		(document as unknown as { visibilityState: string }).visibilityState = state;
		documentListeners.get("visibilitychange")!(new Event("visibilitychange"));
	};

	describe("layout-ready gate", () => {
		it("defers event wiring until the vault layout is ready", () => {
			const d = createDeps({}, { layoutReady: false });
			const s = new SyncScheduler(d);
			s.start();

			// Not ready: no events wired, so nothing can trigger a sync.
			expect(d.vaultHandlers.size).toBe(0);

			// Layout becomes ready → events wire and now drive sync.
			d.fireLayoutReady();
			const handler = d.vaultHandlers.get("modify") as VaultHandler;
			expect(handler).toBeDefined();
			handler(makeFile("note.md"));
			vi.advanceTimersByTime(5000);
			expect(d.runSync).toHaveBeenCalled();
		});
	});

	describe("vault events", () => {
		it("marks path dirty on create", () => {
			const handler = deps.vaultHandlers.get("create") as VaultHandler;
			handler(makeFile("note.md"));
			expect(deps.localTracker.getDirtyPaths().has("note.md")).toBe(true);
		});

		it("marks path dirty on modify", () => {
			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			expect(deps.localTracker.getDirtyPaths().has("note.md")).toBe(true);
		});

		it("marks path dirty on delete", () => {
			const handler = deps.vaultHandlers.get("delete") as VaultHandler;
			handler(makeFile("note.md"));
			expect(deps.localTracker.getDirtyPaths().has("note.md")).toBe(true);
		});

		it("records rename pair and marks both paths dirty on rename", () => {
			const handler = deps.vaultHandlers.get("rename") as RenameHandler;
			handler(makeFile("new.md"), "old.md");
			expect(deps.localTracker.getDirtyPaths().has("new.md")).toBe(true);
			expect(deps.localTracker.getDirtyPaths().has("old.md")).toBe(true);
			expect(deps.localTracker.getRenamePairs().get("new.md")).toBe(
				"old.md",
			);
		});

		it("falls back to markDirty when one side of rename is excluded", () => {
			scheduler.destroy();
			deps = createDeps({ isExcluded: (p: string) => p === "old.md" });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = deps.vaultHandlers.get("rename") as RenameHandler;
			handler(makeFile("new.md"), "old.md");
			expect(deps.localTracker.getDirtyPaths().has("new.md")).toBe(true);
			expect(deps.localTracker.getDirtyPaths().has("old.md")).toBe(false);
			expect(deps.localTracker.getRenamePairs().size).toBe(0);
		});

		it("skips excluded paths", () => {
			scheduler.destroy();
			deps = createDeps({
				isExcluded: (p: string) => p.startsWith("excluded/"),
			});
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = deps.vaultHandlers.get("create") as VaultHandler;
			handler(makeFile("excluded/note.md"));
			expect(
				deps.localTracker.getDirtyPaths().has("excluded/note.md"),
			).toBe(false);
		});

		it("triggers debounced sync on vault change", () => {
			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).toHaveBeenCalled();
		});

		it("coalesces rapid vault changes into a single sync", () => {
			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("a.md"));
			vi.advanceTimersByTime(2000);
			handler(makeFile("b.md"));
			vi.advanceTimersByTime(2000);
			handler(makeFile("c.md"));
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).toHaveBeenCalledTimes(1);
		});

		it("does not trigger sync for excluded paths", () => {
			scheduler.destroy();
			deps = createDeps({ isExcluded: () => true });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("ignored.md"));
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).not.toHaveBeenCalled();
		});

		it("skips debounced sync on vault change when remoteFs is null", () => {
			scheduler.destroy();
			deps = createDeps({ remoteFs: () => null });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).not.toHaveBeenCalled();
		});
	});

	describe("file-open priority sync", () => {
		it("pulls when remote changed but local unchanged", async () => {
			// Baseline hash reflects the local content, so stat()'s SHA-256 matches it
			// and the local side is correctly seen as unchanged (only remote differs).
			const localContent = new ArrayBuffer(10);
			const record: SyncRecord = {
				path: "note.md",
				hash: await sha256(localContent),
				localMtime: 1000,
				remoteMtime: 1000,
				localSize: 10,
				remoteSize: 10,
				syncedAt: 900,
			};
			await deps.stateStore.put(record);

			const localFs = createMockFs("local");
			const remoteFs = createMockFs("remote");
			localFs.files.set("note.md", {
				content: localContent,
				entity: {
					path: "note.md",
					isDirectory: false,
					size: 10,
					mtime: 1000,
					hash: "",
				},
			});
			remoteFs.files.set("note.md", {
				content: new ArrayBuffer(15),
				entity: {
					path: "note.md",
					isDirectory: false,
					size: 15,
					mtime: 2000,
					hash: "",
				},
			});

			scheduler.destroy();
			deps = createDeps({
				stateStore: deps.stateStore,
				localFs: () => localFs,
				remoteFs: () => remoteFs,
			});
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = deps.workspaceHandlers.get("file-open")!;
			await handler({ path: "note.md" });

			expect(deps.pullSingle).toHaveBeenCalledWith("note.md");
		});

		it("skips pull when no sync record", async () => {
			const handler = deps.workspaceHandlers.get("file-open")!;
			await handler({ path: "unknown.md" });
			expect(deps.pullSingle).not.toHaveBeenCalled();
		});

		it("skips pull when file is null", async () => {
			const handler = deps.workspaceHandlers.get("file-open")!;
			await handler(null);
			expect(deps.pullSingle).not.toHaveBeenCalled();
		});
	});

	describe("focus event", () => {
		it("triggers sync on focus after a departure (alt-tab / split-view return)", () => {
			fireBlur(); // depart
			fireFocus(); // return
			expect(deps.runSync).toHaveBeenCalled();
		});

		it("skips sync on focus when remoteFs is null", () => {
			scheduler.destroy();
			deps = createDeps({ remoteFs: () => null });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			fireBlur();
			fireFocus();
			expect(deps.runSync).not.toHaveBeenCalled();
		});
	});

	describe("online event", () => {
		it("triggers sync on network restore (no departure needed)", () => {
			const handler = windowListeners.get("online");
			expect(handler).toBeDefined();
			handler!(new Event("online"));
			expect(deps.runSync).toHaveBeenCalled();
		});

		it("skips sync on online event when remoteFs is null", () => {
			scheduler.destroy();
			deps = createDeps({ remoteFs: () => null });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			const handler = windowListeners.get("online");
			handler!(new Event("online"));
			expect(deps.runSync).not.toHaveBeenCalled();
		});
	});

	describe("visibility event", () => {
		it("triggers sync when app becomes visible after backgrounding", () => {
			fireVisibility("hidden"); // depart
			fireVisibility("visible"); // resume
			expect(deps.runSync).toHaveBeenCalled();
		});

		it("skips sync on visibility change when remoteFs is null", () => {
			scheduler.destroy();
			deps = createDeps({ remoteFs: () => null });
			scheduler = new SyncScheduler(deps);
			scheduler.start();

			fireVisibility("hidden");
			fireVisibility("visible");
			expect(deps.runSync).not.toHaveBeenCalled();
		});
	});

	// Foreground signals (focus / visibilitychange→visible) sync only on a genuine
	// return — after the app actually left the foreground. This drops the
	// redundant cold-start signal (the mobile deferred-to-first-touch focus, which
	// arrives with no preceding departure) while still syncing every real resume,
	// without a timing window. Departure is OR'd across blur + visibilitychange→
	// hidden so phone/tablet/desktop are all covered (ADR 0007).
	describe("departure gating (ADR 0007)", () => {
		it("skips a foreground signal with no departure (cold-start trailing focus)", () => {
			fireFocus(); // no preceding departure
			fireVisibility("visible");
			expect(deps.runSync).not.toHaveBeenCalled();
		});

		it("clears departed after the resume sync — a second foreground signal is a no-op", () => {
			fireBlur();
			fireFocus(); // genuine return → one sync
			fireFocus(); // departed cleared → no second sync
			expect(deps.runSync).toHaveBeenCalledTimes(1);
		});

		it("a blur departure arms a later visibilitychange→visible too", () => {
			fireBlur(); // desktop/tablet app-switch away (no visibilitychange)
			fireVisibility("visible"); // return
			expect(deps.runSync).toHaveBeenCalledTimes(1);
		});

		it("keeps departed set when a foreground signal is dropped mid-sync, so a later return still syncs", () => {
			// The load-bearing "never miss a resume" guarantee: a return landing on an
			// in-flight cycle (which may predate the departure) is dropped WITHOUT
			// clearing departed, so the next signal still re-checks. Reordering the
			// isSyncing() guard to clear departed first would break this silently.
			fireBlur(); // departed = true
			deps.orchestrator.isSyncing = () => true;
			fireFocus(); // dropped (in flight) — must NOT clear departed
			expect(deps.runSync).not.toHaveBeenCalled();

			deps.orchestrator.isSyncing = () => false;
			fireFocus(); // departed survived → resume syncs now
			expect(deps.runSync).toHaveBeenCalledTimes(1);
		});
	});

	// The asymmetry that IS the trigger classification (ADR 0004): a signal
	// (focus/online/visibility) is a content-less "re-check everything" request,
	// so it is dropped while a sync is already in flight — the in-flight cycle
	// already does that scan. A vault change carries a real local edit, so it
	// must still drive a re-run (via debounce → syncPending) even mid-sync.
	// Pins the load-bearing `isSyncing()` guard so a future "cleanup" can't
	// delete it silently (deleting it makes a signal set syncPending and run a
	// redundant WARM full scan).
	describe("trigger classification (ADR 0004)", () => {
		it("discards a signal (focus/online/visibility) while a sync is in flight", () => {
			fireBlur(); // depart, so focus/visibility would otherwise sync
			deps.orchestrator.isSyncing = () => true;

			fireFocus();
			windowListeners.get("online")!(new Event("online"));
			fireVisibility("visible");

			expect(deps.runSync).not.toHaveBeenCalled();
		});

		it("still drives a vault change (via debounce) while a sync is in flight", () => {
			deps.orchestrator.isSyncing = () => true;

			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			vi.advanceTimersByTime(5000);

			expect(deps.runSync).toHaveBeenCalled();
		});
	});

	describe("destroy", () => {
		it("cancels debounced sync", () => {
			const handler = deps.vaultHandlers.get("modify") as VaultHandler;
			handler(makeFile("note.md"));
			scheduler.destroy();
			vi.advanceTimersByTime(5000);
			expect(deps.runSync).not.toHaveBeenCalled();
		});
	});
});
