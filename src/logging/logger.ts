import type { AirSyncSettings } from "../settings";
import type { RawFsAdapter } from "../fs/raw-fs";
import { ensureDir } from "../fs/raw-fs";
import { AsyncMutex } from "../backend-api/async-queue";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/**
 * Sanitize a device name for use as a directory name.
 * Replaces characters that are unsafe in file paths with hyphens,
 * collapses runs, trims, lowercases, and falls back to "unknown".
 */
function sanitizeDeviceName(name: string): string {
	const sanitized = name
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return sanitized || "unknown";
}

/**
 * Detect a device name for the current platform.
 * Returns "{device}-{vaultId}" when a vaultId is provided so that
 * logs and conflict history are scoped per device AND per vault.
 */
export function getDeviceName(isMobile: boolean, vaultId?: string): string {
	const device = isMobile ? "mobile" : "desktop";
	return vaultId ? `${device}-${vaultId}` : device;
}

export class Logger {
	private buffer: string[] = [];
	private _deviceName: string;
	private _adapter: RawFsAdapter;
	private getSettings: () => AirSyncSettings;
	/**
	 * Serializes flush()'s read-modify-write against the log file. Logger is the
	 * sole writer of `.airsync/logs/...`, so this is the one place that has to hold
	 * the serialization: without it, two overlapping flush() calls each read the
	 * same on-disk content before either writes, and whichever writes last clobbers
	 * the other's lines — a lost update with no error, since a flush failure is
	 * caught (and, below, mirrored to console) rather than thrown.
	 */
	private flushMutex = new AsyncMutex();
	/**
	 * Whether an automatic post-error flush is already queued. Errors own their
	 * durability here rather than at each call site: a failure logged before any
	 * sync cycle runs (connect/auth/folder-pick) has no later flush to rely on, and
	 * every new pre-sync call site used to be able to forget one. Queuing through a
	 * microtask also coalesces a synchronous burst of error lines into one write.
	 */
	private autoFlushQueued = false;

	constructor(
		adapter: RawFsAdapter,
		getSettings: () => AirSyncSettings,
		deviceName: string,
	) {
		this._adapter = adapter;
		this.getSettings = getSettings;
		this._deviceName = sanitizeDeviceName(deviceName);
	}

	get adapter(): RawFsAdapter { return this._adapter; }
	get sanitizedDeviceName(): string { return this._deviceName; }

	/**
	 * Whether a log at this level would actually be written.
	 *
	 * `log()` decides this *after* the caller has already built its context
	 * object, so a diagnostic whose payload costs something — a per-path array,
	 * a set, a projection over every entry — pays that cost on every call even
	 * when logging is off. Such a caller guards itself with this instead. It is
	 * the same decision `log()` makes, read from the same settings, so the two
	 * cannot disagree.
	 */
	enabled(level: LogLevel): boolean {
		const settings = this.getSettings();
		if (!settings.enableLogging) return false;
		return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[settings.logLevel];
	}

	debug(message: string, context?: Record<string, unknown>): void {
		this.log("debug", message, context);
	}

	info(message: string, context?: Record<string, unknown>): void {
		this.log("info", message, context);
	}

	warn(message: string, context?: Record<string, unknown>): void {
		this.log("warn", message, context);
	}

	error(message: string, context?: Record<string, unknown>): void {
		this.log("error", message, context);
	}

	private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
		if (!this.enabled(level)) return;

		const timestamp = new Date().toISOString();
		const tag = level.toUpperCase();
		let line = `[${timestamp}] [${tag}] ${message}`;
		if (context) {
			line += ` ${JSON.stringify(context)}`;
		}
		this.buffer.push(line);

		// Mirror to developer console
		const consoleFn = level === "error" ? console.error
			: level === "warn" ? console.warn
			: console.debug;
		if (context) {
			consoleFn(`Air Sync: ${message}`, context);
		} else {
			consoleFn(`Air Sync: ${message}`);
		}

		// An error must not wait for a sync cycle that may never run to become
		// durable; see autoFlushQueued.
		if (level === "error") this.scheduleFlush();
	}

	/** Queue one automatic flush for the current microtask's worth of error lines. */
	private scheduleFlush(): void {
		if (this.autoFlushQueued) return;
		this.autoFlushQueued = true;
		void Promise.resolve().then(() => {
			this.autoFlushQueued = false;
			return this.flush();
		});
	}

	async flush(): Promise<void> {
		await this.flushMutex.run(async () => {
			if (this.buffer.length === 0) return;

			const lines = this.buffer;
			this.buffer = [];

			const date = new Date().toISOString().slice(0, 10);
			const logsDir = ".airsync/logs";
			const dir = `${logsDir}/${this._deviceName}`;
			const filePath = `${dir}/${date}.log`;

			try {
				await ensureDir(this._adapter, dir);

				let existing = "";
				if (await this._adapter.exists(filePath)) {
					existing = await this._adapter.read(filePath);
				}

				const content = existing + lines.join("\n") + "\n";
				await this._adapter.write(filePath, content);
			} catch (err) {
				// Logging must never break the app — but a completely silent failure
				// here means the one tool this project's own troubleshooting flow
				// depends on can go missing with no trace anywhere. Mirror it to
				// console like every other log line, instead of swallowing outright.
				console.error("Air Sync: failed to flush logs to .airsync/logs/", err);
			}
		});
	}
}
