import type { Logger } from "../logging/logger";

/**
 * Lossless logging of an irregular (non-2xx) backend response.
 *
 * Why this exists: each backend's `assertOk` used to distil a failure down to a
 * short thrown message and nothing else — no log line at all. When a backend
 * reports something the plugin has no branch for, that distillation is exactly
 * what destroys the evidence. The live case: Microsoft Graph answered every App
 * Folder call with `403 accessDenied` whose *inner* code was `serviceReadOnly` (a
 * service-side incident). The plugin surfaced `403 accessDenied` and dropped the
 * rest, so the cause was invisible for days; another OneDrive client identified it
 * immediately because its log carried the whole error body.
 *
 * So: log the ENTIRE body (and the response headers) verbatim before throwing, and
 * make any truncation explicit rather than silent.
 */

/**
 * Response shape shared by every backend's `requestUrl({ throw: false })` result.
 * `status` is optional because some call sites (a rejected request whose status the
 * caller already put in the message, an OAuth helper) only hold the body.
 */
interface BackendErrorResponse {
	status?: number;
	json?: unknown;
	text?: string;
	headers?: Record<string, string>;
}

/**
 * Cap for a single logged body. Generous — an error body is small, and the point of
 * this module is to keep evidence — but bounded so a backend that answers an error
 * with a whole HTML page (a captive portal, a proxy block page) cannot flood the log.
 */
export const MAX_LOGGED_BODY_CHARS = 8000;

/**
 * Cap for the body embedded in a thrown error's message. Shorter than the log cap
 * because that message reaches a Notice, and the log already holds the full body.
 */
export const MAX_MESSAGE_BODY_CHARS = 600;

/** Response headers that are never useful here and may carry session state. */
const SKIPPED_HEADERS = new Set(["set-cookie"]);

/**
 * Render the response body as a string without losing structure: JSON is serialized
 * whole (nested `innerError` included), a non-JSON body falls back to its raw text.
 * Truncation is announced inline so a reader can never mistake a clipped body for a
 * complete one.
 */
export function describeErrorBody(res: BackendErrorResponse, maxChars = MAX_LOGGED_BODY_CHARS): string {
	let rendered: string;
	try {
		rendered = res.json === undefined || res.json === null ? "" : JSON.stringify(res.json);
	} catch {
		// A body that cannot be serialized (cycles, exotic values) must still leave a trace.
		rendered = "";
	}
	if (!rendered) rendered = typeof res.text === "string" ? res.text : "";
	if (!rendered) return "(empty body)";
	return rendered.length > maxChars
		? `${rendered.slice(0, maxChars)}…[truncated ${rendered.length - maxChars} more chars]`
		: rendered;
}

/** Response headers, minus the ones deliberately skipped. Absent headers ⇒ undefined. */
function describeHeaders(res: BackendErrorResponse): Record<string, string> | undefined {
	if (!res.headers) return undefined;
	const kept: Record<string, string> = {};
	for (const [key, value] of Object.entries(res.headers)) {
		if (!SKIPPED_HEADERS.has(key.toLowerCase())) kept[key] = value;
	}
	return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * Log one irregular backend response in full, at `error` level. Called by each
 * backend's `assertOk` BEFORE it throws, so the evidence survives regardless of how
 * the thrown error is later classified, retried, or swallowed by a caller.
 *
 * Never pass a token-endpoint response here: those bodies carry access/refresh
 * tokens. Only API responses (which do not) belong in the log.
 */
export function logBackendErrorResponse(
	logger: Logger | undefined,
	backend: string,
	operation: string,
	res: BackendErrorResponse,
): void {
	logger?.error(`${backend} API returned an error response`, {
		operation,
		status: res.status,
		body: describeErrorBody(res),
		headers: describeHeaders(res),
	});
}
