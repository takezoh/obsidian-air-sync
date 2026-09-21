import type { RemoteBackendAdapter } from "../../backend-api";

/**
 * Attach a non-authoritative `readState` to an adapter. Core persists it into the
 * settings bag after a clean cycle (the legacy `readBackendState` seam), so a
 * refreshed `accessTokenExpiry` survives a reload instead of forcing one extra
 * token refresh. It carries no identity/cursor/sync truth.
 */
export function withAdapterState(
	adapter: RemoteBackendAdapter,
	readState: () => Readonly<Record<string, unknown>> | undefined,
): RemoteBackendAdapter {
	return Object.assign(adapter, { readState });
}
