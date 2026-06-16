import { debounce, TFolder } from "obsidian";
import type { EventRef, Workspace, Vault, TAbstractFile, TFile } from "obsidian";
import type { IFileSystem } from "../fs/interface";
import type { SyncStateStore } from "./state";
import type { LocalChangeTracker } from "./local-tracker";
import { hasChanged, hasRemoteChanged } from "./change-compare";

const DEBOUNCE_MS = 5000;

export interface SyncOrchestrator {
	runSync(): Promise<void>;
	pullSingle(path: string): Promise<void>;
	isSyncing(): boolean;
}

export interface SyncSchedulerDeps {
	workspace: Workspace;
	vault: Vault;
	localFs: () => IFileSystem | null;
	remoteFs: () => IFileSystem | null;
	stateStore: SyncStateStore;
	localTracker: LocalChangeTracker;
	orchestrator: SyncOrchestrator;
	isExcluded: (path: string) => boolean;
	registerEvent: (ref: EventRef) => void;
	registerWindowEvent: (type: keyof WindowEventMap, cb: () => void) => void;
	registerDocumentEvent: (type: keyof DocumentEventMap, cb: () => void) => void;
}

export class SyncScheduler {
	private deps: SyncSchedulerDeps;
	private debouncedSync: ReturnType<typeof debounce>;
	private destroyed = false;
	/**
	 * Whether the app has left the foreground since it was last in sync. A
	 * foreground signal (focus / visibilitychange→visible) re-checks the remote
	 * only when this is true — a genuine background→foreground (mobile) or
	 * app-switch (desktop/tablet) return. It starts false: at cold start the
	 * onLayoutReady catch-up sync already covers the initial foreground, so the
	 * trailing foreground signal — the deferred-to-first-touch `focus` on mobile —
	 * is NOT a return and must not fire a second, redundant sync. See ADR 0007.
	 */
	private departed = false;

	constructor(deps: SyncSchedulerDeps) {
		this.deps = deps;
		this.debouncedSync = debounce(
			() => {
				if (!this.deps.remoteFs()) return;
				void deps.orchestrator.runSync();
			},
			DEBOUNCE_MS,
			true,
		);
	}

	start(): void {
		if (this.deps.workspace.layoutReady) {
			this.wireAll();
		} else {
			// Defer event wiring until the vault index is loaded, so an early
			// focus/visibility/online/vault event cannot trigger a sync against
			// an incomplete local listing (getAllLoadedFiles under-reports).
			this.deps.workspace.onLayoutReady(() => this.wireAll());
		}
	}

	private wireAll(): void {
		// onLayoutReady may fire after the plugin unloads; do not wire then.
		if (this.destroyed) return;
		this.wireVaultEvents();
		this.wireOnlineEvent();
		this.wireVisibilityEvent();
		this.wireFocusEvent();
		this.wireDepartureEvents();
		this.wireFileOpenEvent();
	}

	destroy(): void {
		this.destroyed = true;
		this.debouncedSync.cancel();
	}

	/**
	 * The NETWORK signal path (online): re-check now, unless no backend or a sync
	 * is already running. The `isSyncing()` guard discards the request while a
	 * sync is in flight — the in-flight cycle already performs the full re-scan a
	 * signal asks for. It is load-bearing, NOT redundant with runSync's own lock
	 * check: runSync's check sets `syncPending` (a re-run), this one suppresses it
	 * for signals (ADR 0004). Foreground signals use triggerForegroundSync instead.
	 */
	private triggerSync(): void {
		if (!this.deps.remoteFs()) return;
		if (this.deps.orchestrator.isSyncing()) return;
		void this.deps.orchestrator.runSync();
	}

	/**
	 * The FOREGROUND signal path (focus / visibilitychange→visible). Re-checks the
	 * remote only on a genuine return — after the app actually left the foreground
	 * (`departed`). This drops the redundant cold-start signal (no departure since
	 * the onLayoutReady catch-up sync) while still syncing every real resume, with
	 * no timing window. If a sync is already in flight, return WITHOUT clearing
	 * `departed`: that cycle may predate the departure, so a later signal must
	 * still re-check — never miss a return (ADR 0007). The `departed` flag is
	 * cleared only here, when we actually run the resume sync.
	 */
	private triggerForegroundSync(): void {
		if (!this.deps.remoteFs()) return;
		if (this.deps.orchestrator.isSyncing()) return;
		if (!this.departed) return;
		this.departed = false;
		void this.deps.orchestrator.runSync();
	}

