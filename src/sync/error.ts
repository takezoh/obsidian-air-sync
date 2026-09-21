/**
 * The retry policy (`decideRetry`/`sleep`) now lives with the error classification
 * it acts on, in the public error-classification module (`backend-api/error-classification.ts`), so both the sync
 * engine and fs-layer backends (e.g. the Google Drive full-scan listing) reuse one
 * implementation. Re-exported here for the sync-layer call sites that import from
 * `./error`.
 */
export { decideRetry, sleep } from "../backend-api/error-classification";
export type { RetryDecision } from "../backend-api/error-classification";
