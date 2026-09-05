import { describe, expect, it, vi } from "vitest";
import type { FileEntity } from "../fs/types";
import type { IFileSystem } from "../fs/interface";
import type { PathObservation } from "./types";
import { confirmEntryAbsences, confirmRenameOppositeEndpoints, exactEntity, observePath } from "./path-observation";

function entity(path: string, pathAuthority?: FileEntity["pathAuthority"]): FileEntity {
	return { path, pathAuthority, isDirectory: false, size: 1, mtime: 1, hash: "h" };
}

describe("observePath", () => {
	it("recognizes exact and alias paths only from actual-resolved producers", () => {
		const exact = observePath("local", "A.md", entity("A.md", "actual_resolved"));
		const alias = observePath("remote", "A.md", entity("a.md", "actual_resolved"));

		expect(exact.kind).toBe("exact");
		expect(exactEntity(exact)?.path).toBe("A.md");
		expect(alias).toMatchObject({ kind: "alias", requestedPath: "A.md", resolvedPath: "a.md" });
		expect(exactEntity(alias)).toBeUndefined();
	});

	it("keeps requested echoes and unspecified authority unresolved", () => {
		for (const candidate of [entity("A.md", "requested_echo"), entity("A.md")]) {
			expect(observePath("remote", "A.md", candidate)).toMatchObject({
				kind: "present_unresolved", requestedPath: "A.md", returnedPath: "A.md", source: "stat",
			});
		}
	});

	it("records whether unresolved presence came from list or stat", () => {
		expect(observePath("remote", "A.md", entity("A.md"), "stat", "list")).toMatchObject({
			kind: "present_unresolved", source: "list",
		});
		expect(observePath("remote", "A.md", entity("A.md"))).toMatchObject({
			kind: "present_unresolved", source: "stat",
		});
	});

	it("distinguishes checkpoint tombstones from stat absence", () => {
		expect(observePath("remote", "A.md", null, "checkpoint_deleted")).toEqual({
			kind: "absent", side: "remote", requestedPath: "A.md", authority: "checkpoint_deleted",
		});
		expect(observePath("local", "A.md", null)).toEqual({
			kind: "absent", side: "local", requestedPath: "A.md", authority: "stat",
		});
	});
});

describe("confirmEntryAbsences", () => {
	it("indexes observations once instead of rescanning them for every entry", async () => {
		const count = 80;
		const entries = Array.from({ length: count }, (_, index) => ({
			path: `file-${index}.md`, remote: entity(`file-${index}.md`, "actual_resolved"),
		}));
		const backing: PathObservation[] = entries.map(({ path }) => ({
			kind: "unknown" as const, side: "local" as const, requestedPath: path,
			reason: "not_observed" as const,
		}));
		let indexedReads = 0;
		const observations = new Proxy(backing, {
			get(target, property, receiver): unknown {
				if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
				return Reflect.get(target, property, receiver) as unknown;
			},
		});
		const fs = { stat: () => Promise.resolve(null) } as unknown as IFileSystem;

		await confirmEntryAbsences({ entries, observations }, fs, fs);

		expect(indexedReads).toBeLessThan(count * 5);
		expect(observations.every((item) => item.kind === "absent")).toBe(true);
	});
});

describe("rename descendant observation", () => {
	it.each(["local", "remote"] as const)("records a %s counterpart occupant without assuming vacancy", async (side) => {
		const occupant = entity("old/added.md", "actual_resolved");
		const observations: PathObservation[] = [
			observePath(side, "new/added.md", entity("new/added.md", "actual_resolved")),
		];
		const stat = vi.fn((path: string) => Promise.resolve(path === occupant.path ? occupant : null));
		const fs = { stat } as unknown as IFileSystem;
		const report = { kind: "rename" as const, side, oldPath: "old", newPath: "new",
			isFolder: true, authority: "reported" as const };
		await confirmRenameOppositeEndpoints(observations, [report, report], fs, fs);
		for (const observedSide of ["local", "remote"] as const) {
			expect(observations).toContainEqual({ kind: "exact", side: observedSide,
				requestedPath: "old/added.md", entity: occupant });
		}
		expect(stat.mock.calls.filter(([path]) => path === "old/added.md")).toHaveLength(2);
	});

	it("retains an unresolved counterpart and an authoritative tombstone", async () => {
		const observations: PathObservation[] = [
			observePath("local", "new/added.md", entity("new/added.md", "actual_resolved")),
			observePath("remote", "old/added.md", null, "checkpoint_deleted"),
		];
		const local = { stat: (path: string) => Promise.resolve(entity(path, "requested_echo")) } as unknown as IFileSystem;
		const remoteStat = vi.fn(() => Promise.resolve(null));
		await confirmRenameOppositeEndpoints(observations, [{ kind: "rename", side: "local",
			oldPath: "old", newPath: "new", isFolder: true, authority: "reported" }],
		local, { stat: remoteStat } as unknown as IFileSystem);
		expect(observations).toContainEqual(expect.objectContaining({ kind: "present_unresolved",
			side: "local", requestedPath: "old/added.md", source: "stat" }));
		expect(observations).toContainEqual({ kind: "absent", side: "remote",
			requestedPath: "old/added.md", authority: "checkpoint_deleted" });
		expect(remoteStat).not.toHaveBeenCalledWith("old/added.md");
	});
});
