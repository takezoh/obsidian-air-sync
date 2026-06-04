import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal document/navigator stubs for the wake-lock manager's event wiring and
// the Screen Wake Lock API. Mirrors the global-stub approach in scheduler.test.ts.
const documentListeners = new Map<string, EventListener>();
const wakeLockRequest = vi.fn<(type: "screen") => Promise<WakeLockSentinel>>();

const documentStub = {
	visibilityState: "visible" as DocumentVisibilityState,
	addEventListener: (event: string, handler: EventListener) => {
		documentListeners.set(event, handler);
	},
	removeEventListener: (event: string, _handler: EventListener) => {
		documentListeners.delete(event);
	},
};

vi.stubGlobal("document", documentStub);
vi.stubGlobal("navigator", { wakeLock: { request: wakeLockRequest } });

import { ScreenWakeLockManager } from "./wake-lock";
import type { WakeLockDeps } from "./wake-lock";
import type { Logger } from "../logging/logger";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makeSentinel() {
	const releaseHandlers: EventListener[] = [];
	const release = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
	const sentinel = {
		released: false,
		type: "screen",
		release,
		addEventListener: (type: string, handler: EventListener) => {
			if (type === "release") releaseHandlers.push(handler);
		},
		removeEventListener: () => {},
		onrelease: null,
	} as unknown as WakeLockSentinel;
	const fireAutoRelease = () => {
		for (const h of releaseHandlers) h(new Event("release"));
	};
	return { sentinel, release, fireAutoRelease };
}

function createDeps(overrides: Partial<WakeLockDeps> = {}) {
	const cleanups: Array<() => void> = [];
	const logger = { warn: vi.fn(), debug: vi.fn() };
	const deps: WakeLockDeps = {
		isEnabled: () => true,
		register: (cb: () => void) => cleanups.push(cb),
		logger: logger as unknown as Logger,
		...overrides,
	};
	return { deps, cleanups, logger };
}

/** Read the manager's private sentinel without `as any`. */
function heldSentinel(mgr: ScreenWakeLockManager): WakeLockSentinel | null {
	return (mgr as unknown as { sentinel: WakeLockSentinel | null }).sentinel;
}

function fireVisibility(state: DocumentVisibilityState) {
	documentStub.visibilityState = state;
	const handler = documentListeners.get("visibilitychange");
	handler?.(new Event("visibilitychange"));
}

