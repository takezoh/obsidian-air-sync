/**
 * Check if an error is an HTTP error with the given status code.
 *
 * The Google Drive client's full delta drain now lives in the module adapter
 * (`adapter.ts` / `client.ts`); this predicate is the shared helper the folder
 * helpers still need.
 */
export function isHttpError(err: unknown, status: number): boolean {
	if (err && typeof err === "object" && "status" in err) {
		return (err as { status: number }).status === status;
	}
	return false;
}
