import { describe, expect, it } from "vitest";
import {
	AuthCancelledError,
	createAuthHost,
} from "../../src/fs/modules/auth-host";

function host(generation: number, live: (generation: number) => boolean = () => true) {
	const opened: string[] = [];
	return {
		opened,
		controller: createAuthHost({
			generation,
			isCurrentGeneration: live,
			openUrl: (url) => {
				opened.push(url);
			},
		}),
	};
}

describe("createAuthHost", () => {
	it("opens the external URL for the current generation", async () => {
		const { controller, opened } = host(1);
		await controller.openExternal("https://auth.example/?state=s1");
		expect(opened).toEqual(["https://auth.example/?state=s1"]);
	});

	it("rejects openExternal once the generation is no longer live", async () => {
		const { controller } = host(1, () => false);
		await expect(controller.openExternal("https://auth.example/")).rejects.toBeInstanceOf(
			AuthCancelledError,
		);
	});

	it("rejects openExternal after teardown and is idempotent", async () => {
		const { controller, opened } = host(1);
		controller.cancelAll();
		controller.cancelAll();
		await expect(controller.openExternal("https://auth.example/")).rejects.toBeInstanceOf(
			AuthCancelledError,
		);
		expect(opened).toEqual([]);
	});
});
