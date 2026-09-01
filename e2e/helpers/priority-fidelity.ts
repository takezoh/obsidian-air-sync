import { describe, expect, it } from "vitest";
import type { IFileSystem } from "../../src/fs/interface";
import type { PriorityObservationCapability } from "../../src/fs/priority-observation";
import { bytes } from "../../src/fs/contracts/ifilesystem.contract";

type PriorityFs = IFileSystem & { priority: PriorityObservationCapability };

function requirePriority(fs: IFileSystem): PriorityFs {
	if (!fs.priority) throw new Error(`${fs.name} does not expose priority observation`);
	return fs as PriorityFs;
}

async function checkpointState(fs: IFileSystem): Promise<boolean | undefined> {
	return fs.checkpoint?.hasCheckpoint();
}

/**
 * Live-backend fidelity scenarios for the priority capability. These use only
 * public filesystem operations and real provider state; fake-only fault injection
 * remains in the unit contract harnesses.
 */
export function runPriorityFidelityE2E(
	label: string,
	makeFs: () => Promise<IFileSystem>,
): void {
	describe(`${label} priority observation fidelity (real)`, () => {
		it("observes and reads the current stable identity without advancing the checkpoint", async () => {
			const fs = requirePriority(await makeFs());
			try {
				const content = bytes("priority-current");
				const written = await fs.write("priority.md", content, Date.now());
				expect(written.identityKey).toBeTruthy();
				const checkpointBefore = await checkpointState(fs);

				const observed = await fs.priority.observe({
					path: written.path,
					identityKey: written.identityKey,
				});
				expect(observed).toMatchObject({
					kind: "current",
					path: written.path,
					identityKey: written.identityKey,
					entity: { pathAuthority: "actual_resolved" },
				});
				if (observed.kind !== "current") throw new Error("expected current observation");
				expect(observed.token).not.toHaveLength(0);
				expect(await fs.priority.read(observed)).toEqual({ kind: "content", content });
				expect(await checkpointState(fs)).toBe(checkpointBefore);
			} finally {
				await fs.close?.();
			}
		});

		it("rejects an admitted observation after the same identity is overwritten", async () => {
			const fs = requirePriority(await makeFs());
			try {
				const written = await fs.write("priority.md", bytes("before"), Date.now());
				const observed = await fs.priority.observe({
					path: written.path,
					identityKey: written.identityKey,
				});
				if (observed.kind !== "current") throw new Error("expected current observation");

				const overwritten = await fs.write("priority.md", bytes("after"), Date.now() + 1000);
				expect(overwritten.identityKey).toBe(written.identityKey);
				expect(await fs.priority.read(observed)).toEqual({ kind: "target_changed" });
			} finally {
				await fs.close?.();
			}
		});

		it("reports an admitted identity and path that were deleted as missing", async () => {
			const fs = requirePriority(await makeFs());
			try {
				const written = await fs.write("priority.md", bytes("deleted"), Date.now());
				await fs.delete(written.path);
				expect(await fs.priority.observe({
					path: written.path,
					identityKey: written.identityKey,
				})).toEqual({ kind: "missing", occupant: { kind: "absent" } });
			} finally {
				await fs.close?.();
			}
		});

		it("reports a same-path replacement as structural", async () => {
			const fs = requirePriority(await makeFs());
			try {
				const original = await fs.write("priority.md", bytes("original"), Date.now());
				await fs.delete(original.path);
				const replacement = await fs.write("priority.md", bytes("replacement"), Date.now() + 1000);
				expect(replacement.identityKey).toBeTruthy();
				expect(replacement.identityKey).not.toBe(original.identityKey);

				expect(await fs.priority.observe({
					path: original.path,
					identityKey: original.identityKey,
				})).toMatchObject({
					kind: "structural",
					occupant: {
						kind: "current",
						identityKey: replacement.identityKey,
					},
				});
			} finally {
				await fs.close?.();
			}
		});
	});
}
