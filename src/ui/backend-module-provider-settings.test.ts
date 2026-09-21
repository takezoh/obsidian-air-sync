import { beforeEach, describe, expect, it, vi } from "vitest";
import { __ui } from "../__mocks__/obsidian";
import { BackendModuleSettingsRenderer } from "./backend-module-provider-settings";
import type { BackendModuleProvider } from "../fs/modules/backend-module-provider";
import type { BackendConnectionActions } from "../fs/settings-renderer";
import type { AirSyncSettings } from "../settings";
import { mockSettings } from "../__mocks__/sync-test-helpers";
import { createFakeModule } from "../../tests/backend-api/fake-module";

vi.mock("obsidian");

beforeEach(() => {
	__ui.buttons = [];
	__ui.notices = [];
});

/** A container whose `createDiv()` returns a clearable child, as the renderer expects. */
function container(): HTMLElement {
	const child = { empty: () => undefined } as unknown as HTMLElement;
	return { createDiv: () => child } as unknown as HTMLElement;
}

/** A fake provider whose module declares the two required custom credentials. */
function customAppRenderer(hasCredentials: boolean): BackendModuleSettingsRenderer {
	const module = createFakeModule({
		settings: {
			fields: [
				{ key: "customClientId", label: "Client ID", type: "text" },
				{ key: "customClientSecret", label: "Client secret", type: "text" },
			],
		},
	});
	const provider = {
		type: module.id,
		getModule: () => module,
		hasCredentials: () => hasCredentials,
	} as unknown as BackendModuleProvider;
	return new BackendModuleSettingsRenderer(provider);
}

function actionsSpy(): { actions: BackendConnectionActions; startAuth: ReturnType<typeof vi.fn> } {
	const startAuth = vi.fn().mockResolvedValue(undefined);
	const actions = {
		startAuth,
		completeAuth: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		refreshDisplay: vi.fn(),
		startFolderPick: vi.fn().mockResolvedValue(undefined),
		bindDefaultFolder: vi.fn().mockResolvedValue(undefined),
	} as unknown as BackendConnectionActions;
	return { actions, startAuth };
}

function connectButton(): { name: string; click: () => void } {
	const button = __ui.buttons.find((item) => item.name === "Connection status");
	if (!button) throw new Error("connection-status button was not rendered");
	return button;
}

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

/**
 * Public action path: the rendered Connect button must route through the module's
 * custom-app guard before opening the browser. The guard was lost once already, so
 * this drives the actual button rather than calling the private helper.
 */
describe("BackendModuleSettingsRenderer — custom-app connect guard", () => {
	it("does not start auth when a required custom credential is absent, and notifies", () => {
		const settings = mockSettings({
			backendType: "fakebackend",
			backendData: { authMode: true },
		});
		const { actions, startAuth } = actionsSpy();

		customAppRenderer(false).render(
			container(),
			settings,
			() => Promise.resolve(),
			actions,
			{} as never,
		);

		connectButton().click();

		expect(startAuth).not.toHaveBeenCalled();
		expect(__ui.notices).toContain("Client ID is required");
	});

	it("starts auth when authMode is custom and every required field is present", () => {
		const settings = mockSettings({
			backendType: "fakebackend",
			backendData: { authMode: true, customClientId: "id", customClientSecret: "name" },
		});
		const { actions, startAuth } = actionsSpy();

		customAppRenderer(false).render(
			container(),
			settings,
			() => Promise.resolve(),
			actions,
			{} as never,
		);

		connectButton().click();

		expect(startAuth).toHaveBeenCalledTimes(1);
		expect(__ui.notices).toHaveLength(0);
	});
});
