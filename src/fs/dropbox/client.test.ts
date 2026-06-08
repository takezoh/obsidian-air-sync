import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, dbxFile, dbxFolder, untagged } from "./test-helpers";
import { AuthError } from "../errors";
import { DropboxApiError } from "./types";
import { MAX_RATE_LIMIT_RETRIES } from "./client";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

async function makeClient(token = "tok") {
	const { DropboxClient } = await import("./client");
	// Inject a no-op sleep so 429 backoff retries run instantly in tests.
	return new DropboxClient(() => Promise.resolve(token), undefined, () => Promise.resolve());
}

describe("DropboxClient error handling", () => {
	it("refreshes+retries once on 401 then throws AuthError", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ error_summary: "expired_access_token/..", error: { ".tag": "expired_access_token" } }, { status: 401 }),
		);
		const client = await makeClient();
		await expect(client.getMetadata("/x")).rejects.toBeInstanceOf(AuthError);
		expect(spy).toHaveBeenCalledTimes(2); // original + one forced-refresh retry
	});

	it("throws a DropboxApiError on a 409 endpoint error", async () => {
		(await spyRequestUrl()).mockResolvedValue(
			mockRes({ error_summary: "path/not_found/..", error: { ".tag": "path" } }, { status: 409 }),
		);
		const client = await makeClient();
		await expect(client.getMetadata("/x")).rejects.toBeInstanceOf(DropboxApiError);
	});

	it("retries a 429 with backoff and succeeds when it clears", async () => {
		let calls = 0;
		(await spyRequestUrl()).mockImplementation(() => {
			calls++;
			if (calls === 1) return Promise.resolve(mockRes({ error_summary: "too_many_write_operations/.." }, { status: 429 }));
			return Promise.resolve(mockRes({ entries: [], cursor: "c", has_more: false }));
		});
		const client = await makeClient();
		await expect(client.listFolder("", true)).resolves.toMatchObject({ has_more: false });
		expect(calls).toBe(2); // one 429, then a successful retry
	});

	it("honors Retry-After (seconds) but caps an oversized value", async () => {
		const { DropboxClient } = await import("./client");
		const delays: number[] = [];
		const recordingSleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };

		let calls = 0;
		(await spyRequestUrl()).mockImplementation(() => {
			calls++;
			// First: a sane Retry-After (2s); second: an oversized one (3600s) that must be capped.
			if (calls === 1) return Promise.resolve(mockRes({ error_summary: "too_many_requests/.." }, { status: 429, headers: { "retry-after": "2" } }));
			if (calls === 2) return Promise.resolve(mockRes({ error_summary: "too_many_requests/.." }, { status: 429, headers: { "retry-after": "3600" } }));
			return Promise.resolve(mockRes({ entries: [], cursor: "c", has_more: false }));
		});
		const client = new DropboxClient(() => Promise.resolve("tok"), undefined, recordingSleep);
		await client.listFolder("", true);

		expect(delays[0]).toBe(2000); // Retry-After: 2s honored verbatim
		expect(delays[1]).toBe(64_000); // Retry-After: 3600s capped to MAX_RATE_LIMIT_DELAY_MS
	});

	it("surfaces a persistent 429 as a DropboxApiError after exhausting retries", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ error_summary: "too_many_write_operations/.." }, { status: 429 }),
		);
		const client = await makeClient();
		await expect(client.listFolder("", true)).rejects.toMatchObject({ status: 429 });
		// Exactly the initial attempt + MAX_RATE_LIMIT_RETRIES backoff retries — pins
		// the loop count so a regression to the 401-style single retry would fail.
		expect(spy.mock.calls.length).toBe(MAX_RATE_LIMIT_RETRIES + 1);
	});

	it("wraps a transport error with the operation name", async () => {
		(await spyRequestUrl()).mockRejectedValue(new Error("network down"));
		const client = await makeClient();
		await expect(client.listFolder("", true)).rejects.toThrow("Dropbox API listFolder failed: network down");
	});
});

describe("DropboxClient.listFolderAll pagination cap", () => {
	it("throws (does not loop forever) when the server never clears has_more", async () => {
		const { LIST_PAGE_CAP } = await import("./client");
		let calls = 0;
		(await spyRequestUrl()).mockImplementation(() => {
			calls++;
			// Always advertise another page → an unbounded drain without the guard.
			return Promise.resolve(mockRes({ entries: [], cursor: "c", has_more: true }));
		});
		const client = await makeClient();

		await expect(client.listFolderAll("", true)).rejects.toThrow(/pagination exceeded/);
		// Bounded: 1 list_folder + LIST_PAGE_CAP continues, then it throws.
		expect(calls).toBe(LIST_PAGE_CAP + 1);
	});
});

