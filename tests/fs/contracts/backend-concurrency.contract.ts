import { describe, expect, it } from "vitest";
import type {
	DestinationAddress,
	RemoteBackendAdapter,
	RemoteBackendCapabilities,
} from "../../../src/backend-api";

/**
 * Shared adapter-level concurrency contract.
 *
 * The managed contracts exercise a backend through `ManagedRemoteFs`; a change
 * injected between the adapter's metadata observation and its provider operation is
 * masked by core's own post-read re-observation. This contract drives the REAL
 * adapter directly, so the guarantee under test is the adapter's: a stale version
 * must never be carried out as a successful read or overwrite.
 *
 * A harness injects a provider change at the seam named by the scenario:
 *  - `write` lands before the adapter call (a stale expected version).
 *  - `writeAfterNextObservation` lands immediately AFTER the adapter observes the
 *    metadata for the guarded id, so the adapter's local comparison passes and only
 *    a provider-enforced precondition (or a post-download re-observation) can catch
 *    it.
 */
export interface BackendConcurrencyHarness {
	readonly adapter: RemoteBackendAdapter;
	/** Create a file and return its id plus the version token of its current bytes. */
	seed(path: string, content: string): Promise<{ id: string; versionToken: string }>;
	/** Create a folder and return its id plus its observed version token. */
	seedFolder(path: string): Promise<{ id: string; versionToken: string }>;
	/** A concurrent remote write to `id`, now. */
	write(id: string, content: string): Promise<void>;
	/** Let the adapter observe the pre-change metadata, then write concurrently. */
	writeAfterNextObservation(id: string, content: string): void;
	/** Let the adapter observe, then make a METADATA-ONLY change (eTag advances, content does not). */
	writeMetadataAfterNextObservation(id: string): void;
	/** The provider's current bytes for `id` as UTF-8, or `null` if absent. */
	contentOf(id: string): Promise<string | null>;
	/** The provider's current leaf name for `id`, or `null` if absent. */
	nameOf(id: string): string | null;
	/** Make the provider stop reporting version evidence for `id`. */
	removeEvidence(id: string): void;
	/** Remove the metadata version evidence but KEEP content-only evidence (e.g. cTag). */
	removeVersionEvidenceKeepContent(id: string): void;
	/** A destination address that would create a file named `name` under the root. */
	destination(name: string): DestinationAddress;
	/** Whether the provider reports version evidence for directories. */
	readonly directoryVersionEvidence: boolean;
	/** The version token the provider's own directory version/eTag must project to, or `undefined`. */
	providerDirectoryToken(id: string): string | undefined;
}

const bytes = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer;

function kindOf(err: unknown): string {
	const kind = (err as { kind?: unknown } | null)?.kind;
	return typeof kind === "string" ? kind : "threw";
}

