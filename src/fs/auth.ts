/**
 * Authentication provider interface — abstracts OAuth/credential lifecycle.
 *
 * `startAuth`/`completeAuth` return updates the caller merges into the live
 * `settings.backendData`. A module-backed provider applies and PERSISTS its own
 * patch through the core connection host (generation-gated) and returns `{}`, so
 * the live bag is authoritative: the caller must re-read `settings.backendData`
 * AFTER the await instead of merging into a pre-await snapshot.
 */
export interface IAuthProvider {
	startAuth(backendData: Record<string, unknown>): Promise<Record<string, unknown>>;
	completeAuth(input: string, backendData: Record<string, unknown>): Promise<Record<string, unknown>>;
}
