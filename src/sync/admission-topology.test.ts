import { describe, expect, it } from "vitest";
import { partitionAdmissionTopology } from "./admission-topology";
import type { IdentityEvidence, RenameEvidence, ScopeDisposition } from "./types";

function rename(
	oldPath: string,
	newPath: string,
	isFolder = false,
): RenameEvidence {
	return {
		kind: "rename", side: "local", oldPath, newPath,
		isFolder, authority: "reported",
	};
}

function scope(entries: Record<string, ScopeDisposition>) {
	return { byEndpoint: new Map(Object.entries(entries)) };
}

describe("partitionAdmissionTopology", () => {
	it("keeps every policy-out source outside managed identity topology", () => {
		const folder = rename("old", "new", true);
		const child = rename("old/note.md", "new/note.md");
		const alias: IdentityEvidence = {
			kind: "alias", side: "local", requestedPath: "new", resolvedPath: "old",
		};
		const result = partitionAdmissionTopology([folder, child, alias], scope({
			old: "included", new: "included",
			"old/note.md": "included", "new/note.md": "included",
			"old/user-ignored.tmp": "policy_out",
			"old/.hidden/cache": "policy_out",
			"old/reserved/plugin-data": "policy_out",
		}));

		expect(result.identityEvidence).toEqual([child]);
		expect(result.footprintConstraints).toEqual([{
			rename: folder,
			excludedPaths: [
				"old/.hidden/cache", "old/reserved/plugin-data", "old/user-ignored.tmp",
			],
		}]);
	});

	it.each(["unknown", "mobile_deferred"] as const)(
		"does not partition an indeterminate %s descendant",
		(disposition) => {
			const folder = rename("old", "new", true);
			const child = rename("old/note.md", "new/note.md");
			const result = partitionAdmissionTopology([folder, child], scope({
				old: "included", new: "included",
				"old/note.md": "included", "new/note.md": "included",
				"old/excluded": "policy_out", "old/unresolved": disposition,
			}));

			expect(result.identityEvidence).toEqual([folder, child]);
			expect(result.footprintConstraints).toEqual([]);
		},
	);
});