export function runBackendConcurrencyContract(
	name: string,
	expected: RemoteBackendCapabilities,
	makeHarness: () => BackendConcurrencyHarness | Promise<BackendConcurrencyHarness>,
): void {
	describe(`backend concurrency contract — ${name}`, () => {
		it("declares the provider preconditions it can enforce", async () => {
			const harness = await makeHarness();
			expect(harness.adapter.capabilities).toEqual(expected);
		});

		it("does not return content for a version the provider has left", async () => {
			const harness = await makeHarness();
			const { id, versionToken } = await harness.seed("note.md", "one");
			await harness.write(id, "two");

			const result = await harness.adapter.read({ id, versionToken });
			expect(result.kind).toBe("target_changed");
		});

		it("rejects an update whose expected version the provider has left, preserving the concurrent bytes", async () => {
			const harness = await makeHarness();
			const { id, versionToken } = await harness.seed("note.md", "one");
			await harness.write(id, "two");

			const outcome = await harness.adapter
				.updateFile({ id, expected: { id, versionToken }, content: bytes("ours"), mtimeMs: 1 })
				.then(() => "applied", kindOf);
			expect(outcome).toBe("target_changed");
			expect(await harness.contentOf(id)).toBe("two");
		});

		if (expected.versionBoundRead === "reobserve") {
			it("returns target_changed when the version moves during a reobserve read", async () => {
				const harness = await makeHarness();
				const { id, versionToken } = await harness.seed("note.md", "one");
				harness.writeAfterNextObservation(id, "two");

				// A reobserve backend MUST detect the change: returning the pre-change
				// bytes under the requested token is exactly the "V1 metadata + V2 bytes"
				// defect.
				const result = await harness.adapter.read({ id, versionToken });
				expect(result.kind).toBe("target_changed");
			});
		}

		if (expected.versionBoundRead === "revision") {
			it("returns the exact requested revision's bytes when the provider moves on", async () => {
				const harness = await makeHarness();
				const { id, versionToken } = await harness.seed("note.md", "one");
				harness.writeAfterNextObservation(id, "two");

				const result = await harness.adapter.read({ id, versionToken });
				expect(result.kind).toBe("content");
				if (result.kind !== "content") return;
				expect(result.object.versionToken).toBe(versionToken);
				expect(new TextDecoder().decode(result.content)).toBe("one");
			});
		}

		if (expected.conditionalContentUpdate !== "none") {
			it("lets the provider reject a change that lands after the adapter's observation", async () => {
				const harness = await makeHarness();
				const { id, versionToken } = await harness.seed("note.md", "one");
				harness.writeAfterNextObservation(id, "two");

				const outcome = await harness.adapter
					.updateFile({ id, expected: { id, versionToken }, content: bytes("ours"), mtimeMs: 1 })
					.then(() => "applied", kindOf);
				expect(outcome).toBe("target_changed");
				expect(await harness.contentOf(id)).toBe("two");
			});

			it("does not let a stale identical-content update pass as a no-op", async () => {
				// Dropbox normally treats writing identical contents as a no-op success, so
				// only a carried `strict_conflict` (or an enforced revision) makes a stale
				// revision conflict. The concurrent writer leaves exactly the bytes we write.
				const harness = await makeHarness();
				const { id, versionToken } = await harness.seed("note.md", "one");
				harness.writeAfterNextObservation(id, "target");

				const outcome = await harness.adapter
					.updateFile({ id, expected: { id, versionToken }, content: bytes("target"), mtimeMs: 1 })
					.then(() => "applied", kindOf);
				expect(outcome).toBe("target_changed");
				expect(await harness.contentOf(id)).toBe("target");
			});
		}

		it("fails closed when an expected version cannot be re-proven before a mutation", async () => {
			const harness = await makeHarness();
			const { id, versionToken } = await harness.seed("note.md", "one");
			harness.removeEvidence(id);

			const outcome = await harness.adapter
				.delete({ id, expected: { id, versionToken } })
				.then(() => "applied", kindOf);
			expect(outcome).toBe("unverifiable");
			expect(await harness.contentOf(id)).toBe("one");
		});

		it("rejects an expected version that names a different object", async () => {
			const harness = await makeHarness();
			const { id, versionToken } = await harness.seed("note.md", "one");
			const outcome = await harness.adapter
				.delete({ id, expected: { id: "some-other-object", versionToken } })
				.then(() => "applied", kindOf);
			expect(outcome).toBe("target_changed");
			expect(await harness.contentOf(id)).toBe("one");
		});

		it("rejects a stale move/delete even where the provider has no metadata precondition", async () => {
			// Covers `conditionalMetadataMutation: false` backends: they must still
			// compare-before-mutate and fail closed on a real mismatch, never ignore it.
			const harness = await makeHarness();
			const { id, versionToken } = await harness.seed("note.md", "one");
			await harness.write(id, "two");

			const deleted = await harness.adapter
				.delete({ id, expected: { id, versionToken } })
				.then(() => "applied", kindOf);
			expect(deleted).toBe("target_changed");
			expect(await harness.contentOf(id)).toBe("two");

			const moved = await harness.adapter
				.move({ id, expected: { id, versionToken }, destination: harness.destination("renamed.md") })
				.then(() => "applied", kindOf);
			expect(moved).toBe("target_changed");
			expect(harness.nameOf(id)).toBe("note.md");
		});

		if (expected.conditionalMetadataMutation) {
			it("fails closed when the metadata eTag is absent even though content evidence remains", async () => {
				// No fallback to the content-only cTag: a provider whose metadata version
				// is gone must not be mutable.
				const harness = await makeHarness();
				const { id, versionToken } = await harness.seed("note.md", "one");
				harness.removeVersionEvidenceKeepContent(id);
				const outcome = await harness.adapter
					.delete({ id, expected: { id, versionToken } })
					.then(() => "applied", kindOf);
				expect(outcome).toBe("unverifiable");
				expect(await harness.contentOf(id)).toBe("one");
			});

			it("fails closed on an EMPTY expected token instead of moving without a precondition", async () => {
				const harness = await makeHarness();
				const { id } = await harness.seed("note.md", "one");
				const outcome = await harness.adapter
					.delete({ id, expected: { id, versionToken: "" } })
					.then(() => "applied", kindOf);
				expect(outcome).toBe("unverifiable");
				expect(await harness.contentOf(id)).toBe("one");
			});

			it("lets the provider reject a metadata-only delete that lands after observation", async () => {
				const harness = await makeHarness();
				const { id, versionToken } = await harness.seed("note.md", "one");
				// A rename changes only the full-item eTag; a cTag-based adapter would
				// still see its stale content token as current and issue the delete.
				harness.writeMetadataAfterNextObservation(id);

				const outcome = await harness.adapter
					.delete({ id, expected: { id, versionToken } })
					.then(() => "applied", kindOf);
				expect(outcome).toBe("target_changed");
				expect(harness.nameOf(id)).toBe("note.md");
			});

			it("guards a folder move by its own metadata version", async () => {
				const harness = await makeHarness();
				const { id, versionToken } = await harness.seedFolder("folder");
				harness.writeMetadataAfterNextObservation(id);

				const outcome = await harness.adapter
					.move({ id, expected: { id, versionToken }, destination: harness.destination("renamed-folder") })
					.then(() => "applied", kindOf);
				expect(outcome).toBe("target_changed");
				expect(harness.nameOf(id)).toBe("folder");
			});

			it("lets the provider reject a move whose version changed after observation", async () => {
				const harness = await makeHarness();
				const { id, versionToken } = await harness.seed("note.md", "one");
				harness.writeAfterNextObservation(id, "two");

				const outcome = await harness.adapter
					.move({ id, expected: { id, versionToken }, destination: harness.destination("renamed.md") })
					.then(() => "applied", kindOf);
				expect(outcome).toBe("target_changed");
				expect(harness.nameOf(id)).toBe("note.md");
			});

			it("lets the provider reject a delete whose version changed after observation", async () => {
				const harness = await makeHarness();
				const { id, versionToken } = await harness.seed("note.md", "one");
				harness.writeAfterNextObservation(id, "two");

				const outcome = await harness.adapter
					.delete({ id, expected: { id, versionToken } })
					.then(() => "applied", kindOf);
				expect(outcome).toBe("target_changed");
				expect(harness.nameOf(id)).toBe("note.md");
			});
		}

		it("derives directory version evidence from the provider version", async () => {
			const harness = await makeHarness();
			const { id } = await harness.seedFolder("folder");
			const object = await harness.adapter.getById(id);
			expect(object).not.toBeNull();
			// Exact match with the provider's own version, so a fixed or
			// modifiedTime-derived token cannot pass.
			expect(object!.versionToken).toBe(harness.providerDirectoryToken(id));
			if (harness.directoryVersionEvidence) {
				const before = object!.versionToken;
				harness.writeMetadataAfterNextObservation(id);
				// Consume the hook (the observation it returns is the pre-change one), then
				// take a fresh observation of the advanced provider version.
				await harness.adapter.getById(id);
				const after = await harness.adapter.getById(id);
				// A metadata-only change must advance the directory's version token,
				// which a regression that drops the directory token cannot satisfy.
				expect(after!.versionToken).toBe(harness.providerDirectoryToken(id));
				expect(after!.versionToken).not.toBe(before);
			}
		});

		it("does not silently overwrite an occupied destination on create", async () => {
			const harness = await makeHarness();
			const { id } = await harness.seed("note.md", "one");
			const outcome = await harness.adapter
				.createFile({ destination: harness.destination("note.md"), content: bytes("ours"), mtimeMs: 1 })
				.then(() => "applied", kindOf);

			if (expected.exclusiveCreate) {
				expect(outcome).toBe("target_changed");
				expect(await harness.contentOf(id)).toBe("one");
			} else {
				// A provider with no unique-create precondition may create a distinct
				// object at the same name; the original bytes must survive.
				expect(await harness.contentOf(id)).toBe("one");
			}
		});

		if (expected.exclusiveCreate) {
			it("rejects a ZERO-BYTE create at an occupied destination, preserving the existing bytes", async () => {
				// OneDrive routes a zero-byte create through the simple PUT (no session
				// byte range), so the exclusivity must still come from the provider's
				// documented conflict behaviour, not from a local pre-check.
				const harness = await makeHarness();
				const { id } = await harness.seed("note.md", "one");
				const outcome = await harness.adapter
					.createFile({ destination: harness.destination("note.md"), content: new ArrayBuffer(0), mtimeMs: 1 })
					.then(() => "applied", kindOf);
				expect(outcome).toBe("target_changed");
				expect(await harness.contentOf(id)).toBe("one");
			});
		}
	});
}
