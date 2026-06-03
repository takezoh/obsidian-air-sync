// Minimal mock of obsidian module for testing

export function debounce<T extends (...args: unknown[]) => unknown>(
	fn: T,
	ms: number,
	resetTimer = true,
): T & { cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const debounced = (...args: unknown[]) => {
		if (resetTimer && timer) clearTimeout(timer);
		if (resetTimer || !timer) {
			timer = setTimeout(() => {
				timer = null;
				fn(...args);
			}, ms);
		}
	};
	debounced.cancel = () => {
		if (timer) clearTimeout(timer);
		timer = null;
	};
	return debounced as unknown as T & { cancel: () => void };
}

export const requestUrl = (_opts: unknown): Promise<unknown> => {
	// Returns a REJECTED promise (not a synchronous throw) to match the real
	// requestUrl contract — tests replace this via spyRequestUrl() before use.
	return Promise.reject(new Error("requestUrl not mocked for this test"));
};

export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

/**
 * Test hooks for driving Modal/Setting interactions without a DOM. Populated as
 * the UI renders; reset these between tests (`__ui.buttons = []; __ui.lastModal = null`).
 */
export const __ui: {
	buttons: { name: string; click: () => void }[];
	lastModal: { close: () => void } | null;
} = { buttons: [], lastModal: null };

/** Minimal stand-in for Obsidian's augmented HTMLElement (createEl/empty). */
class FakeEl {
	children: FakeEl[] = [];
	empty(): void {
		this.children = [];
	}
	createEl(_tag: string, _opts?: { text?: string; cls?: string }): FakeEl {
		const el = new FakeEl();
		this.children.push(el);
		return el;
	}
}

export class Modal {
	app: unknown;
	private _contentEl = new FakeEl();
	constructor(app: unknown) {
		this.app = app;
	}
	open() {
		// Each open starts from a clean button list, so __ui.buttons always
		// reflects only the currently-open modal (no accumulation across opens).
		__ui.buttons = [];
		__ui.lastModal = this;
		(this as unknown as { onOpen?: () => void }).onOpen?.();
	}
	close() {
		(this as unknown as { onClose?: () => void }).onClose?.();
	}
	get contentEl(): HTMLElement {
		return this._contentEl as unknown as HTMLElement;
	}
}

export class Setting {
	private _name = "";
	constructor(_containerEl: HTMLElement) {}
	setName(name: string) {
		this._name = name;
		return this;
	}
	setDesc(_desc: string) {
		return this;
	}
	setHeading() {
		return this;
	}
	addButton(cb: (b: unknown) => unknown) {
		let handler: () => void = () => {};
		const btn = {
			setButtonText: (_t: string) => btn,
			onClick: (h: () => void) => {
				handler = h;
				return btn;
			},
		};
		cb(btn);
		__ui.buttons.push({ name: this._name, click: () => handler() });
		return this;
	}
	addText(_cb: (t: unknown) => unknown) {
		return this;
	}
	addDropdown(_cb: (d: unknown) => unknown) {
		return this;
	}
	addToggle(_cb: (t: unknown) => unknown) {
		return this;
	}
	addTextArea(_cb: (t: unknown) => unknown) {
		return this;
	}
}

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isDesktopApp: true,
	isMobileApp: false,
};

export class TFile {
	path: string;
	stat: { size: number; mtime: number };
	constructor(path: string, size = 0, mtime = 0) {
		this.path = path;
		this.stat = { size, mtime };
	}
}

export class TFolder {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
}

