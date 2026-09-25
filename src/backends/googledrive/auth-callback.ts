/**
 * Parse auth callback input (URL from auth server containing tokens or code).
 * Built-in flow: obsidian://air-sync-auth?access_token=...&refresh_token=...&expires_in=...&state=...
 * Custom flow: obsidian://air-sync-auth?code=...&state=...
 *
 * Pure string parsing: it carries no Obsidian/UI dependency so a backend module
 * can complete an auth callback without reaching the host.
 */
export function parseAuthCallbackParams(input: string): Record<string, string | undefined> {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Auth callback is empty");
	}

	try {
		const url = new URL(trimmed);
		const accessToken = url.searchParams.get("access_token");
		const code = url.searchParams.get("code");
		if (!accessToken && !code) {
			throw new Error("Missing access_token or code in auth callback");
		}
		const result: Record<string, string | undefined> = {
			state: url.searchParams.get("state") ?? undefined,
		};
		if (accessToken) {
			result.access_token = accessToken;
			result.refresh_token = url.searchParams.get("refresh_token") ?? undefined;
			result.expires_in = url.searchParams.get("expires_in") ?? "3600";
		}
		if (code) {
			result.code = code;
		}
		return result;
	} catch (e) {
		if (e instanceof Error && (e.message.includes("access_token") || e.message.includes("code"))) {
			throw e;
		}
		throw new Error("Invalid auth callback URL");
	}
}
