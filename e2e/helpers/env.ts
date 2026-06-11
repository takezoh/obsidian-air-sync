import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load an optional, gitignored `.env.e2e` (repo root) into `process.env` without
 * overwriting variables already set in the real environment. Missing file is a
 * no-op — credentials may also come straight from the shell / CI secrets.
 */
export function loadDotEnvE2e(): void {
	try {
		// Resolve from the working dir (vitest runs from the repo root). Avoids
		// __dirname, which is undefined under ESM and would be swallowed by the
		// catch below — silently skipping every backend even with valid tokens.
		const txt = readFileSync(resolve(process.cwd(), ".env.e2e"), "utf8");
		for (const line of txt.split("\n")) {
			const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
			// `in`, not falsy: an intentionally-empty real env var must not be
			// clobbered. `.trim()` drops a trailing CR (CRLF files) / stray spaces
			// that would otherwise corrupt the token.
			if (m && m[1] && !(m[1] in process.env)) {
				process.env[m[1]] = m[2]!.trim().replace(/^['"]|['"]$/g, "");
			}
		}
	} catch {
		// No .env.e2e — rely on the real environment.
	}
}

export interface BackendCreds {
	refreshToken: string;
}

/**
 * Return the refresh token for a backend, or `null` when it is absent. A `null`
 * result is the signal for the caller to `console.warn` + `describe.skip` so the
 * run stays green (never red) without credentials.
 */
export function readCreds(envVar: string): BackendCreds | null {
	loadDotEnvE2e();
	const refreshToken = process.env[envVar];
	return refreshToken ? { refreshToken } : null;
}
