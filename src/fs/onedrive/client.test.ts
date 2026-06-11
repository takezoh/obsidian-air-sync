import { describe, it, expect, vi, afterEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { spyRequestUrl, mockRes, odFile, odFolder, odDeleted } from "./test-helpers";
import { AuthError } from "../errors";
import { GraphApiError } from "./types";
import { MAX_RATE_LIMIT_RETRIES, extractDeltaToken } from "./client";
import { SIMPLE_UPLOAD_MAX } from "./upload-session";

vi.mock("obsidian");

afterEach(() => {
	vi.restoreAllMocks();
});

async function makeClient(token = "tok") {
	const { OneDriveClient } = await import("./client");
	// Inject a no-op sleep so 429 backoff retries run instantly in tests.
	return new OneDriveClient(() => Promise.resolve(token), undefined, () => Promise.resolve());
}

const ROOT = "root";

describe("extractDeltaToken", () => {
	it("pulls the token query param from a deltaLink", () => {
		expect(extractDeltaToken("https://graph/me/drive/items/root/delta?token=ABC123")).toBe("ABC123");
	});
	it("throws when the link or token is missing", () => {
		expect(() => extractDeltaToken(undefined)).toThrow(/missing @odata.deltaLink/);
		expect(() => extractDeltaToken("https://graph/delta?foo=bar")).toThrow(/missing token/);
	});
});

describe("OneDriveClient.getStartCursor", () => {
	it("requests token=latest and returns the deltaLink token", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ value: [], "@odata.deltaLink": "https://graph/delta?token=START9" }),
		);
		const client = await makeClient();
		expect(await client.getStartCursor(ROOT)).toBe("START9");
		expect(String((spy.mock.calls[0]![0] as RequestUrlParam).url)).toContain("/delta?token=latest");
	});
});

describe("OneDriveClient.fullList", () => {
	it("drains nextLink, excluding the root item and deleted tombstones", async () => {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const url = typeof opts === "string" ? opts : opts.url;
			if (url.includes("nextpage")) {
				return Promise.resolve(mockRes({ value: [odFile("f2", "b.md", ROOT)], "@odata.deltaLink": "https://g?token=z" }));
			}
			return Promise.resolve(mockRes({
				value: [odFolder(ROOT, "root", "gp"), odFile("f1", "a.md", ROOT), odDeleted("gone")],
				"@odata.nextLink": "https://graph/nextpage",
			}));
		});
		const client = await makeClient();
		const items = await client.fullList(ROOT);
		expect(items.map((i) => i.id)).toEqual(["f1", "f2"]); // root + deleted excluded
	});
});

describe("OneDriveClient.fetchDelta", () => {
	it("builds a token URL when given a bare token", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ value: [], "@odata.deltaLink": "https://g?token=n" }));
		const client = await makeClient();
		await client.fetchDelta(ROOT, "TOK1");
		expect(String((spy.mock.calls[0]![0] as RequestUrlParam).url)).toContain("/delta?token=TOK1");
	});

	it("uses an absolute nextLink verbatim", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes({ value: [], "@odata.deltaLink": "https://g?token=n" }));
		const client = await makeClient();
		await client.fetchDelta(ROOT, "https://graph/me/drive/next?token=X");
		expect(String((spy.mock.calls[0]![0] as RequestUrlParam).url)).toBe("https://graph/me/drive/next?token=X");
	});
});

describe("OneDriveClient.download", () => {
	it("reads @microsoft.graph.downloadUrl, then GETs it WITHOUT a bearer (avoids the /content 302 401)", async () => {
		const DOWNLOAD_URL = "https://cdn.example.com/blob?sig=presigned";
		const buf = new TextEncoder().encode("data").buffer as ArrayBuffer;
		const spy = (await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const o = typeof opts === "string" ? { url: opts } : opts;
			if (o.url === DOWNLOAD_URL) return Promise.resolve(mockRes(undefined, { arrayBuffer: buf }));
			return Promise.resolve(mockRes({ id: "f1", "@microsoft.graph.downloadUrl": DOWNLOAD_URL }));
		});
		const client = await makeClient();
		const out = await client.download("f1");
		expect(new TextDecoder().decode(out)).toBe("data");

		const metaCall = spy.mock.calls[0]![0] as RequestUrlParam;
		expect(String(metaCall.url)).toContain("/me/drive/items/f1?select=id,@microsoft.graph.downloadUrl");
		expect((metaCall.headers ?? {})["Authorization"]).toBe("Bearer tok"); // metadata GET IS authed

		const blobCall = spy.mock.calls[1]![0] as RequestUrlParam;
		expect(String(blobCall.url)).toBe(DOWNLOAD_URL);
		// The pre-authenticated URL must NOT carry a graph bearer, else the CDN host 401s.
		expect((blobCall.headers ?? {})["Authorization"]).toBeUndefined();
	});

	it("throws when the item carries no @microsoft.graph.downloadUrl", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ id: "f1" }));
		const client = await makeClient();
		await expect(client.download("f1")).rejects.toThrow(/no @microsoft.graph.downloadUrl/);
	});
});

