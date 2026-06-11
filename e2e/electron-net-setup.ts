/**
 * vitest globalSetup for the opt-in e2e (ADR 0003): launch the Electron `net` host
 * (`electron-net-host.cjs`) once for the whole run and tear it down after. Every
 * `requestUrl` in the e2e is delegated to it (see `request-url.ts`) so the suite runs
 * on the real desktop engine, not fetch.
 *
 * On headless Linux the Electron binary needs a display and a sandbox opt-out, so it is
 * launched via `xvfb-run -a … --no-sandbox`. On a machine with a display (a dev's
 * macOS/Windows/Linux desktop) it runs the binary directly.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import http from "node:http";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.AIRSYNC_E2E_ELECTRON_NET_PORT || 39271);
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;

let child: ChildProcess | undefined;

function pingHealth(): Promise<boolean> {
	return new Promise((resolve) => {
		const req = http.get(HEALTH_URL, (res) => {
			res.resume();
			resolve(res.statusCode === 200);
		});
		req.on("error", () => resolve(false));
		req.setTimeout(1000, () => {
			req.destroy();
			resolve(false);
		});
	});
}

async function waitForHealth(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	// Date.now() is fine here: this is e2e tooling outside src/, not a pure transform.
	while (Date.now() < deadline) {
		if (await pingHealth()) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`Electron net host did not become healthy at ${HEALTH_URL} within ${timeoutMs}ms`);
}

export async function setup(): Promise<void> {
	// `require('electron')` from Node returns the path to the Electron binary.
	const electronPath = require("electron") as string;
	const hostScript = resolve(here, "electron-net-host.cjs");
	const headless = process.platform === "linux" && !process.env.DISPLAY;
	const cmd = headless ? "xvfb-run" : electronPath;
	const args = headless
		? ["-a", electronPath, hostScript, "--no-sandbox"]
		: [hostScript, "--no-sandbox"];

	// `detached` makes the child a process-group leader so teardown can kill the WHOLE
	// group (xvfb-run → electron → its zygote/gpu/network children) with one signal —
	// a plain SIGTERM to xvfb-run leaves the electron children orphaned.
	child = spawn(cmd, args, { stdio: "inherit", env: process.env, detached: true });
	// Without this, an ENOENT (xvfb-run or electron not installed) surfaces only as a
	// 30s "did not become healthy" timeout — point straight at the missing binary instead.
	child.on("error", (err) => {
		console.error(`[e2e] failed to launch the Electron net host via "${cmd}": ${err.message}`);
	});
	child.on("exit", (code) => {
		if (code && code !== 0) {
			// Surface a host crash; tests will then fail loudly on the unreachable host.
			console.error(`[e2e] Electron net host exited with code ${code}`);
		}
	});
	await waitForHealth(30_000);
}

export async function teardown(): Promise<void> {
	if (!child?.pid) return;
	// Negative pid → signal the whole process group (electron + its children), not just
	// the xvfb-run wrapper. Fall back to a direct kill if the group is already gone.
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already exited */
		}
	}
}