/** In-memory Vault mock for unit tests */
export class Vault {
	private files = new Map<
		string,
		{ type: "file" | "folder"; content?: ArrayBuffer; mtime?: number }
	>();
	adapter = {
		exists: (path: string): Promise<boolean> => {
			return Promise.resolve(this.files.has(path));
		},
		stat: (
			path: string,
		): Promise<{
			type: "file" | "folder";
			size: number;
			mtime: number;
		} | null> => {
			const entry = this.files.get(path);
			if (!entry) return Promise.resolve(null);
			return Promise.resolve({
				type: entry.type,
				size: entry.content?.byteLength ?? 0,
				mtime: entry.mtime ?? 0,
			});
		},
		readBinary: async (path: string): Promise<ArrayBuffer> => {
			const entry = this.files.get(path);
			if (!entry || entry.type !== "file")
				throw new Error(`File not found: ${path}`);
			// Stays async so the not-found throw rejects.
			return await Promise.resolve(entry.content ?? new ArrayBuffer(0));
		},
		list: (
			dir: string,
		): Promise<{ files: string[]; folders: string[] }> => {
			const files: string[] = [];
			const folders: string[] = [];
			const prefix = dir + "/";
			for (const [p, entry] of this.files) {
				if (
					p.startsWith(prefix) &&
					!p.substring(prefix.length).includes("/")
				) {
					if (entry.type === "folder") folders.push(p);
					else files.push(p);
				}
			}
			return Promise.resolve({ files, folders });
		},
		writeBinary: (
			path: string,
			data: ArrayBuffer,
			options?: { mtime?: number },
		): Promise<void> => {
			this.files.set(path, {
				type: "file",
				content: data,
				mtime: options?.mtime,
			});
			return Promise.resolve();
		},
		remove: (path: string): Promise<void> => {
			this.files.delete(path);
			return Promise.resolve();
		},
		mkdir: (path: string): Promise<void> => {
			this.files.set(path, { type: "folder" });
			return Promise.resolve();
		},
		rmdir: (path: string, _recursive?: boolean): Promise<void> => {
			const prefix = path + "/";
			const toDelete: string[] = [];
			for (const key of this.files.keys()) {
				if (key === path || key.startsWith(prefix)) {
					toDelete.push(key);
				}
			}
			for (const key of toDelete) {
				this.files.delete(key);
			}
			return Promise.resolve();
		},
	};

	getName(): string {
		return "test-vault";
	}

	getAbstractFileByPath(path: string): TFile | TFolder | null {
		// Real Obsidian excludes dot-prefixed paths from the vault index
		if (path.startsWith(".")) return null;
		const entry = this.files.get(path);
		if (!entry) return null;
		if (entry.type === "folder") return new TFolder(path);
		const f = new TFile(
			path,
			entry.content?.byteLength ?? 0,
			entry.mtime ?? 0,
		);
		return f;
	}

	async createFolder(path: string): Promise<TFolder> {
		if (this.files.has(path)) {
			throw new Error("Folder already exists.");
		}
		this.files.set(path, { type: "folder" });
		// Stays async so the already-exists throw rejects.
		return await Promise.resolve(new TFolder(path));
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		const entry = this.files.get(file.path);
		if (!entry || entry.type !== "file")
			throw new Error(`File not found: ${file.path}`);
		// Stays async so the not-found throw rejects.
		return await Promise.resolve(entry.content ?? new ArrayBuffer(0));
	}

	createBinary(
		path: string,
		content: ArrayBuffer,
		options?: { mtime?: number },
	): Promise<TFile> {
		this.files.set(path, { type: "file", content, mtime: options?.mtime });
		return Promise.resolve(
			new TFile(path, content.byteLength, options?.mtime ?? 0),
		);
	}

	async modifyBinary(
		file: TFile,
		content: ArrayBuffer,
		options?: { mtime?: number },
	): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry || entry.type !== "file")
			throw new Error(`File not found: ${file.path}`);
		entry.content = content;
		if (options?.mtime !== undefined) entry.mtime = options.mtime;
		// Stays async so the not-found throw rejects.
		await Promise.resolve();
	}

	getAllLoadedFiles(): (TFile | TFolder)[] {
		const result: (TFile | TFolder)[] = [];
		for (const [path, entry] of this.files) {
			// Real Obsidian excludes dot-prefixed paths from the vault index
			if (path.startsWith(".")) continue;
			if (entry.type === "folder") {
				result.push(new TFolder(path));
			} else {
				result.push(
					new TFile(
						path,
						entry.content?.byteLength ?? 0,
						entry.mtime ?? 0,
					),
				);
			}
		}
		return result;
	}

	async rename(file: TFile | TFolder, newPath: string): Promise<void> {
		const entry = this.files.get(file.path);
		if (!entry) throw new Error(`File not found: ${file.path}`);
		this.files.delete(file.path);
		this.files.set(newPath, entry);
		// Stays async so the not-found throw rejects.
		await Promise.resolve();
	}
}

export class Workspace {
	layoutReady = true;

	onLayoutReady(cb: () => void): void {
		if (this.layoutReady) cb();
	}
}

export class App {
	vault: Vault;
	workspace: Workspace;
	fileManager = {
		trashFile: async (_file: TFile | TFolder) => {},
	};
	constructor() {
		this.vault = new Vault();
		this.workspace = new Workspace();
	}
}

export class PluginSettingTab {
	app: unknown;
	constructor(app: unknown, _plugin: unknown) {
		this.app = app;
	}
	display() {}
	get containerEl(): HTMLElement {
		return document.createElement("div");
	}
}
