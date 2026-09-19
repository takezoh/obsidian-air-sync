import { describe, it, expect } from "vitest";
import { renderBoundFolderField } from "./backend-settings-ui";
import type { Setting } from "../platform/obsidian";

function fakeSetting() {
	const descriptions: string[] = [];
	const values: string[] = [];
	const setting = {
		setDesc: (d: string) => {
			descriptions.push(d);
			return setting;
		},
		addText: (cb: (t: unknown) => unknown) => {
			const text = {
				setValue: (v: string) => {
					values.push(v);
					return text;
				},
				setDisabled: () => text,
			};
			cb(text);
			return setting;
		},
	} as unknown as Setting;
	return { setting, descriptions, values };
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("renderBoundFolderField", () => {
	it("shows the id first, then replaces it with the resolved path", async () => {
		const { setting, values } = fakeSetting();
		renderBoundFolderField(setting, {
			desc: "desc",
			folderId: "FID",
			resolvePath: () => Promise.resolve({ path: "Work/Notes" }),
		});
		await flush();
		expect(values).toEqual(["FID", "Work/Notes"]);
	});

	it("replaces the description with the warning for a present-but-unusable folder", async () => {
		const { setting, descriptions, values } = fakeSetting();
		renderBoundFolderField(setting, {
			desc: "desc",
			folderId: "FID",
			resolvePath: () => Promise.resolve({ path: "MyVault", warning: "This folder is in Google Drive's Trash." }),
		});
		await flush();
		expect(values).toEqual(["FID", "MyVault"]);
		expect(descriptions).toEqual(["desc", "This folder is in Google Drive's Trash."]);
	});
});
