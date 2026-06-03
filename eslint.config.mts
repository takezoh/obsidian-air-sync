import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				process: "readonly",
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json',
						'vitest.config.ts'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Keep the vault index read centralized in LocalFs so there is a single,
		// layout-ready-gated entry point. getAllLoadedFiles() is an in-memory
		// snapshot that can under-report before the vault finishes loading.
		files: ["src/**/*.ts"],
		ignores: ["src/fs/local/**", "src/__mocks__/**"],
		rules: {
			"no-restricted-syntax": [
				"error",
				{
					selector: "CallExpression[callee.property.name='getAllLoadedFiles']",
					message: "Read the vault index via LocalFs.list() — getAllLoadedFiles() is only allowed in src/fs/local/.",
				},
			],
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