describe("DropboxClient.upload", () => {
	it("sends overwrite mode, second-precision client_modified, and octet-stream body", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes(dbxFile("5", "/root/note.md")));
		const client = await makeClient();
		const content = new TextEncoder().encode("hello").buffer as ArrayBuffer;
		const entry = await client.upload("/root/note.md", content, 1_700_000_000_000);

		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.url).toContain("content.dropboxapi.com/2/files/upload");
		expect(opts.method).toBe("POST");
		expect(String(opts.headers?.["Content-Type"])).toBe("application/octet-stream");
		const arg = JSON.parse(String(opts.headers?.["Dropbox-API-Arg"])) as Record<string, unknown>;
		expect(arg).toMatchObject({ path: "/root/note.md", mode: "overwrite", autorename: false, client_modified: "2023-11-14T22:13:20Z" });
		expect(entry.id).toBe("id:5");
	});

	it("stamps .tag:'file' even though upload returns it untagged", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes(untagged(dbxFile("5", "/root/note.md"))));
		const client = await makeClient();
		const entry = await client.upload("/root/note.md", new ArrayBuffer(1), 0);
		expect(entry[".tag"]).toBe("file");
	});

	it("escapes non-ASCII path bytes in the Dropbox-API-Arg header", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes(dbxFile("6", "/root/日本語.md")));
		const client = await makeClient();
		await client.upload("/root/日本語.md", new ArrayBuffer(1), 0);
		const header = String((spy.mock.calls[0]![0] as RequestUrlParam).headers?.["Dropbox-API-Arg"]);
		// Header must be ASCII-only: raw multibyte chars escaped to \uXXXX.
		expect([...header].every((c) => c.charCodeAt(0) < 0x80)).toBe(true);
		expect(header).toContain("\\u");
		// JSON.parse decodes the escapes back to the original path.
		expect((JSON.parse(header) as { path: string }).path).toBe("/root/日本語.md");
	});
});

describe("DropboxClient.download", () => {
	it("POSTs to the content host with the path arg and returns the body bytes", async () => {
		const buf = new TextEncoder().encode("data").buffer as ArrayBuffer;
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes(undefined, { arrayBuffer: buf }));
		const client = await makeClient();
		const out = await client.download("/root/x.md");
		expect(new TextDecoder().decode(out)).toBe("data");
		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.url).toContain("content.dropboxapi.com/2/files/download");
		expect(JSON.parse(String(opts.headers?.["Dropbox-API-Arg"]))).toEqual({ path: "/root/x.md" });
	});
});

describe("DropboxClient.createFolder", () => {
	it("stamps .tag:'folder' even though create_folder_v2 returns it untagged", async () => {
		// Real Dropbox returns a bare FolderMetadata with NO .tag here. Without the
		// client stamp, the cache treats the new folder as a file and every write
		// into it fails with "X is a file".
		(await spyRequestUrl()).mockResolvedValue(mockRes({ metadata: untagged(dbxFolder("3", "/root/sub")) }));
		const client = await makeClient();
		const entry = await client.createFolder("/root/sub");
		expect(entry.id).toBe("id:3");
		expect(entry[".tag"]).toBe("folder");
	});

	it("swallows path/conflict and returns the existing folder via get_metadata", async () => {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("create_folder_v2")) {
				return Promise.resolve(mockRes({ error_summary: "path/conflict/folder/..", error: { ".tag": "path" } }, { status: 409 }));
			}
			return Promise.resolve(mockRes(dbxFolder("3", "/root/sub")));
		});
		const client = await makeClient();
		const entry = await client.createFolder("/root/sub");
		expect(entry.id).toBe("id:3");
	});
});

describe("DropboxClient.deletePath", () => {
	it("treats an already-gone path (409 not_found) as a no-op success", async () => {
		(await spyRequestUrl()).mockResolvedValue(
			mockRes({ error_summary: "path_lookup/not_found/..", error: { ".tag": "path_lookup" } }, { status: 409 }),
		);
		const client = await makeClient();
		await expect(client.deletePath("/root/gone.md")).resolves.toBeUndefined();
	});

	it("rethrows a non-not_found delete error", async () => {
		(await spyRequestUrl()).mockResolvedValue(
			mockRes({ error_summary: "path_lookup/restricted_content/..", error: { ".tag": "path_lookup" } }, { status: 409 }),
		);
		const client = await makeClient();
		await expect(client.deletePath("/root/x.md")).rejects.toBeInstanceOf(DropboxApiError);
	});
});

describe("DropboxClient.listFolderAll", () => {
	it("drains pages via list_folder/continue until has_more is false", async () => {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("list_folder/continue")) {
				return Promise.resolve(mockRes({ entries: [dbxFile("2", "/root/b.md")], cursor: "c2", has_more: false }));
			}
			return Promise.resolve(mockRes({ entries: [dbxFile("1", "/root/a.md")], cursor: "c1", has_more: true }));
		});
		const client = await makeClient();
		const entries = await client.listFolderAll("/root", true);
		expect(entries.map((e) => e.id)).toEqual(["id:1", "id:2"]);
	});
});
