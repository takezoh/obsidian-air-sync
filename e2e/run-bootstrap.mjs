// Wrapper for the e2e token bootstrap. Bundles `bootstrap.ts` with esbuild (already
// a devDependency — no tsx needed), aliasing `obsidian` to the e2e shim so the
// shipped auth code's `requestUrl` performs real HTTP, then runs the bundle.
// argv is preserved (same process), so `npm run e2e:bootstrap -- google` works.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { rmSync } from "node:fs";

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
