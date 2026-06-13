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
		this.wireFileOpenEvent();
	}

	destroy(): void {
		this.destroyed = true;
		this.debouncedSync.cancel();
	}

	/** Trigger a full sync now, unless no backend is configured or one is already running. */
	private triggerSync(): void {
		if (!this.deps.remoteFs()) return;
		if (this.deps.orchestrator.isSyncing()) return;
		void this.deps.orchestrator.runSync();
	}

	// `focus` and `visibilitychange` are deliberately BOTH wired on every
	// platform — they are not redundant. `focus` is the only signal for a
	// desktop app-to-app switch (alt-tab): Electron keeps the document
	// `visible` in the background, so visibilitychange never fires. On mobile
	// webviews window focus is unreliable on resume, so visibilitychange is the
	// dependable foreground signal. Each covers a case the other misses, so
	// dropping or platform-gating either one would lose a resume sync somewhere.
	// The cost — a single resume firing both — is absorbed downstream: the
	// `isSyncing()` guard in triggerSync, then runSync coalescing into one
	// burst, then CycleSummary collapsing it to one notice (see commit 884b948).
	private wireFocusEvent(): void {
		this.deps.registerWindowEvent("focus", () => this.triggerSync());
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
			if (document.visibilityState !== "visible") return;
			this.triggerSync();
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
