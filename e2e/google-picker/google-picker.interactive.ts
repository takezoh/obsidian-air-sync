import { describe, expect, it } from "vitest";
import { GoogleAuth } from "../../src/fs/googledrive/auth";
import { GoogleDriveClient } from "../../src/fs/googledrive/client";
import { createPlatformTransport } from "../../src/fs/platform-http-transport";
import { FOLDER_MIME } from "../../src/fs/googledrive/types";
import { captureExternalNavigation } from "./chrome";
import { parseCallbackEnvelope, safeFailure, validateAuthorizationUrl, PickerE2EError } from "./oracle";
import { preflight } from "./preflight";

describe("built-in Google top-level folder Picker (interactive T3)", () => {
	it("observes the Worker external-protocol attempt and validates the selected live folder", async () => {
		try {
			process.stderr.write("[google-picker-e2e:preflight:started]\n");
			const runtime = await preflight();
			const auth = new GoogleAuth(createPlatformTransport());
			const authorizationUrl = await auth.getFolderPickerAuthorizationUrl();
			const expectedState = auth.getAuthState();
			if (!expectedState) throw new PickerE2EError("state-missing", "google-authorization");
			validateAuthorizationUrl(authorizationUrl, expectedState);
			process.stderr.write("[google-picker-e2e:google-authorization:waiting-for-human]\n");
			const externalNavigation = await captureExternalNavigation(runtime, authorizationUrl);
			const envelope = parseCallbackEnvelope(externalNavigation.url, expectedState);
			process.stderr.write("[google-picker-e2e:drive-folder:validating]\n");
			let file;
			try {
				const client = new GoogleDriveClient(() => Promise.resolve(envelope.accessToken), createPlatformTransport());
				file = await client.getFile(envelope.pickedFileId);
			} catch {
				throw new PickerE2EError("drive-request", "drive-folder");
			}
			if (file.id !== envelope.pickedFileId || file.mimeType !== FOLDER_MIME) {
				throw new PickerE2EError("drive-folder-invalid", "drive-folder");
			}
			expect(envelope.expiresIn).toBeGreaterThan(0);
			process.stderr.write("[google-picker-e2e:drive-folder:success]\n");
		} catch (error) {
			throw new Error(safeFailure(error));
		}
	}, 610_000);
});
