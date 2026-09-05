/** Bounded, channel-neutral OAuth denial projected from an untrusted callback. */
export interface OAuthCallbackError {
	code: string;
	message: string;
}

const SAFE_ERROR_CODE = /^[A-Za-z0-9._~-]{1,64}$/;

/**
 * Project only the OAuth error code. Provider descriptions and URIs are never
 * accepted as diagnostic input because they can contain arbitrary text.
 */
export function projectOAuthCallbackError(error: unknown): OAuthCallbackError | null {
	if (typeof error !== "string" || !error) return null;
	if (error === "access_denied") {
		return { code: error, message: "Authorization was denied." };
	}
	const code = SAFE_ERROR_CODE.test(error) ? error : "invalid_error";
	return { code, message: `Authorization failed (${code}).` };
}

/** Correlate a projected denial to the one active authorization attempt. */
export function correlateOAuthCallbackError(
	params: Record<string, unknown>,
	pendingState: unknown,
): OAuthCallbackError | null {
	const projected = projectOAuthCallbackError(params.error);
	if (!projected) return null;
	if (typeof pendingState !== "string" || !pendingState || params.state !== pendingState) return null;
	return projected;
}

export interface OAuthProtocolEffects {
	notify(message: string): void;
	completeConnect(url: string): void;
	completeFolderPick(url: string, params: Record<string, string | undefined>): void;
}

function protocolParamsEntries(params: Record<string, string | undefined>): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	for (const key of Object.keys(params)) {
		const value = params[key];
		if (typeof value === "string") entries.push([key, value]);
	}
	return entries;
}

/** Apply the complete OAuth protocol-ingress policy before dispatching a callback. */
export function handleOAuthProtocolCallback(
	params: Record<string, string | undefined>,
	pendingState: unknown,
	effects: OAuthProtocolEffects,
): void {
	const callbackError = projectOAuthCallbackError(params.error);
	if (callbackError) {
		const correlated = correlateOAuthCallbackError(params, pendingState);
		if (correlated) effects.notify(correlated.message);
		return;
	}
	if (!params.access_token && !params.code) {
		effects.notify("Authorization failed: no token or code received");
		return;
	}
	const url = new URL("https://callback");
	for (const [key, value] of protocolParamsEntries(params)) {
		url.searchParams.set(key, value);
	}
	if (params.picked_file_ids) {
		effects.completeFolderPick(url.toString(), params);
	} else {
		effects.completeConnect(url.toString());
	}
}
