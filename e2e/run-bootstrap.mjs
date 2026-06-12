// Wrapper for the e2e token bootstrap. Bundles `bootstrap.ts` with esbuild (already
// a devDependency — no tsx needed), aliasing `obsidian` to the e2e shim so the
// shipped auth code's `requestUrl` performs real HTTP, then runs the bundle.
// argv is preserved (same process), so `npm run e2e:bootstrap -- google` works.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { rmSync } from "node:fs";

// The bootstrap does NOT run the e2e's vitest globalSetup, so the Electron `net`
// host (request-url.ts's default transport, :39271) is never started — a token
// exchange routed through it dies with ECONNREFUSED. The exchange is a single OAuth
// POST (no cross-origin redirect, no hand-set Content-Length), so fetch's divergence
// from net is irrelevant here. Default to fetch unless the caller forces a transport.
// Must be set BEFORE importing the bundle: request-url.ts reads it at module load.
process.env.AIRSYNC_E2E_TRANSPORT ??= "fetch";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, ".bootstrap.bundle.mjs");

await build({
	entryPoints: [resolve(here, "bootstrap.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile,
	alias: { obsidian: resolve(here, "obsidian.shim.ts") },
});

try {
	await import(pathToFileURL(outfile).href);
} finally {
	rmSync(outfile, { force: true });
}
