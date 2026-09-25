import type { BackendAuthHost } from "../../backend-api";

/**
 * Raised when a pending authorization is cancelled (connection teardown or a
 * reconnect that supersedes it). Distinct from a user denial so core can tell the
 * two apart.
 */
export class AuthCancelledError extends Error {
	constructor(message = "Authorization was cancelled") {
		super(message);
		this.name = "AuthCancelledError";
	}
}

/** Opens an external authorization URL. Injected so core supplies the platform. */
export type ExternalUrlOpener = (url: string) => void;

export interface AuthHostOptions {
	/** Connection generation this host is bound to. */
	readonly generation: number;
	/** Whether `generation` is still the live connection generation. */
	readonly isCurrentGeneration: (generation: number) => boolean;
	/** Platform opener; defaults to a mobile-safe `window.open`. */
	readonly openUrl?: ExternalUrlOpener;
}

/**
 * The core half of the auth boundary: a per-connection `BackendAuthHost` plus the
 * generation cancel gate core calls on teardown. The callback itself is delivered
 * through core's protocol handler into `auth.complete`; there is no module-facing
 * one-shot await surface.
 */
export interface BackendAuthHostController extends BackendAuthHost {
	readonly generation: number;
	/** Reject any later auth action on this (now stale) connection; idempotent. */
	cancelAll(): void;
}

function defaultOpenUrl(url: string): void {
	window.open(url, "_blank", "noopener");
}

/**
 * Build the concrete auth host for one connection generation. `openExternal`
 * refuses to open once the connection is stale or cancelled.
 */
export function createAuthHost(options: AuthHostOptions): BackendAuthHostController {
	const openUrl = options.openUrl ?? defaultOpenUrl;
	let cancelled = false;

	const isLive = (): boolean =>
		!cancelled && options.isCurrentGeneration(options.generation);

	return {
		generation: options.generation,
		openExternal: (url: string): Promise<void> => {
			if (!isLive()) return Promise.reject(new AuthCancelledError());
			openUrl(url);
			return Promise.resolve();
		},
		cancelAll: () => {
			cancelled = true;
		},
	};
}
