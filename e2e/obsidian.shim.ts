/**
 * The `obsidian` module the e2e harness sees (via the alias in
 * `vitest.config.e2e.ts` and the esbuild bootstrap). It is the normal test mock
 * with ONE change: `requestUrl` performs real HTTP (see `request-url.ts`) so the
 * real clients/auth reach the live Google Drive / Dropbox APIs.
 *
 * The explicit `requestUrl` export shadows the star-exported one from the mock
 * (an explicit local export wins over a same-named star export), while everything
 * else — `Notice`, `Platform`, `Vault`, … that the imported `src/` modules pull
 * in transitively — keeps coming from the mock.
 */
export * from "../src/__mocks__/obsidian";
export { realRequestUrl as requestUrl } from "./request-url";
