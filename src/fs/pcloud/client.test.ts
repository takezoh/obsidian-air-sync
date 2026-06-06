import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, pcFile, pcFolder } from "./test-helpers";
import { AuthError } from "../errors";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

async function makeClient(token = "tok", host = "api.pcloud.com") {
	const { PCloudClient } = await import("./client");
	return new PCloudClient(() => token, () => host);
}

describe("PCloudClient error handling", () => {
	it("throws on a non-zero result (HTTP 200 logical error)", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ result: 2005, error: "Directory does not exist." }));
		const client = await makeClient();
		await expect(client.listFolder("0")).rejects.toThrow("pCloud API listFolder failed: 2005");
	});

	it("throws AuthError for an authentication-class result code", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ result: 1000, error: "Log in required." }));
		const client = await makeClient();
		await expect(client.stat("1")).rejects.toBeInstanceOf(AuthError);
	});

	it("wraps a transport error with the operation name", async () => {
		(await spyRequestUrl()).mockRejectedValue(new Error("network down"));
		const client = await makeClient();
		await expect(client.listFolder("0")).rejects.toThrow("pCloud API listFolder failed: network down");
	});
});

describe("PCloudClient request shape", () => {
	it("attaches the auth token and folderid/recursive as query params", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ result: 0, metadata: pcFolder(0, "/", 0, []) }));
		const client = await makeClient("secret-token");
		await client.listFolder("0", true);
		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.url).toContain("/listfolder?");
		expect(opts.url).toContain("auth=secret-token");
		expect(opts.url).toContain("folderid=0");
		expect(opts.url).toContain("recursive=1");
	});

	it("uses the EU host when configured", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ result: 0, metadata: pcFolder(0, "/", 0, []) }));
		const client = await makeClient("tok", "eapi.pcloud.com");
		await client.listFolder("0");
		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.url).toContain("https://eapi.pcloud.com/listfolder");
	});
});

describe("PCloudClient.uploadFile", () => {
	it("POSTs a multipart body with the filename and mtime in seconds", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ result: 0, metadata: [pcFile(5, "note.md", 0)], fileids: [5] }),
		);
		const client = await makeClient();
		const content = new TextEncoder().encode("hello").buffer as ArrayBuffer;
		const entry = await client.uploadFile("0", "note.md", content, 1_700_000_000_000);

		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.method).toBe("POST");
		expect(opts.url).toContain("/uploadfile?");
		expect(opts.url).toContain("folderid=0");
		expect(opts.url).toContain("mtime=1700000000"); // ms → seconds
		expect(String(opts.headers?.["Content-Type"])).toContain("multipart/form-data; boundary=");
		const body = new TextDecoder().decode(opts.body as ArrayBuffer);
		expect(body).toContain('filename="note.md"');
		expect(body).toContain("hello");
		expect(entry.id).toBe("f5");
	});

	it("throws when the upload response has no metadata", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ result: 0, fileids: [] }));
		const client = await makeClient();
		const content = new ArrayBuffer(1);
		await expect(client.uploadFile("0", "x", content, 0)).rejects.toThrow("no metadata");
	});
});

describe("PCloudClient.downloadFile", () => {
	it("resolves a getfilelink and GETs the content host", async () => {
		const buf = new TextEncoder().encode("data").buffer as ArrayBuffer;
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("getfilelink")) {
				return Promise.resolve(mockRes({ result: 0, hosts: ["c1.pcloud.com"], path: "/x.dat" }));
			}
			return Promise.resolve(mockRes({}, { arrayBuffer: buf }));
		});
		const client = await makeClient();
		const out = await client.downloadFile("5");
		expect(new TextDecoder().decode(out)).toBe("data");
	});
});

describe("PCloudClient.getDiffBaseline", () => {
	it("returns the top-level diffid from diff?last=0", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ result: 0, diffid: 4242, entries: [] }));
		const client = await makeClient();
		expect(await client.getDiffBaseline()).toBe("4242");
		const opts = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(opts.url).toContain("last=0");
	});
});
