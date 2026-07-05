import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tmpRoot = mkdtempSync(join(tmpdir(), "airsync-bot-lint-"));
const targets = [
	"src/fs/dropbox/client.ts",
	"src/fs/dropbox/types.ts",
	"src/fs/googledrive/provider-base.ts",
	"src/fs/googledrive/test-helpers.ts",
	"src/fs/headers.ts",
	"src/fs/onedrive/types.ts",
	"src/main.ts",
	"src/utils/hash.ts",
	"src/fs/errors.ts",
	"src/fs/googledrive/errors.ts",
	"src/fs/ifilesystem-contract.ts",
	"src/store/content-codec.ts",
];

const packageSpecs = [
	`eslint@${process.env.BOT_REPRO_ESLINT ?? "latest"}`,
	`typescript-eslint@${process.env.BOT_REPRO_TYPESCRIPT_ESLINT ?? "latest"}`,
	`eslint-plugin-obsidianmd@${process.env.BOT_REPRO_OBSIDIANMD ?? "latest"}`,
	`typescript@${process.env.BOT_REPRO_TYPESCRIPT ?? "latest"}`,
	`@eslint/js@${process.env.BOT_REPRO_ESLINT_JS ?? "latest"}`,
	`globals@${process.env.BOT_REPRO_GLOBALS ?? "latest"}`,
	`obsidian@${process.env.BOT_REPRO_OBSIDIAN ?? "latest"}`,
];

function run(cmd, args, cwd) {
	const result = spawnSync(cmd, args, {
		cwd,
		stdio: "inherit",
		env: process.env,
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

try {
	for (const file of ["package.json", "eslint.config.mts", "tsconfig.json", "manifest.json"]) {
		cpSync(resolve(root, file), resolve(tmpRoot, file));
	}
	symlinkSync(resolve(root, "src"), resolve(tmpRoot, "src"), "dir");

	run("npm", ["install", "--package-lock=false", "--no-save", ...packageSpecs], tmpRoot);
	run("npx", ["eslint", "--quiet", ...targets], tmpRoot);
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}
