import { describe, expect, it } from "vitest";
import { getHeader, headerKeys } from "./headers";

describe("header helpers", () => {
	it("reads Headers case-insensitively", () => {
		const headers = new Headers({ Location: "https://upload.example.com/session" });
		expect(getHeader(headers, "location")).toBe("https://upload.example.com/session");
	});

	it("reads plain records case-insensitively", () => {
		expect(getHeader({ "Retry-After": "7" }, "retry-after")).toBe("7");
		expect(getHeader({ LOCATION: "https://upload.example.com/session" }, "location")).toBe("https://upload.example.com/session");
	});

	it("returns header keys for diagnostics", () => {
		expect(headerKeys({ Location: "x", "X-Goog-Upload": "y" })).toEqual(["Location", "X-Goog-Upload"]);
	});
});