describe("OneDriveClient.upload (simple)", () => {
	it("PUTs octet-stream then PATCHes fileSystemInfo to preserve mtime", async () => {
		const calls: RequestUrlParam[] = [];
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const o = typeof opts === "string" ? { url: opts } : opts;
			calls.push(o);
			if (o.method === "PATCH") return Promise.resolve(mockRes(odFile("f5", "note.md", ROOT)));
			return Promise.resolve(mockRes(odFile("f5", "note.md", ROOT)));
		});
		const client = await makeClient();
		const content = new TextEncoder().encode("hello").buffer as ArrayBuffer;
		const item = await client.upload(ROOT, "note.md", content, 1_700_000_000_000);

		const put = calls.find((c) => c.method === "PUT")!;
		expect(String(put.url)).toContain("/me/drive/items/root:/note.md:/content");
		expect(String(put.headers?.["Content-Type"])).toBe("application/octet-stream");
		const patch = calls.find((c) => c.method === "PATCH")!;
		expect(String(patch.url)).toContain("/me/drive/items/f5");
		const patchBody = JSON.parse(patch.body as string) as { fileSystemInfo: { lastModifiedDateTime: string } };
		expect(patchBody.fileSystemInfo.lastModifiedDateTime).toBe(new Date(1_700_000_000_000).toISOString());
		expect(item.id).toBe("f5");
	});
});

describe("OneDriveClient.upload (session, ≥ 4 MiB)", () => {
	it("creates an upload session then PUTs chunks with Content-Range; final response carries the item", async () => {
		const ranges: string[] = [];
		let sessionAuth: unknown;
		const chunkAuths: unknown[] = [];
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const o = typeof opts === "string" ? { url: opts } : opts;
			if (String(o.url).includes("createUploadSession")) {
				sessionAuth = o.headers?.Authorization;
				return Promise.resolve(mockRes({ uploadUrl: "https://upload.example/session" }));
			}
			ranges.push(String(o.headers?.["Content-Range"]));
			chunkAuths.push(o.headers?.Authorization);
			// Final chunk returns the completed item; earlier chunks return 202-ish bodies.
			return Promise.resolve(mockRes(odFile("big1", "big.bin", ROOT)));
		});
		const client = await makeClient();
		const content = new ArrayBuffer(SIMPLE_UPLOAD_MAX + 1024); // just over the simple cap → session path
		const item = await client.upload(ROOT, "big.bin", content, 1_700_000_000_000);

		expect(ranges.length).toBeGreaterThan(0);
		expect(ranges[0]).toMatch(/^bytes 0-\d+\/\d+$/);
		// The last Content-Range ends at total-1.
		const total = SIMPLE_UPLOAD_MAX + 1024;
		expect(ranges[ranges.length - 1]).toContain(`/${total}`);
		expect(ranges[ranges.length - 1]).toContain(`-${total - 1}/`);
		expect(item.id).toBe("big1");
		// The createUploadSession POST carries the bearer; the chunk PUTs to the
		// pre-authenticated uploadUrl must NOT (Graph rejects an unexpected bearer there).
		expect(sessionAuth).toBe("Bearer tok");
		expect(chunkAuths.length).toBeGreaterThan(0);
		for (const a of chunkAuths) expect(a).toBeUndefined();
	});
});

describe("OneDriveClient.createFolder", () => {
	it("POSTs children with conflictBehavior fail", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes(odFolder("d3", "sub", ROOT)));
		const client = await makeClient();
		const folder = await client.createFolder(ROOT, "sub");
		const body = JSON.parse((spy.mock.calls[0]![0] as RequestUrlParam).body as string) as Record<string, unknown>;
		expect(body).toMatchObject({ name: "sub", folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
		expect(folder.id).toBe("d3");
	});

	it("resolves a 409 name conflict to the existing child via a path-relative GET (idempotent)", async () => {
		(await spyRequestUrl()).mockImplementation((opts: string | RequestUrlParam) => {
			const o = typeof opts === "string" ? { url: opts } : opts;
			if (o.method === "POST") {
				return Promise.resolve(mockRes({ error: { code: "nameAlreadyExists" } }, { status: 409 }));
			}
			return Promise.resolve(mockRes(odFolder("d3", "sub", ROOT)));
		});
		const client = await makeClient();
		const folder = await client.createFolder(ROOT, "sub");
		expect(folder.id).toBe("d3");
	});
});

