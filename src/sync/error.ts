/**
 * The retry policy (`decideRetry`/`sleep`) now lives with the error classification
 * it acts on, in the shared fs-layer error module (`fs/errors.ts`), so both the sync
 * engine and fs-layer backends (e.g. the Google Drive full-scan listing) reuse one
 * implementation. Re-exported here for the sync-layer call sites that import from
 * `./error`.
 */
export { decideRetry, sleep } from "../fs/errors";
export type { RetryDecision } from "../fs/errors";
