import { describe, expect, it, vi } from "vitest";
import {
	runPriorityObservationContract,
	type PriorityObservationContractHarness,
	type PriorityObservationScenario,
} from "../contracts/priority-observation.contract";
import { OneDriveFs } from "./index";
import type { OneDriveClient } from "./client";
import { GraphApiError, type OneDriveItem } from "./types";

const CONTENT = new Uint8Array([1, 2, 3]).buffer;

interface OneDrivePriorityHarness extends PriorityObservationContractHarness {
	assertIdentityReadRoute(): void;
}

function item(overrides: Partial<OneDriveItem> = {}): OneDriveItem {
	return { id: "file-1", name: "note.md", parentReference: { id: "root" }, size: 3,
		cTag: "c2", eTag: "e2", file: { hashes: { quickXorHash: "qx" } },
		fileSystemInfo: { lastModifiedDateTime: "2026-08-27T00:00:00Z" }, ...overrides };
}

function makeOneDriveHarness(scenario: PriorityObservationScenario): OneDrivePriorityHarness {
	let current = item();
	const replacement = item({ id: "file-2", cTag: "c3" });
	const missingError = new GraphApiError("gone", 404, "itemNotFound");
	if (scenario === "unverifiable") current = item({ cTag: undefined, eTag: undefined });

	const getItem = vi.fn(() => {
		if (scenario === "missing") return Promise.reject(missingError);
		if (scenario === "replacement") return Promise.reject(missingError);
		return Promise.resolve(current);
	});
	const getChildByName = vi.fn(() => {
		if (scenario === "missing") return Promise.reject(missingError);
		if (scenario === "replacement") return Promise.resolve(replacement);
		return Promise.resolve(current);
	});
	const download = vi.fn(() => {
		if (scenario === "changed-during-read") current = item({ cTag: "c3" });
		return Promise.resolve(CONTENT);
	});
	const fs = new OneDriveFs(
		{ getItem, getChildByName, download } as unknown as OneDriveClient,
		"root",
	);
	return {
		fs,
		request: { path: "note.md", identityKey: "file-1" },
		expectedToken: "onedrive:c2",
		expectedContent: CONTENT,
		replacementIdentityKey: "file-2",
		assertIdentityReadRoute: () => {
			expect(getChildByName).toHaveBeenCalledWith("root", "note.md");
			expect(download).toHaveBeenCalledWith("file-1");
		},
	};
}

export function registerOneDrivePriorityObservationContract(): void {
	runPriorityObservationContract("OneDriveFs", makeOneDriveHarness);
	describe("OneDriveFs priority observation addressing", () => {
		it("resolves the path occupant and downloads by the admitted stable identity", async () => {
			const harness = makeOneDriveHarness("current");
			try {
				const observed = await harness.fs.priority.observe(harness.request);
				if (observed.kind !== "current") throw new Error("expected current observation");
				await harness.fs.priority.read(observed);
				harness.assertIdentityReadRoute();
			} finally {
				await harness.fs.close?.();
			}
		});
	});
}
