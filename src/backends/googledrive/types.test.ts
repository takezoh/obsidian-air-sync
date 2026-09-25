import { describe, it, expect } from "vitest";
import { assertGoogleDriveFile, assertGoogleDriveFileList, assertGoogleDriveChangeList } from "./types";

describe("assertGoogleDriveFile", () => {
	it("accepts a valid file", () => {
		expect(() =>
			assertGoogleDriveFile({ id: "1", name: "a.txt", mimeType: "text/plain" })
		).not.toThrow();
	});

	it("rejects when mimeType is missing", () => {
		expect(() =>
			assertGoogleDriveFile({ id: "1", name: "a.txt" })
		).toThrow("Invalid file metadata");
	});

	it("rejects when mimeType is not a string", () => {
		expect(() =>
			assertGoogleDriveFile({ id: "1", name: "a.txt", mimeType: 42 })
		).toThrow("Invalid file metadata");
	});
});

describe("assertGoogleDriveFileList", () => {
	it("accepts a valid file list", () => {
		expect(() =>
			assertGoogleDriveFileList({
				files: [{ id: "1", name: "a.txt", mimeType: "text/plain" }],
			})
		).not.toThrow();
	});

	it("rejects when files array contains null", () => {
		expect(() =>
			assertGoogleDriveFileList({ files: [null] })
		).toThrow("Invalid file metadata");
	});

	it("rejects when a file is missing id", () => {
		expect(() =>
			assertGoogleDriveFileList({ files: [{ name: "a.txt", mimeType: "text/plain" }] })
		).toThrow("Invalid file metadata");
	});
});

describe("assertGoogleDriveChangeList", () => {
	it("accepts a valid change list", () => {
		expect(() =>
			assertGoogleDriveChangeList({
				changes: [
					{ type: "file", fileId: "abc", removed: false },
				],
			})
		).not.toThrow();
	});

	it("rejects when a change entry has non-string fileId", () => {
		expect(() =>
			assertGoogleDriveChangeList({
				changes: [{ type: "file", fileId: 123, removed: false }],
			})
		).toThrow("Invalid change entry");
	});

	it("rejects when removed is not a boolean", () => {
		expect(() =>
			assertGoogleDriveChangeList({
				changes: [{ type: "file", fileId: "abc", removed: "false" }],
			})
		).toThrow("Invalid change entry");
	});

	it("rejects when type is missing", () => {
		expect(() =>
			assertGoogleDriveChangeList({
				changes: [{ fileId: "abc", removed: false }],
			})
		).toThrow("Invalid change entry");
	});

	it("validates file field inside a change entry", () => {
		expect(() =>
			assertGoogleDriveChangeList({
				changes: [
					{
						type: "file",
						fileId: "abc",
						removed: false,
						file: { id: 42, name: "bad" },
					},
				],
			})
		).toThrow("Invalid file metadata");
	});
});
