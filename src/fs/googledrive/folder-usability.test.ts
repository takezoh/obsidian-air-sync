import { describe, it, expect, vi } from "vitest";
import {
	classifyFetchedGoogleDriveFolder,
	inspectGoogleDriveFolder,
} from "./folder-usability";
import { FOLDER_MIME, isGoogleDriveTrashed } from "./types";
import type { GoogleDriveFile } from "./types";
import type { GoogleDriveClient } from "./client";

vi.mock("obsidian");

function folder(overrides: Partial<GoogleDriveFile> & { id: string; name: string }): GoogleDriveFile {
	return { mimeType: FOLDER_MIME, ...overrides };
}

function createMockClient(getFile: ReturnType<typeof vi.fn>): GoogleDriveClient {
	return { getFile } as unknown as GoogleDriveClient;
}

describe("isGoogleDriveTrashed", () => {
	it("is true only for Drive's explicit trashed flag", () => {
		expect(isGoogleDriveTrashed(folder({ id: "a", name: "A", trashed: true }))).toBe(true);
		expect(isGoogleDriveTrashed(folder({ id: "a", name: "A", trashed: false }))).toBe(false);
		expect(isGoogleDriveTrashed(folder({ id: "a", name: "A" }))).toBe(false);
		expect(isGoogleDriveTrashed(undefined)).toBe(false);
	});
});

describe("classifyFetchedGoogleDriveFolder", () => {
	it("accepts a live folder", () => {
		const file = folder({ id: "FID", name: "My Vault" });
		expect(classifyFetchedGoogleDriveFolder(file)).toEqual({ usable: true, file });
	});

	it("classifies a non-folder item", () => {
		expect(
			classifyFetchedGoogleDriveFolder({ id: "FID", name: "note.pdf", mimeType: "application/pdf" }),
		).toEqual({ usable: false, problem: "not_folder" });
	});

	it("classifies a trashed folder", () => {
		expect(classifyFetchedGoogleDriveFolder(folder({ id: "FID", name: "My Vault", trashed: true }))).toEqual({
			usable: false,
			problem: "trashed",
		});
	});
});

describe("inspectGoogleDriveFolder", () => {
	it("returns the file when it is a live folder", async () => {
		const file = folder({ id: "FID", name: "My Vault" });
		const client = createMockClient(vi.fn().mockResolvedValue(file));

		await expect(inspectGoogleDriveFolder(client, "FID")).resolves.toEqual({ usable: true, file });
	});

	it("classifies a 404 as not_found and keeps the original error", async () => {
		const cause = Object.assign(new Error("Not Found"), { status: 404 });
		const client = createMockClient(vi.fn().mockRejectedValue(cause));

		await expect(inspectGoogleDriveFolder(client, "gone")).resolves.toEqual({
			usable: false,
			problem: "not_found",
			cause,
		});
	});

	it("classifies a genuine 403 permission failure as inaccessible", async () => {
		const cause = Object.assign(new Error("Forbidden"), { status: 403 });
		const client = createMockClient(vi.fn().mockRejectedValue(cause));

		await expect(inspectGoogleDriveFolder(client, "denied")).resolves.toEqual({
			usable: false,
			problem: "inaccessible",
			cause,
		});
	});

	it("rethrows a 403 that is actually a rate limit so retry policy still sees it", async () => {
		const cause = Object.assign(new Error("Rate Limit Exceeded"), {
			status: 403,
			json: { error: { errors: [{ reason: "rateLimitExceeded" }] } },
		});
		const client = createMockClient(vi.fn().mockRejectedValue(cause));

		await expect(inspectGoogleDriveFolder(client, "FID")).rejects.toBe(cause);
	});

	it("classifies a non-folder item as not_folder", async () => {
		const client = createMockClient(
			vi.fn().mockResolvedValue({ id: "FID", name: "note.pdf", mimeType: "application/pdf" }),
		);

		await expect(inspectGoogleDriveFolder(client, "FID")).resolves.toEqual({
			usable: false,
			problem: "not_folder",
		});
	});

	it("classifies a trashed folder as trashed", async () => {
		const client = createMockClient(
			vi.fn().mockResolvedValue(folder({ id: "FID", name: "My Vault", trashed: true })),
		);

		await expect(inspectGoogleDriveFolder(client, "FID")).resolves.toEqual({
			usable: false,
			problem: "trashed",
		});
	});

	it("rethrows other failures unchanged so their classification is preserved", async () => {
		const serverError = Object.assign(new Error("server down"), { status: 500 });
		const client = createMockClient(vi.fn().mockRejectedValue(serverError));

		await expect(inspectGoogleDriveFolder(client, "FID")).rejects.toBe(serverError);
	});
});
