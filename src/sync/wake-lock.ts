import type { Logger } from "../logging/logger";

export interface WakeLockDeps {
	/**
	 * True only when a wake lock should be held — the caller encodes the policy
	 * (e.g. `Platform.isMobile && settings.screenWakeLockOnSync`). This module is
	 * platform- and settings-agnostic.
	 */
	isEnabled: () => boolean;
	/** Register a cleanup callback fired on plugin unload. */
	register: (cb: () => void) => void;
	/**
	 * Register a document event whose listener is auto-removed on plugin unload
	 * (Obsidian's Component#registerDomEvent). The element is captured once at
	 * registration, so add/remove can never target different documents.
	 */
	registerDocumentEvent: (type: keyof DocumentEventMap, cb: () => void) => void;
	logger?: Logger;
}

/**
 * Holds a screen wake lock while a sync is active so the device does not sleep
 * mid-sync and suspend the WebView's JavaScript (the cause of syncs stalling on
 * mobile). There is no OS background-execution API available to a plugin; this
 * only keeps the screen awake while Obsidian is foreground and visible.
 *
 * The Screen Wake Lock API auto-releases when the document becomes hidden and
 * does not re-acquire on its own, so we re-request on `visibilitychange` while a
 * sync is still active.
 */
export class ScreenWakeLockManager {
	private deps: WakeLockDeps;
	private sentinel: WakeLockSentinel | null = null;
	/** Whether a sync is currently active (we want the lock held). */
	private want = false;
	/** True while an acquire() request is in flight, to serialize acquisition. */
	private acquiring = false;

	constructor(deps: WakeLockDeps) {
		this.deps = deps;
		// registerDocumentEvent auto-removes the listener on unload.
		deps.registerDocumentEvent("visibilitychange", () => this.onVisible());
		deps.register(() => {
			// Clear `want` first so any acquire() still awaiting its request
			// releases the lock at the post-await check instead of storing it.
			this.want = false;
			void this.release();
		});
	}

	/** Mark sync active/inactive; acquires or releases the wake lock accordingly. */
	setActive(active: boolean): void {
		this.want = active;
		if (active) {
			void this.acquire();
		} else {
			void this.release();
		}
	}

	private async acquire(): Promise<void> {
		// `acquiring` serializes overlapping calls: the `sentinel` guard alone is
		// checked before the await, so two callers (e.g. setActive racing
		// visibilitychange) could otherwise both request a lock and leak the first.
		if (!this.want || this.sentinel || this.acquiring) return;
		if (!this.deps.isEnabled()) return;
		if (typeof navigator === "undefined" || !navigator.wakeLock) return;
		// eslint-disable-next-line obsidianmd/prefer-active-doc -- intentional: the screen wake lock is an app-level concern; gate on the main window's visibility, not a focused popout (activeDocument).
		if (document.visibilityState !== "visible") return;
		this.acquiring = true;
		try {
			const sentinel = await navigator.wakeLock.request("screen");
			// A deactivation (or unload) may have raced in while we awaited the
			// request; honor it rather than leaking a lock that is never released.
			if (!this.want) {
				await sentinel.release();
				return;
			}
			this.sentinel = sentinel;
			sentinel.addEventListener("release", () => {
				// OS auto-released (e.g. the document became hidden) — drop our
				// reference so onVisible() can re-acquire on return.
				if (this.sentinel === sentinel) this.sentinel = null;
			});
		} catch (e) {
			this.deps.logger?.warn("Failed to acquire screen wake lock", {
				message: e instanceof Error ? e.message : String(e),
			});
		} finally {
			this.acquiring = false;
		}
	}

	private async release(): Promise<void> {
		const sentinel = this.sentinel;
		this.sentinel = null;
		if (!sentinel) return;
		try {
			await sentinel.release();
		} catch (e) {
			this.deps.logger?.debug("Failed to release screen wake lock", {
				message: e instanceof Error ? e.message : String(e),
			});
		}
	}

	private onVisible(): void {
		if (!this.want || this.sentinel) return;
		// eslint-disable-next-line obsidianmd/prefer-active-doc -- intentional: app-level visibility gate for the screen wake lock (same rationale as acquire()).
		if (document.visibilityState !== "visible") return;
		void this.acquire();
	}
}
