import { describe, expect, it } from "vitest";
import { applyJsonPatch, InvalidConfigPatchError } from "../../src/fs/modules/config-patch";
import type { JsonObject } from "../../src/backend-api";

describe("applyJsonPatch", () => {
	it("sets and unsets top-level fields without mutating the input", () => {
		const bag: JsonObject = { rootId: "old", authMode: false };
		const next = applyJsonPatch(bag, { set: { rootId: "new", token: "t" }, unset: ["authMode"] });
		expect(next).toEqual({ rootId: "new", token: "t" });
		expect(bag).toEqual({ rootId: "old", authMode: false });
	});

	it("replaces a whole nested field rather than merging it", () => {
		const bag: JsonObject = { client: { id: "a", secret: "b" } };
		const next = applyJsonPatch(bag, { set: { client: { id: "c" } } });
		expect(next.client).toEqual({ id: "c" });
	});

	it("rejects a patch carrying a non-JSON value", () => {
		const bag: JsonObject = { rootId: "old" };
		expect(() => applyJsonPatch(bag, { set: { when: new Date() } as unknown as JsonObject })).toThrow(
			InvalidConfigPatchError,
		);
		expect(() => applyJsonPatch(bag, { set: { fn: (() => undefined) as never } })).toThrow(
			InvalidConfigPatchError,
		);
		expect(() => applyJsonPatch(bag, { set: { ["__proto__"]: "x" } })).toThrow(
			InvalidConfigPatchError,
		);
	});
});

