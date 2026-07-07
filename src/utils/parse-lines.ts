/** Options for {@link parseLines}. All steps are optional and applied in a fixed order. */
export interface ParseLinesOptions {
	/** Strip trailing slashes from each line (before the empty-line filter). */
	stripTrailingSlash?: boolean;
	/** Collapse duplicate lines, preserving first-seen order. */
	dedupe?: boolean;
}

/**
 * Normalize a textarea value into a clean list of entries — the shared core of the
 * dot-paths and ignore-patterns settings. Order is fixed: trim → (strip trailing
 * slash) → drop blanks → (dedupe). Pure, so it's unit-tested directly rather
 * than through the settings UI. Domain-specific filtering (e.g. dot-path shape)
 * is the caller's job — apply it on the returned list.
 */
export function parseLines(value: string, opts: ParseLinesOptions = {}): string[] {
	let lines = value.split("\n").map((line) => line.trim());
	if (opts.stripTrailingSlash) {
		lines = lines.map((line) => line.replace(/\/+$/, ""));
	}
	lines = lines.filter((line) => line.length > 0);
	return opts.dedupe ? [...new Set(lines)] : lines;
}
