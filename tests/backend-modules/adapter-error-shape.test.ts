import { describe, expect, it } from "vitest";
import { backendError, isBackendErrorShape } from "../../src/backend-api";
import { AuthError, decideRetry } from "../../src/backend-api/error-classification";
import { classifyBackendError } from "../../src/fs/modules/error-bridge";
import { toBackendError, backendErrorFromStatus } from "../../src/backends/shared/error-shape";
import { translateGoogleDriveError } from "../../src/backends/googledrive/adapter";
import { translateOneDriveError } from "../../src/backends/onedrive/adapter";
import { translateDropboxError } from "../../src/backends/dropbox/adapter";
import { GraphApiError } from "../../src/backends/onedrive/types";
import { DropboxApiError } from "../../src/backends/dropbox/types";

const retryAfter = { "Retry-After": "7" };

describe("toBackendError", () => {
	it("preserves AuthError identity so the cycle aborts", () => {
		const error = toBackendError(backendError("auth", "credentials expired"));
		expect(error).toBeInstanceOf(AuthError);
		expect(isBackendErrorShape(error)).toBe(true);
	});

	it("leaves a non-auth shape a plain Error that core can still recognize", () => {
		const error = toBackendError(backendError("permanent", "bad response", { permanentCode: "x" }));
		expect(error).not.toBeInstanceOf(AuthError);
		expect(isBackendErrorShape(error)).toBe(true);
	});
});

describe("adapter Retry-After translation", () => {
	it("Google 429 carries retryAfterMs", () => {
		const shape = translateGoogleDriveError(
			Object.assign(new Error("rate limited"), { status: 429, headers: retryAfter }),
		);
		expect(shape).toMatchObject({ kind: "rate_limit", retryAfterMs: 7000 });
	});

	it("Google 503 carries retryAfterMs through transient", () => {
		const shape = translateGoogleDriveError(
			Object.assign(new Error("unavailable"), { status: 503, headers: retryAfter }),
		);
		expect(shape).toMatchObject({ kind: "transient", retryAfterMs: 7000 });
	});

	it("OneDrive 429 carries retryAfterMs", () => {
		const shape = translateOneDriveError(new GraphApiError("throttled", 429, "", retryAfter));
		expect(shape).toMatchObject({ kind: "rate_limit", retryAfterMs: 7000 });
	});

	it("Dropbox 429 carries retryAfterMs", () => {
		const shape = translateDropboxError(
			new DropboxApiError("locked", 429, "too_many_write_operations", retryAfter),
		);
		expect(shape).toMatchObject({ kind: "rate_limit", retryAfterMs: 7000 });
	});

	it("decideRetry honors the carried retryAfterMs", () => {
		const shape = translateGoogleDriveError(
			Object.assign(new Error("rate limited"), { status: 429, headers: retryAfter }),
		);
		expect(decideRetry({ kind: "rateLimit", retryAfterMs: shape.retryAfterMs }, 1, 3, () => 0.5))
			.toEqual({ action: "retry", delayMs: 7000 });
	});
});

describe("adapter auth translation", () => {
	// `oauth-pkce` throws `new AuthError("Token refresh failed: …", 400)` when the
	// refresh token is rejected. Google's adapter must not let the bare 400 status
	// (which `backendErrorFromStatus` maps to `permanent`) hide the auth identity.
	const EXPIRED_REFRESH = () => new AuthError("Token refresh failed: invalid_grant", 400);

	it("classifies an expired Google refresh token as auth, not permanent", () => {
		expect(translateGoogleDriveError(EXPIRED_REFRESH())).toMatchObject({ kind: "auth" });
	});

	it("keeps AuthError identity through the adapter boundary so the cycle aborts", () => {
		const error = toBackendError(translateGoogleDriveError(EXPIRED_REFRESH()));
		expect(error).toBeInstanceOf(AuthError);
	});

	it("drives an abort (not a retry) for an expired Google refresh token", () => {
		const classification = classifyBackendError(translateGoogleDriveError(EXPIRED_REFRESH()));
		expect(classification).toEqual({ kind: "auth" });
		if (!classification) return;
		expect(decideRetry(classification, 1, 3, () => 0.5)).toEqual({ action: "abort", kind: "auth" });
	});
});

describe("adapter permanent-protocol translation", () => {
	const MODULE_PERMANENT = () => Object.assign(new Error("Resumable upload: no upload URL in response (status 200)"), {
		status: 200,
		permanent: true,
		permanentCode: "googledrive.resumable_upload.missing_location",
	});

	it("preserves a module-thrown permanentCode through the Google translate step", () => {
		// Without the permanent-flag branch, a 200 init status would be mapped by
		// `backendErrorFromStatus` and the stable code would be dropped.
		expect(translateGoogleDriveError(MODULE_PERMANENT())).toMatchObject({
			kind: "permanent",
			permanentCode: "googledrive.resumable_upload.missing_location",
		});
	});

	it("preserves an uncoded permanent flag without inventing a code", () => {
		const shape = translateGoogleDriveError(Object.assign(new Error("bad"), { permanent: true }));
		expect(shape).toEqual({ kind: "permanent", message: "bad" });
	});

	it("classifies a module-thrown coded permanent exactly like an HTTP-derived permanent", () => {
		const moduleClassification = classifyBackendError(translateGoogleDriveError(MODULE_PERMANENT()));
		// The adapter's status-derived permanent: a non-5xx/0 status maps to `permanent`.
		const httpClassification = classifyBackendError(backendErrorFromStatus(400, "bad request"));

		expect(moduleClassification).toEqual({
			kind: "permanent",
			permanentCode: "googledrive.resumable_upload.missing_location",
		});
		expect(httpClassification).toEqual({ kind: "permanent" });
		expect(moduleClassification).not.toBeNull();
		if (!moduleClassification || !httpClassification) return;
		// Both are non-retryable under the one shared policy.
		expect(decideRetry(moduleClassification, 1, 3, () => 0.5)).toEqual({ action: "stop" });
		expect(decideRetry(httpClassification, 1, 3, () => 0.5)).toEqual({ action: "stop" });
	});
});
