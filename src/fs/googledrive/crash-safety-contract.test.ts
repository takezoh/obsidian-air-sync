import "fake-indexeddb/auto";
import { vi } from "vitest";
import type { GoogleDriveClient } from "./client";
import type { GoogleDriveFile, GoogleDriveChange } from "./types";
import { MetadataStore } from "../../store/metadata-store";
import { GoogleDriveFs } from "./index";
import { runCachingRemoteFsContract } from "../caching/remote-fs-contract";
import type { CachingRemoteFsHarness } from "../caching/remote-fs-contract";

vi.mock("obsidian");

// Run the shared base crash-safety contract against the REAL GoogleDriveFs (not the
// mock backend), via a minimal GoogleDriveClient stub over an in-memory remote — a baseline
// of Google Drive files plus an append-only changes.list log. This proves the A1 lift kept
// Google Drive's ADR 0001 path-1 behaviour intact through the new seams, and answers
// "the contract is only ever run by the mock". Path 2 (state C) is the orchestrator's
// job and stays pinned by orchestrator.test.ts (see the contract's scope note).
function makeGoogleDriveHarness(): CachingRemoteFsHarness<GoogleDriveFile> {
	const baseline = new Map<string, GoogleDriveFile>();
	const events: GoogleDriveChange[] = [];
	let idSeq = 0;
	const head = () => `c${events.length}`;

	const client = {
		listAllFiles: () => Promise.resolve([...baseline.values()]),
		getChangesStartToken: () => Promise.resolve(head()),
		listChanges: (from: string) => {
			const idx = from.startsWith("c") ? Number(from.slice(1)) : 0;
			return Promise.resolve({ changes: events.slice(idx), newStartPageToken: head() });
		},
	} as unknown as GoogleDriveClient;

	return {
		makeStore: (id) => new MetadataStore<GoogleDriveFile>(id, { dbNamePrefix: "air-sync-googledrive-contract", version: 1 }),
		makeFs: (store) => new GoogleDriveFs(client, "root", undefined, store),
		seedFile: (path) => {
			const id = `f${++idSeq}`;
			baseline.set(id, { id, name: path, mimeType: "text/plain", parents: ["root"], modifiedTime: "2024-01-01T00:00:00.000Z" });
		},
		stageRemoteDelete: (path) => {
			const entry = [...baseline.values()].find((f) => f.name === path);
			if (!entry) throw new Error(`stageRemoteDelete: no such file "${path}"`);
			baseline.delete(entry.id);
			events.push({ type: "file", fileId: entry.id, removed: true });
		},
	};
}

runCachingRemoteFsContract("GoogleDriveFs", makeGoogleDriveHarness);
