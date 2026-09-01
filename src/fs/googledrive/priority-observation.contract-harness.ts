import { describe, expect, it, vi } from "vitest";
import {
	runPriorityObservationContract,
	type PriorityObservationContractHarness,
	type PriorityObservationScenario,
} from "../contracts/priority-observation.contract";
import { GoogleDriveFs } from "./index";
import type { GoogleDriveClient } from "./client";
import type { GoogleDriveFile } from "./types";

const CONTENT = new Uint8Array([1, 2, 3]).buffer;

interface GoogleDrivePriorityHarness extends PriorityObservationContractHarness {
	assertIdentityReadRoute(): void;
}

function file(overrides: Partial<GoogleDriveFile> = {}): GoogleDriveFile {
	return { id: "file-1", name: "note.md", mimeType: "application/octet-stream", parents: ["root"],
		size: "3", modifiedTime: "2026-08-27T00:00:00Z", md5Checksum: "abc", version: "2", ...overrides };
}

function makeGoogleDriveHarness(scenario: PriorityObservationScenario): GoogleDrivePriorityHarness {
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
	if (scenario === "unverifiable") current = file({ md5Checksum: undefined });
	const downloadFile = vi.fn(() => {
		if (scenario === "changed-during-read") current = file({ md5Checksum: "def" });
		return Promise.resolve(CONTENT);
	});
	const fs = new GoogleDriveFs(
		{ getFile, listChildrenByName, downloadFile } as unknown as GoogleDriveClient,
		"root",
	);
	return {
		fs,
		request: { path: "note.md", identityKey: "file-1" },
		expectedToken: "googledrive:md5:abc:3",
		expectedContent: CONTENT,
		replacementIdentityKey: "file-2",
		assertIdentityReadRoute: () => {
			expect(listChildrenByName).toHaveBeenCalledWith("root", "note.md");
			expect(downloadFile).toHaveBeenCalledWith("file-1");
		},
	};
}

export function registerGoogleDrivePriorityObservationContract(): void {
	runPriorityObservationContract("GoogleDriveFs", makeGoogleDriveHarness);

	describe("GoogleDriveFs detached priority observation", () => {
		it("resolves the path occupant and downloads by the admitted stable identity", async () => {
			const harness = makeGoogleDriveHarness("current");
			try {
				const observed = await harness.fs.priority.observe(harness.request);
				if (observed.kind !== "current") throw new Error("expected current observation");
				await harness.fs.priority.read(observed);
				harness.assertIdentityReadRoute();
			} finally {
				await harness.fs.close?.();
			}
		});

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
}