describe("ScreenWakeLockManager", () => {
	beforeEach(() => {
		documentListeners.clear();
		wakeLockRequest.mockReset();
		documentStub.visibilityState = "visible";
	});

	it("acquires a screen wake lock when activated while enabled and visible", async () => {
		const { sentinel } = makeSentinel();
		wakeLockRequest.mockResolvedValue(sentinel);
		const { deps } = createDeps();
		const mgr = new ScreenWakeLockManager(deps);

		mgr.setActive(true);
		await flush();

		expect(wakeLockRequest).toHaveBeenCalledWith("screen");
		expect(heldSentinel(mgr)).toBe(sentinel);
	});

	it("releases the held lock when deactivated", async () => {
		const { sentinel, release } = makeSentinel();
		wakeLockRequest.mockResolvedValue(sentinel);
		const mgr = new ScreenWakeLockManager(createDeps().deps);

		mgr.setActive(true);
		await flush();
		mgr.setActive(false);
		await flush();

		expect(release).toHaveBeenCalledTimes(1);
		expect(heldSentinel(mgr)).toBeNull();
	});

	it("does not acquire when disabled (desktop or toggle off)", async () => {
		const { sentinel } = makeSentinel();
		wakeLockRequest.mockResolvedValue(sentinel);
		const mgr = new ScreenWakeLockManager(
			createDeps({ isEnabled: () => false }).deps,
		);

		mgr.setActive(true);
		await flush();

		expect(wakeLockRequest).not.toHaveBeenCalled();
		expect(heldSentinel(mgr)).toBeNull();
	});

	it("does not acquire while the document is hidden", async () => {
		const { sentinel } = makeSentinel();
		wakeLockRequest.mockResolvedValue(sentinel);
		documentStub.visibilityState = "hidden";
		const mgr = new ScreenWakeLockManager(createDeps().deps);

		mgr.setActive(true);
		await flush();

		expect(wakeLockRequest).not.toHaveBeenCalled();
		expect(heldSentinel(mgr)).toBeNull();
	});

	it("never throws and logs when the request is rejected", async () => {
		wakeLockRequest.mockRejectedValue(new Error("not allowed"));
		const { deps, logger } = createDeps();
		const mgr = new ScreenWakeLockManager(deps);

		mgr.setActive(true);
		await flush();

		expect(heldSentinel(mgr)).toBeNull();
		expect(logger.warn).toHaveBeenCalled();
	});

	it("is idempotent: a second activation does not request a second lock", async () => {
		const { sentinel } = makeSentinel();
		wakeLockRequest.mockResolvedValue(sentinel);
		const mgr = new ScreenWakeLockManager(createDeps().deps);

		mgr.setActive(true);
		await flush();
		mgr.setActive(true);
		await flush();

		expect(wakeLockRequest).toHaveBeenCalledTimes(1);
	});

	it("drops its reference when the OS auto-releases the lock", async () => {
		const { sentinel, fireAutoRelease } = makeSentinel();
		wakeLockRequest.mockResolvedValue(sentinel);
		const mgr = new ScreenWakeLockManager(createDeps().deps);

		mgr.setActive(true);
		await flush();
		expect(heldSentinel(mgr)).toBe(sentinel);

		fireAutoRelease();

		expect(heldSentinel(mgr)).toBeNull();
	});

	it("re-acquires after the document goes hidden then visible again", async () => {
		const first = makeSentinel();
		wakeLockRequest.mockResolvedValue(first.sentinel);
		const mgr = new ScreenWakeLockManager(createDeps().deps);

		mgr.setActive(true);
		await flush();

		// Document becomes hidden: the OS auto-releases the lock, and the
		// visibility handler must NOT re-acquire while hidden.
		first.fireAutoRelease();
		fireVisibility("hidden");
		await flush();
		expect(heldSentinel(mgr)).toBeNull();
		expect(wakeLockRequest).toHaveBeenCalledTimes(1);

		// Back to visible while the sync is still active: re-acquire.
		const second = makeSentinel();
		wakeLockRequest.mockResolvedValue(second.sentinel);
		fireVisibility("visible");
		await flush();

		expect(wakeLockRequest).toHaveBeenCalledTimes(2);
		expect(heldSentinel(mgr)).toBe(second.sentinel);
	});

	it("does not request a second lock when visibility fires mid-acquire", async () => {
		const { sentinel, release } = makeSentinel();
		let resolveRequest!: (s: WakeLockSentinel) => void;
		wakeLockRequest.mockReturnValue(
			new Promise<WakeLockSentinel>((res) => {
				resolveRequest = res;
			}),
		);
		const mgr = new ScreenWakeLockManager(createDeps().deps);

		mgr.setActive(true); // acquire #A is awaiting request()
		fireVisibility("visible"); // onVisible() must not start a second request
		resolveRequest(sentinel);
		await flush();

		expect(wakeLockRequest).toHaveBeenCalledTimes(1);
		expect(heldSentinel(mgr)).toBe(sentinel);
		expect(release).not.toHaveBeenCalled();
	});

	it("releases an in-flight lock that resolves after cleanup (no leak past unload)", async () => {
		const { sentinel, release } = makeSentinel();
		let resolveRequest!: (s: WakeLockSentinel) => void;
		wakeLockRequest.mockReturnValue(
			new Promise<WakeLockSentinel>((res) => {
				resolveRequest = res;
			}),
		);
		const { deps, cleanups } = createDeps();
		const mgr = new ScreenWakeLockManager(deps);

		mgr.setActive(true); // acquire is awaiting request()
		for (const cb of cleanups) cb(); // plugin unload while in flight
		resolveRequest(sentinel);
		await flush();

		expect(release).toHaveBeenCalledTimes(1);
		expect(heldSentinel(mgr)).toBeNull();
	});

	it("releases a lock acquired after a same-tick deactivation (no leak)", async () => {
		const { sentinel, release } = makeSentinel();
		let resolveRequest!: (s: WakeLockSentinel) => void;
		wakeLockRequest.mockReturnValue(
			new Promise<WakeLockSentinel>((res) => {
				resolveRequest = res;
			}),
		);
		const mgr = new ScreenWakeLockManager(createDeps().deps);

		mgr.setActive(true); // acquire() is awaiting the request
		mgr.setActive(false); // deactivated before the lock resolves
		resolveRequest(sentinel);
		await flush();

		expect(release).toHaveBeenCalledTimes(1);
		expect(heldSentinel(mgr)).toBeNull();
	});

	it("on cleanup removes the visibility listener and releases the lock", async () => {
		const { sentinel, release } = makeSentinel();
		wakeLockRequest.mockResolvedValue(sentinel);
		const { deps, cleanups } = createDeps();
		const mgr = new ScreenWakeLockManager(deps);

		mgr.setActive(true);
		await flush();
		expect(documentListeners.has("visibilitychange")).toBe(true);

		for (const cb of cleanups) cb();
		await flush();

		expect(documentListeners.has("visibilitychange")).toBe(false);
		expect(release).toHaveBeenCalledTimes(1);
	});
});
