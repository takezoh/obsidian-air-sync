import { describe, expect, it, vi } from "vitest";
import {
	runPriorityObservationContract,
	type PriorityObservationContractHarness,
	type PriorityObservationScenario,
} from "../contracts/priority-observation.contract";
import { DropboxFs } from "./index";
import type { DropboxClient } from "./client";
import { DropboxApiError, type DropboxEntry } from "./types";

const CONTENT = new Uint8Array([1, 2, 3]).buffer;

interface DropboxPriorityHarness extends PriorityObservationContractHarness {
	assertIdentityReadRoute(): void;
}

function entry(overrides: Partial<DropboxEntry> = {}): DropboxEntry {
	return { ".tag": "file", id: "id:file", name: "note.md", path_lower: "/vault/note.md",
		path_display: "/Vault/note.md", rev: "r2", size: 3, content_hash: "hash",
		server_modified: "2026-08-27T00:00:00Z", ...overrides };
}

function makeDropboxHarness(scenario: PriorityObservationScenario): DropboxPriorityHarness {
	let current = entry();
	const root = entry({ ".tag": "folder", id: "id:root", name: "Vault", path_display: "/Vault",
		rev: undefined, content_hash: undefined, size: undefined });
	const replacement = entry({ id: "id:replacement", rev: "r3" });
	const missingError = new DropboxApiError("gone", 409, "path/not_found");
	if (scenario === "unverifiable") current = entry({ rev: undefined });

	const getMetadata = vi.fn((address: string) => {
		if (address === "id:root") return Promise.resolve(root);
		if (scenario === "missing") return Promise.reject(missingError);
		if (scenario === "replacement") {
			return address === "id:file" ? Promise.reject(missingError) : Promise.resolve(replacement);
		}
		return Promise.resolve(current);
	});
	const download = vi.fn(() => {
		if (scenario === "changed-during-read") current = entry({ rev: "r3" });
		return Promise.resolve(CONTENT);
	});
	const fs = new DropboxFs({ getMetadata, download } as unknown as DropboxClient, "id:root");
	return {
		fs,
		request: { path: "note.md", identityKey: "id:file" },
		expectedToken: "dropbox:r2",
		expectedContent: CONTENT,
		replacementIdentityKey: "id:replacement",
		assertIdentityReadRoute: () => {
			expect(getMetadata).toHaveBeenCalledWith("id:root/note.md");
			expect(download).toHaveBeenCalledWith("id:file");
		},
	};
}

export function registerDropboxPriorityObservationContract(): void {
	runPriorityObservationContract("DropboxFs", makeDropboxHarness);
	describe("DropboxFs priority observation addressing", () => {
		it("resolves the path occupant and downloads by the admitted stable identity", async () => {
			const harness = makeDropboxHarness("current");
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
