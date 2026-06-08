import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			// Ratchet floors: set a few points below current coverage so a
			// regression fails CI, while leaving headroom for refactors. Raise
			// these as coverage improves — do not lower them to make CI pass.
			thresholds: {
				lines: 76,
				statements: 75,
				functions: 70,
				branches: 65,
			},
			// Production code only: exclude tests, test doubles, shared test
			// contracts, pure-type modules, and build/config files.
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/**/*.d.ts",
				"src/__mocks__/**",
				"src/**/test-helpers.ts",
				"src/fs/remote-change-detection-contract.ts",
				"src/fs/caching/remote-fs-contract.ts",
				"src/**/types.ts",
				"src/main.ts",
			],
		},
	},
	resolve: {
		alias: {
			obsidian: "./src/__mocks__/obsidian.ts",
		},
	},
});
