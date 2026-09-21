import { FOLDER_MIME } from "../../src/backends/googledrive/types";

export const PRODUCTION_WORKER_ORIGIN = "https://auth-airsync.takezo.dev";
export const OBSIDIAN_CALLBACK_ORIGIN = "obsidian://air-sync-auth";

export type PickerStage =
	| "preflight"
	| "browser-launch"
	| "google-authorization"
	| "worker-callback"
	| "external-navigation"
	| "callback-envelope"
	| "drive-folder"
	| "cleanup";

export class PickerE2EError extends Error {
	constructor(
		readonly errorClass: string,
		readonly stage: PickerStage,
	) {
		super(`[google-picker-e2e:${stage}:${errorClass}]`);
		this.name = "PickerE2EError";
	}
}

export interface NavigationEvidence {
	sequence: number;
	targetId: string;
	sessionId: string;
	frameId: string;
	loaderId?: string;
	url: string;
	source: "Page.frameRequestedNavigation" | "Network.requestWillBeSent";
}

export interface PickerCallbackEnvelope {
	accessToken: string;
	expiresIn: number;
	pickedFileId: string;
	state: string;
}

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateAuthorizationUrl(rawUrl: string, expectedState: string): void {
	const url = new URL(rawUrl);
	const params = url.searchParams;
	if (
		url.origin !== "https://accounts.google.com" ||
		url.pathname !== "/o/oauth2/v2/auth" ||
		params.get("trigger_onepick") !== "true" ||
		params.get("allow_folder_selection") !== "true" ||
		params.get("mimetypes") !== FOLDER_MIME ||
		params.get("scope") !== "https://www.googleapis.com/auth/drive.file" ||
		params.get("prompt") !== "consent" ||
		params.get("state") !== expectedState
	) {
		throw new PickerE2EError("authorization-contract", "google-authorization");
	}
}

export function selectOrderedExternalNavigation(events: readonly NavigationEvidence[]): NavigationEvidence {
	const workers = events.filter((event) => {
		try {
			return new URL(event.url).origin === PRODUCTION_WORKER_ORIGIN;
		} catch {
			return false;
		}
	});
	for (const worker of workers) {
		const external = events.find((event) =>
			event.sequence > worker.sequence &&
			event.targetId === worker.targetId &&
			event.sessionId === worker.sessionId &&
			event.frameId === worker.frameId &&
			(!worker.loaderId || !event.loaderId || event.loaderId === worker.loaderId) &&
			event.url.startsWith(`${OBSIDIAN_CALLBACK_ORIGIN}?`),
		);
		if (external) return external;
	}
	throw new PickerE2EError("ordered-external-navigation-missing", "external-navigation");
}

export function parseCallbackEnvelope(attemptedUrl: string, expectedState: string): PickerCallbackEnvelope {
	let url: URL;
	try {
		url = new URL(attemptedUrl);
	} catch {
		throw new PickerE2EError("callback-url-invalid", "callback-envelope");
	}
	if (url.protocol !== "obsidian:" || url.hostname !== "air-sync-auth" || url.pathname !== "") {
		throw new PickerE2EError("callback-route-invalid", "callback-envelope");
	}
	const ids = url.searchParams.getAll("picked_file_ids");
	const state = url.searchParams.get("state");
	const accessToken = url.searchParams.get("access_token");
	const expiresRaw = url.searchParams.get("expires_in");
	const expiresIn = expiresRaw === null ? Number.NaN : Number(expiresRaw);
	if (state !== expectedState) throw new PickerE2EError("callback-state-invalid", "callback-envelope");
	if (ids.length !== 1 || !FILE_ID_PATTERN.test(ids[0] ?? "")) {
		throw new PickerE2EError("callback-folder-id-invalid", "callback-envelope");
	}
	if (!accessToken) throw new PickerE2EError("callback-token-missing", "callback-envelope");
	if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new PickerE2EError("callback-expiry-invalid", "callback-envelope");
	}
	return { accessToken, expiresIn, pickedFileId: ids[0]!, state };
}

export function safeFailure(error: unknown): string {
	if (error instanceof PickerE2EError) return error.message;
	return "[google-picker-e2e:internal:unexpected]";
}

export function assertNoSecrets(output: string, secrets: readonly string[]): void {
	for (const secret of secrets) {
		const forms = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
		if (forms.some((form) => form.length > 0 && output.includes(form))) {
			throw new PickerE2EError("secret-disclosure", "cleanup");
		}
	}
}
