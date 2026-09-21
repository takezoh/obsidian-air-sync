import { describe, expect, it } from "vitest";
import { beginFolderPick, completeFolderPick } from "../../src/fs/modules/folder-pick-host";
import type { FolderPickHost } from "../../src/fs/modules/folder-pick-host";
import type {
	BackendBinding,
	BackendRuntimeContext,
	JsonObject,
	JsonPatch,
} from "../../src/backend-api";

function fakeContext(): BackendRuntimeContext {
	return {
		http: { request: () => Promise.reject(new Error("unused")) },
		secrets: {
			get: () => Promise.resolve(null),
			set: () => Promise.resolve(),
			delete: () => Promise.resolve(),
		},
		logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		auth: { openExternal: () => Promise.resolve() },
	};
}

function hostWith(
	binding: BackendBinding,
	config: JsonObject,
	commit: (patch: JsonPatch) => Promise<boolean>,
): FolderPickHost {
	return {
		binding,
		context: fakeContext(),
		config: { read: () => config, commit },
	};
}

describe("beginFolderPick", () => {
	it("persists the state patch the module returns", async () => {
		const patches: JsonPatch[] = [];
		const binding: BackendBinding = {
			resolveDefault: () => Promise.reject(new Error("unused")),
			beginPick: (context, config) => {
				expect(context.secrets).toBeDefined();
				expect(config.mode).toBe("custom");
				return Promise.resolve({ set: { pendingFolderPickState: "S" } });
			},
		};
		const started = await beginFolderPick(
			hostWith(binding, { mode: "custom" }, (patch) => {
				patches.push(patch);
				return Promise.resolve(true);
			}),
		);
		expect(started).toBe(true);
		expect(patches).toEqual([{ set: { pendingFolderPickState: "S" } }]);
	});

	it("reports false when the backend has no start seam", async () => {
		const binding: BackendBinding = {
			resolveDefault: () => Promise.reject(new Error("unused")),
		};
		await expect(beginFolderPick(hostWith(binding, {}, () => Promise.resolve(true)))).resolves.toBe(
			false,
		);
	});

	it("reports false when the generation gate rejects the patch", async () => {
		const binding: BackendBinding = {
			resolveDefault: () => Promise.reject(new Error("unused")),
			beginPick: () => Promise.resolve({ set: { pendingFolderPickState: "S" } }),
		};
		await expect(beginFolderPick(hostWith(binding, {}, () => Promise.resolve(false)))).resolves.toBe(
			false,
		);
	});
});

describe("completeFolderPick", () => {
	it("binds the target and persists the completed patch with the callback params", async () => {
		const paramsSeen: Array<Readonly<Record<string, string>>> = [];
		const patches: JsonPatch[] = [];
		const binding: BackendBinding = {
			resolveDefault: () => Promise.reject(new Error("unused")),
			beginPick: () => Promise.resolve({}),
			completePick: (_context, params) => {
				paramsSeen.push(params);
				return Promise.resolve({
					patch: { set: { rootId: "id:new", pendingFolderPickState: "" } },
					target: { id: "id:new", displayPath: "Notes" },
				});
			},
		};
		const target = await completeFolderPick(
			hostWith(binding, {}, (patch) => {
				patches.push(patch);
				return Promise.resolve(true);
			}),
			{ picked_file_ids: "id:new", state: "S" },
		);
		expect(target).toEqual({ id: "id:new", displayPath: "Notes" });
		expect(patches[0]).toEqual({ set: { rootId: "id:new", pendingFolderPickState: "" } });
		expect(paramsSeen[0]).toEqual({ picked_file_ids: "id:new", state: "S" });
	});

	it("returns null when the backend has no complete seam", async () => {
		const binding: BackendBinding = {
			resolveDefault: () => Promise.reject(new Error("unused")),
		};
		await expect(
			completeFolderPick(hostWith(binding, {}, () => Promise.resolve(true)), {}),
		).resolves.toBeNull();
	});

	it("returns null when a stale generation rejects the patch", async () => {
		const binding: BackendBinding = {
			resolveDefault: () => Promise.reject(new Error("unused")),
			beginPick: () => Promise.resolve({}),
			completePick: () =>
				Promise.resolve({ patch: { set: { rootId: "id:new" } }, target: { id: "id:new" } }),
		};
		await expect(
			completeFolderPick(hostWith(binding, {}, () => Promise.resolve(false)), {}),
		).resolves.toBeNull();
	});
});
