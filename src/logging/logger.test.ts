import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger, getDeviceName } from "./logger";
import type { RawFsAdapter } from "../fs/raw-fs";
import type { AirSyncSettings } from "../settings";
import { DEFAULT_SETTINGS } from "../settings";

function createMockAdapter(): RawFsAdapter & {
	written: Map<string, string>;
	dirs: Set<string>;
} {
	const written = new Map<string, string>();
	const dirs = new Set<string>();
	return {
		written,
		dirs,
		exists: vi.fn((path: string) => Promise.resolve(written.has(path) || dirs.has(path))),
		read: vi.fn((path: string) => Promise.resolve(written.get(path) ?? "")),
		write: vi.fn((path: string, data: string) => {
			written.set(path, data);
			return Promise.resolve();
		}),
		mkdir: vi.fn((path: string) => {
			dirs.add(path);
			return Promise.resolve();
		}),
	};
}

function createSettings(overrides: Partial<AirSyncSettings> = {}): AirSyncSettings {
	return { ...DEFAULT_SETTINGS, enableLogging: true, ...overrides };
}

/** Let queued microtasks (the auto-flush chain and its adapter awaits) run out. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe("Logger", () => {
	let adapter: ReturnType<typeof createMockAdapter>;
	let settings: AirSyncSettings;
	let logger: Logger;

	beforeEach(() => {
		adapter = createMockAdapter();
		settings = createSettings();
		logger = new Logger(adapter, () => settings, "desktop");
	});

	it("writes buffered log lines on flush", async () => {
		logger.info("test message");
		logger.warn("another message");
		await logger.flush();

		const files = Array.from(adapter.written.keys());
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^\.airsync\/logs\/desktop\/\d{4}-\d{2}-\d{2}\.log$/);

		const content = adapter.written.get(files[0] ?? "")!;
		expect(content).toContain("[INFO] test message");
		expect(content).toContain("[WARN] another message");
	});

	it("includes context as JSON", async () => {
		logger.error("fail", { status: 401 });
		await logger.flush();

		const content = Array.from(adapter.written.values())[0];
		expect(content).toContain('[ERROR] fail {"status":401}');
	});

	it("uses provided device name for log directory", async () => {
		logger = new Logger(adapter, () => settings, "My iPhone");
		logger.info("mobile log");
		await logger.flush();

		const files = Array.from(adapter.written.keys());
		expect(files[0]).toContain(".airsync/logs/my-iphone/");
	});

	it("sanitizes unsafe characters in device name", async () => {
		logger = new Logger(adapter, () => settings, "PC/Work:Station\\1");
		logger.info("test");
		await logger.flush();

		const files = Array.from(adapter.written.keys());
		expect(files[0]).toContain(".airsync/logs/pc-work-station-1/");
	});

	it("falls back to 'unknown' for empty device name", async () => {
		logger = new Logger(adapter, () => settings, "");
		logger.info("test");
		await logger.flush();

		const files = Array.from(adapter.written.keys());
		expect(files[0]).toContain(".airsync/logs/unknown/");
	});

	it("filters logs below configured level", async () => {
		settings.logLevel = "warn";

		logger.debug("should be skipped");
		logger.info("also skipped");
		logger.warn("included");
		logger.error("also included");
		await logger.flush();

		const content = Array.from(adapter.written.values())[0];
		expect(content).not.toContain("[DEBUG]");
		expect(content).not.toContain("[INFO]");
		expect(content).toContain("[WARN] included");
		expect(content).toContain("[ERROR] also included");
	});

	it("is a no-op when logging is disabled", async () => {
		settings.enableLogging = false;

		logger.info("should not appear");
		logger.error("also not");
		await logger.flush();

		expect(adapter.written.size).toBe(0);
	});

	it("writes an error line without an explicit flush() call", async () => {
		// Errors own their durability: a pre-sync-cycle failure (connect/auth/
		// folder-pick) has no cycle-end or unload flush to rely on, so requiring
		// every call site to remember flush() is how #82 lost lines silently.
		logger.error("must be durable");

		await drainMicrotasks();

		const files = Array.from(adapter.written.keys());
		expect(files).toHaveLength(1);
		expect(adapter.written.get(files[0] ?? "")).toContain("[ERROR] must be durable");
	});

	it("coalesces a synchronous burst of errors into a single flush", async () => {
		const writeSpy = vi.fn((path: string, data: string) => {
			adapter.written.set(path, data);
			return Promise.resolve();
		});
		adapter.write = writeSpy;
		logger.error("first error");
		logger.error("second error");
		logger.error("third error");

		await drainMicrotasks();

		expect(writeSpy).toHaveBeenCalledTimes(1);
		const content = Array.from(adapter.written.values())[0] ?? "";
		expect(content).toContain("[ERROR] first error");
		expect(content).toContain("[ERROR] second error");
		expect(content).toContain("[ERROR] third error");
	});

	it("does not auto-flush non-error levels", async () => {
		logger.debug("d");
		logger.info("i");
		logger.warn("w");

		await drainMicrotasks();

		expect(adapter.written.size).toBe(0);
	});

	it("mirrors a flush failure to console instead of swallowing it silently", async () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		adapter.write = vi.fn(() => Promise.reject(new Error("disk full")));

		logger.info("test");
		await logger.flush();

		expect(consoleSpy).toHaveBeenCalledWith(
			"Air Sync: failed to flush logs to .airsync/logs/",
			expect.any(Error),
		);
		consoleSpy.mockRestore();
	});

	it("serializes concurrent flush() calls instead of racing on the log file", async () => {
		// Without serialization, two overlapping flush() calls each read the same
		// on-disk content before either writes back, and whichever writes last
		// silently clobbers the other's lines. Control write() completion order
		// directly to prove flush() #2 never even starts its own write until
		// flush() #1's finishes -- not just that the end result happens to look right.
		const pendingWrites: { resolve: () => void }[] = [];
		adapter.write = vi.fn((path: string, data: string) => new Promise<void>((resolve) => {
			pendingWrites.push({
				resolve: () => { adapter.written.set(path, data); resolve(); },
			});
		}));

		const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

		logger.info("first");
		const flush1 = logger.flush();
		await tick();

		logger.info("second");
		const flush2 = logger.flush();
		await tick();

		// flush() #2 must still be blocked on the mutex -- it hasn't reached
		// write() at all yet, since flush() #1 hasn't released the lock.
		expect(pendingWrites).toHaveLength(1);

		pendingWrites[0]!.resolve();
		await flush1;
		await tick();

		expect(pendingWrites).toHaveLength(2);
		pendingWrites[1]!.resolve();
		await flush2;

		const content = Array.from(adapter.written.values())[0];
		expect(content).toContain("[INFO] first");
		expect(content).toContain("[INFO] second");
	});

	it("appends to existing log file", async () => {
		logger.info("first");
		await logger.flush();

		logger.info("second");
		await logger.flush();

		const content = Array.from(adapter.written.values())[0];
		expect(content).toContain("[INFO] first");
		expect(content).toContain("[INFO] second");
	});

	it("creates directories if they do not exist", async () => {
		logger.info("test");
		await logger.flush();

		expect(adapter.dirs.has(".airsync")).toBe(true);
		expect(adapter.dirs.has(".airsync/logs")).toBe(true);
		expect(adapter.dirs.has(".airsync/logs/desktop")).toBe(true);
	});

	it("getDeviceName returns '{device}-{vaultId}' when vaultId is provided", () => {
		expect(getDeviceName(true, "abc123")).toBe("mobile-abc123");
		expect(getDeviceName(false, "xyz789")).toBe("desktop-xyz789");
	});

	it("getDeviceName returns device only when no vaultId", () => {
		expect(getDeviceName(true)).toBe("mobile");
		expect(getDeviceName(false)).toBe("desktop");
	});

	it("formats timestamp in ISO format", async () => {
		logger.info("timestamped");
		await logger.flush();

		const content = Array.from(adapter.written.values())[0];
		// Match ISO timestamp pattern: [YYYY-MM-DDTHH:MM:SS.mmmZ]
		expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
	});

	describe("enabled()", () => {
		it("answers the same question log() does, for every level", async () => {
			settings = createSettings({ logLevel: "warn" });
			for (const level of ["debug", "info", "warn", "error"] as const) {
				logger[level](`${level} message`);
			}
			await logger.flush();
			const content = Array.from(adapter.written.values())[0] ?? "";

			// enabled() exists so a caller can skip building an expensive payload.
			// If it ever disagreed with log(), such a caller would silently drop a
			// line that logging is on for, so pin them to each other rather than to
			// a hand-written expectation.
			for (const level of ["debug", "info", "warn", "error"] as const) {
				expect(logger.enabled(level)).toBe(content.includes(`${level} message`));
			}
		});

		it("is false for every level when logging is disabled", () => {
			settings = createSettings({ enableLogging: false, logLevel: "debug" });
			for (const level of ["debug", "info", "warn", "error"] as const) {
				expect(logger.enabled(level)).toBe(false);
			}
		});

		it("re-reads settings rather than caching the first answer", () => {
			settings = createSettings({ logLevel: "debug" });
			expect(logger.enabled("debug")).toBe(true);
			settings = createSettings({ logLevel: "error" });
			expect(logger.enabled("debug")).toBe(false);
		});
	});
});