describe("OneDriveClient.move", () => {
	it("PATCHes name and parentReference together", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes(odFile("f1", "new.md", "d2")));
		const client = await makeClient();
		await client.move("f1", "new.md", "d2");
		const body = JSON.parse((spy.mock.calls[0]![0] as RequestUrlParam).body as string) as Record<string, unknown>;
		expect(body).toEqual({ name: "new.md", parentReference: { id: "d2" } });
	});

	it("omits unchanged fields (rename only, no move)", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(mockRes(odFile("f1", "new.md", ROOT)));
		const client = await makeClient();
		await client.move("f1", "new.md", undefined);
		const body = JSON.parse((spy.mock.calls[0]![0] as RequestUrlParam).body as string) as Record<string, unknown>;
		expect(body).toEqual({ name: "new.md" });
	});
});

describe("OneDriveClient.deleteItem", () => {
	it("treats a 404 already-gone item as a no-op success (idempotent)", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ error: { code: "itemNotFound" } }, { status: 404 }));
		const client = await makeClient();
		await expect(client.deleteItem("gone")).resolves.toBeUndefined();
	});

	it("rethrows a non-404 delete error", async () => {
		(await spyRequestUrl()).mockResolvedValue(mockRes({ error: { code: "accessDenied" } }, { status: 403 }));
		const client = await makeClient();
		await expect(client.deleteItem("f1")).rejects.toBeInstanceOf(GraphApiError);
	});
});

describe("OneDriveClient error handling", () => {
	it("refreshes+retries once on 401 then throws AuthError", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 }),
		);
		const client = await makeClient();
		await expect(client.getItem("f1")).rejects.toBeInstanceOf(AuthError);
		expect(spy).toHaveBeenCalledTimes(2); // original + one forced-refresh retry
	});

	it("retries a 429 with backoff and succeeds when it clears", async () => {
		let calls = 0;
		(await spyRequestUrl()).mockImplementation(() => {
			calls++;
			if (calls === 1) return Promise.resolve(mockRes({ error: { code: "activityLimitReached" } }, { status: 429 }));
			return Promise.resolve(mockRes(odFile("f1", "a.md", ROOT)));
		});
		const client = await makeClient();
		await expect(client.getItem("f1")).resolves.toMatchObject({ id: "f1" });
		expect(calls).toBe(2);
	});

	it("surfaces a persistent 429 as a GraphApiError after exhausting retries", async () => {
		const spy = (await spyRequestUrl()).mockResolvedValue(
			mockRes({ error: { code: "activityLimitReached" } }, { status: 429 }),
		);
		const client = await makeClient();
		await expect(client.getItem("f1")).rejects.toMatchObject({ status: 429 });
		expect(spy.mock.calls.length).toBe(MAX_RATE_LIMIT_RETRIES + 1);
	});

	it("wraps a transport error with the operation name", async () => {
		(await spyRequestUrl()).mockRejectedValue(new Error("network down"));
		const client = await makeClient();
		await expect(client.getItem("f1")).rejects.toThrow("OneDrive API getItem failed: network down");
	});

	it("honors Retry-After (seconds) but caps an oversized value", async () => {
		const { OneDriveClient } = await import("./client");
		const delays: number[] = [];
		let calls = 0;
		(await spyRequestUrl()).mockImplementation(() => {
			calls++;
			if (calls === 1) return Promise.resolve(mockRes({ error: { code: "x" } }, { status: 429, headers: { "retry-after": "2" } }));
			if (calls === 2) return Promise.resolve(mockRes({ error: { code: "x" } }, { status: 429, headers: { "retry-after": "3600" } }));
			return Promise.resolve(mockRes(odFile("f1", "a.md", ROOT)));
		});
		const client = new OneDriveClient(() => Promise.resolve("tok"), undefined, (ms) => { delays.push(ms); return Promise.resolve(); });
		await client.getItem("f1");
		expect(delays[0]).toBe(2000);
		expect(delays[1]).toBe(64_000);
	});
});
