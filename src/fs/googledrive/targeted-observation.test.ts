import { describe, expect, it, vi } from "vitest";
import {
	runPriorityObservationContract,
	type PriorityObservationContractHarness,
	type PriorityObservationScenario,
} from "../priority-observation-contract";
import { GoogleDriveFs } from "./index";
import type { GoogleDriveClient } from "./client";
import type { GoogleDriveFile } from "./types";

const CONTENT = new Uint8Array([1, 2, 3]).buffer;

function file(overrides: Partial<GoogleDriveFile> = {}): GoogleDriveFile {
	return { id: "file-1", name: "note.md", mimeType: "application/octet-stream", parents: ["root"],
		size: "3", modifiedTime: "2026-08-27T00:00:00Z", md5Checksum: "abc", version: "2", ...overrides };
}

function makeGoogleDriveHarness(scenario: PriorityObservationScenario): PriorityObservationContractHarness {
	let current = file();
	const replacement = file({ id: "file-2", version: "3" });
	const missingError = Object.assign(new Error("gone"), { status: 404 });
	const getFile = vi.fn((id: string) => {
		if (scenario === "missing" || scenario === "replacement") return Promise.reject(missingError);
		return Promise.resolve(id === "file-1" ? current : replacement);
	});
	const listChildrenByName = vi.fn(() => {
		if (scenario === "missing") return Promise.resolve([]);
		if (scenario === "replacement") return Promise.resolve([replacement]);
		return Promise.resolve([current]);
	});
	if (scenario === "unverifiable") current = file({ version: undefined });
	const downloadFile = vi.fn(() => {
		if (scenario === "changed-during-read") current = file({ version: "3" });
		return Promise.resolve(CONTENT);
	});
	const fs = new GoogleDriveFs(
		{ getFile, listChildrenByName, downloadFile } as unknown as GoogleDriveClient,
		"root",
	);
	return {
		fs,
		request: { path: "note.md", identityKey: "file-1" },
		expectedToken: "googledrive:2",
		expectedContent: CONTENT,
		replacementIdentityKey: "file-2",
		assertCurrentReadCalls: () => {
			expect(listChildrenByName).toHaveBeenCalledWith("root", "note.md");
			expect(downloadFile).toHaveBeenCalledWith("file-1");
		},
	};
}

runPriorityObservationContract("GoogleDriveFs", makeGoogleDriveHarness);

describe("GoogleDriveFs detached priority observation", () => {
	it("fails closed when Drive returns duplicate occupants for one path", async () => {
		const replacement = file({ id: "file-2", version: "3" });
		const fs = new GoogleDriveFs({
			getFile: vi.fn(() => Promise.resolve(file())),
			listChildrenByName: vi.fn(() => Promise.resolve([file(), replacement])),
		} as unknown as GoogleDriveClient, "root");

		expect(await fs.priority.observe({ path: "note.md", identityKey: "file-1" })).toMatchObject({
			kind: "unverifiable", occupant: { kind: "conflicting" },
		});
		await fs.close();
	});
});
