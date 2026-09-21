import { describe, expect, it, vi } from "vitest";
import { BackendModuleSettingsRenderer } from "./backend-module-provider-settings";
import type { BackendModuleProvider } from "../fs/modules/backend-module-provider";
import type { AirSyncSettings } from "../settings";
import { createFakeModule } from "../../tests/backend-api/fake-module";

vi.mock("obsidian");

/**
 * Regression: the module settings renderer must not clear the whole settings tab.
 * `renderBackendSettings` empties the container it is given on every re-render, so
 * handing it the tab erased the global sections drawn above it (conflict strategy,
 * remote-backend selector).
 */
describe("BackendModuleSettingsRenderer — container ownership", () => {
	it("renders module fields into a child container and never empties the tab", () => {
		const childEmpty = vi.fn();
		const child = { empty: childEmpty } as unknown as HTMLElement;
		const rootEmpty = vi.fn();
		const createDiv = vi.fn(() => child);
		const root = { empty: rootEmpty, createDiv } as unknown as HTMLElement;

		const module = createFakeModule();
		const provider = {
			type: module.id,
			getModule: () => module,
			hasCredentials: () => false,
		} as unknown as BackendModuleProvider;

		new BackendModuleSettingsRenderer(provider).render(
			root,
			{ backendData: {} } as unknown as AirSyncSettings,
			() => Promise.resolve(),
			{} as never,
			{} as never,
		);

		expect(createDiv).toHaveBeenCalled();
		// The declarative fields are cleared/redrawn inside their own child container.
		expect(childEmpty).toHaveBeenCalled();
		// The tab itself is never cleared, so the global sections survive.
		expect(rootEmpty).not.toHaveBeenCalled();
	});
});