	// `focus` and `visibilitychange→visible` are BOTH wired on every platform —
	// not redundant. `focus` is the only return signal for a desktop alt-tab AND
	// a tablet split-view / Stage Manager app-switch: both keep the document
	// `visible`, so visibilitychange never fires there. On a phone background,
	// window focus is unreliable, so visibilitychange→visible is the dependable
	// return signal. Each covers a case the other misses across iOS/Android/
	// desktop, so neither can be dropped or platform-gated without losing a
	// resume somewhere. The cost — a real resume firing both — is absorbed by
	// triggerForegroundSync: the first clears `departed`, so the second is a
	// no-op (and a sync in flight blocks both via isSyncing). See ADR 0007.
	private wireFocusEvent(): void {
		this.deps.registerWindowEvent("focus", () => this.triggerForegroundSync());
	}

	private wireVaultEvents(): void {
		const { vault, localTracker, isExcluded } = this.deps;

		const onVaultChange = (file: TAbstractFile) => {
			if (!isExcluded(file.path)) {
				localTracker.markDirty(file.path);
				this.debouncedSync();
			}
		};

		const onRename = (file: TAbstractFile, oldPath: string) => {
			if (!isExcluded(file.path) && !isExcluded(oldPath)) {
				if (file instanceof TFolder) {
					localTracker.markFolderRenamed(file.path, oldPath);
				} else {
					localTracker.markRenamed(file.path, oldPath);
				}
			} else {
				if (!isExcluded(file.path)) localTracker.markDirty(file.path);
				if (!isExcluded(oldPath)) localTracker.markDirty(oldPath);
			}
			if (!isExcluded(file.path) || !isExcluded(oldPath)) {
				this.debouncedSync();
			}
		};

		this.deps.registerEvent(vault.on("create", onVaultChange));
		this.deps.registerEvent(vault.on("modify", onVaultChange));
		this.deps.registerEvent(vault.on("delete", onVaultChange));
		this.deps.registerEvent(vault.on("rename", onRename));
	}

	private wireOnlineEvent(): void {
		this.deps.registerWindowEvent("online", () => this.triggerSync());
	}

	// Paired with wireFocusEvent above (see that comment for why both exist).
	private wireVisibilityEvent(): void {
		this.deps.registerDocumentEvent("visibilitychange", () => {
			// App-level visibility: read the main document (matching the focus/
			// online listeners), not activeDocument — we want "Obsidian is
			// foreground", not whichever popout happens to be focused.
			if (document.visibilityState === "visible") {
				this.triggerForegroundSync();
			} else {
				// Backgrounding (phone/tablet) is a departure — the next foreground
				// signal is then a genuine return that should re-check.
				this.departed = true;
			}
		});
	}

	// Departure boundary, OR'd with visibilitychange→hidden so a genuine return is
	// never missed (a spurious departure only costs one extra re-check, never a
	// stale miss). `blur` is the ONLY departure signal for a desktop alt-tab AND a
	// tablet split-view / Stage Manager app-switch: both keep the document
	// `visible`, so visibilitychange→hidden never fires there. Window-level blur
	// fires on app focus loss — not on element focus or the soft keyboard — so it
	// does not mark spurious departures during normal editing. (Focusing an
	// Obsidian popout window does blur the main window → one harmless extra
	// re-check on return; not worth distinguishing.) See ADR 0007.
	private wireDepartureEvents(): void {
		this.deps.registerWindowEvent("blur", () => {
			this.departed = true;
		});
	}

	private wireFileOpenEvent(): void {
		const { workspace, stateStore, localFs, remoteFs, orchestrator } = this.deps;

		this.deps.registerEvent(
			workspace.on("file-open", async (file: TFile | null) => {
				if (!file) return;
				const record = await stateStore.get(file.path);
				if (!record) return;
				const lFs = localFs();
				const rFs = remoteFs();
				if (!lFs || !rFs) return;
				const [localStat, remote] = await Promise.all([
					lFs.stat(file.path),
					rFs.stat(file.path),
				]);
				if (!remote || remote.isDirectory) return;
				if (!hasRemoteChanged(remote, record)) return;
				if (localStat && hasChanged(localStat, record)) return;
				await orchestrator.pullSingle(file.path);
			}),
		);
	}
}
