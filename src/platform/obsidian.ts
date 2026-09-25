import * as obsidianRuntime from "obsidian";

/**
 * The community scanner can analyse a submission without installing package
 * dependencies.  Keep that environment from turning every Obsidian API value
 * into the TypeScript `error` type by terminating the untyped boundary here.
 * Runtime values are still loaded from Obsidian; application code only sees the
 * small, first-party contracts below.
 */

declare global {
	interface HTMLElement {
		addClass(...classes: string[]): void;
		createDiv(options?: DomElementOptions | string): HTMLDivElement;
		createEl<K extends keyof HTMLElementTagNameMap>(
			tag: K,
			options?: DomElementOptions | string,
		): HTMLElementTagNameMap[K];
		empty(): void;
		setText(text: string): void;
	}
	interface DocumentFragment {
		appendText(text: string): void;
		createEl<K extends keyof HTMLElementTagNameMap>(
			tag: K,
			options?: DomElementOptions | string,
		): HTMLElementTagNameMap[K];
	}
}

interface DomElementOptions {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, string>;
}

export interface EventRef {
	readonly _eventRefBrand?: never;
}

export interface DataAdapterStat {
	type: "file" | "folder";
	ctime: number;
	mtime: number;
	size: number;
}

export interface DataAdapter {
	exists(path: string, sensitive?: boolean): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string, options?: { ctime?: number; mtime?: number }): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	stat(path: string): Promise<DataAdapterStat | null>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer, options?: { ctime?: number; mtime?: number }): Promise<void>;
	mkdir(path: string): Promise<void>;
	remove(path: string): Promise<void>;
	rmdir(path: string, recursive: boolean): Promise<void>;
}

export interface TAbstractFile {
	path: string;
	name: string;
	parent: TFolder | null;
}

export interface TFile extends TAbstractFile {
	stat: { ctime: number; mtime: number; size: number };
	basename: string;
	extension: string;
}

export interface TFolder extends TAbstractFile {
	children: TAbstractFile[];
}

type TFileConstructor = new (...args: never[]) => TFile;
type TFolderConstructor = new (...args: never[]) => TFolder;

export interface Vault {
	adapter: DataAdapter;
	configDir: string;
	getName(): string;
	getAllLoadedFiles(): TAbstractFile[];
	getAbstractFileByPath(path: string): TAbstractFile | null;
	readBinary(file: TFile): Promise<ArrayBuffer>;
	modifyBinary(file: TFile, data: ArrayBuffer, options?: { ctime?: number; mtime?: number }): Promise<void>;
	createBinary(path: string, data: ArrayBuffer, options?: { ctime?: number; mtime?: number }): Promise<TFile>;
	createFolder(path: string): Promise<TFolder>;
	rename(file: TAbstractFile, newPath: string): Promise<void>;
	on(name: "create" | "modify" | "delete", callback: (file: TAbstractFile) => unknown): EventRef;
	on(name: "rename", callback: (file: TAbstractFile, oldPath: string) => unknown): EventRef;
}

export interface Workspace {
	layoutReady: boolean;
	onLayoutReady(callback: () => unknown): void;
	on(name: "file-open", callback: (file: TFile | null) => unknown): EventRef;
}

export interface App {
	vault: Vault;
	workspace: Workspace;
	fileManager: { trashFile(file: TAbstractFile): Promise<void> };
	secretStorage: {
		getSecret(key: string): string | null;
		setSecret(key: string, value: string): void;
	};
}

export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: unknown;
	text: string;
}

export interface TextComponent {
	setPlaceholder(value: string): this;
	setValue(value: string): this;
	setDisabled(disabled: boolean): this;
	onChange(callback: (value: string) => unknown): this;
}

export type TextAreaComponent = TextComponent;

export interface ToggleComponent {
	setValue(value: boolean): this;
	setDisabled(disabled: boolean): this;
	onChange(callback: (value: boolean) => unknown): this;
}

export interface DropdownComponent {
	addOption(value: string, display: string): this;
	setValue(value: string): this;
	setDisabled(disabled: boolean): this;
	onChange(callback: (value: string) => unknown): this;
}

export interface ButtonComponent {
	setButtonText(value: string): this;
	setCta(): this;
	setDisabled(disabled: boolean): this;
	onClick(callback: () => unknown): this;
}

export type SecretComponent = TextComponent;

type SecretComponentConstructor = new (app: App, containerEl: HTMLElement) => SecretComponent;

export interface Setting {
	settingEl: HTMLElement;
	setName(name: string | DocumentFragment): this;
	setDesc(desc: string | DocumentFragment): this;
	setHeading(): this;
	addText(callback: (component: TextComponent) => unknown): this;
	addTextArea(callback: (component: TextAreaComponent) => unknown): this;
	addToggle(callback: (component: ToggleComponent) => unknown): this;
	addDropdown(callback: (component: DropdownComponent) => unknown): this;
	addButton(callback: (component: ButtonComponent) => unknown): this;
	addComponent(callback: (containerEl: HTMLElement) => unknown): this;
}

type SettingConstructor = new (containerEl: HTMLElement) => Setting;

export interface Modal {
	contentEl: HTMLElement;
	setTitle(title: string): this;
	open(): void;
	close(): void;
	onOpen(): void | Promise<void>;
	onClose(): void;
}

type ModalConstructor = new (app: App) => Modal;

export type SettingDefinitionItem = Record<string, unknown>;

export interface PluginSettingTab {
	app: App;
	containerEl: HTMLElement;
}

type PluginSettingTabConstructor = new (app: App, plugin: Plugin) => PluginSettingTab;

export interface Plugin {
	app: App;
	manifest: { id: string; version?: string };
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
	register(callback: () => unknown): void;
	registerEvent(ref: EventRef): void;
	registerDomEvent<K extends keyof WindowEventMap>(el: Window, type: K, callback: (event: WindowEventMap[K]) => unknown): void;
	registerDomEvent<K extends keyof DocumentEventMap>(el: Document, type: K, callback: (event: DocumentEventMap[K]) => unknown): void;
	registerDomEvent<K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, callback: (event: HTMLElementEventMap[K]) => unknown): void;
	registerObsidianProtocolHandler(action: string, callback: (params: Record<string, string>) => unknown): void;
	addCommand(command: { id: string; name: string; callback: () => unknown }): void;
	addStatusBarItem(): HTMLElement;
	addSettingTab(tab: PluginSettingTab): void;
}

type PluginConstructor = new (...args: never[]) => Plugin;
type NoticeConstructor = new (message: string | DocumentFragment, timeout?: number) => { readonly noticeEl?: HTMLElement };

const runtimeValue: unknown = obsidianRuntime;

function runtimeRecord(): Record<string, unknown> {
	if (typeof runtimeValue === "object" && runtimeValue !== null) {
		return runtimeValue as Record<string, unknown>;
	}
	throw new Error("Obsidian runtime module is unavailable");
}

function runtimeExport(name: string): unknown {
	return runtimeRecord()[name];
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

function requireCallable(name: string): (...args: unknown[]) => unknown {
	const value = runtimeExport(name);
	if (isCallable(value)) return value;
	throw new Error(`Obsidian runtime export ${name} is not callable`);
}

function requireConstructor<T>(name: string): T {
	const value = runtimeExport(name);
	if (typeof value !== "function") {
		throw new Error(`Obsidian runtime export ${name} is not a constructor`);
	}
	return value as T;
}

export const TFile = requireConstructor<TFileConstructor>("TFile");
export const TFolder = requireConstructor<TFolderConstructor>("TFolder");
export const Notice = requireConstructor<NoticeConstructor>("Notice");
export const Setting = requireConstructor<SettingConstructor>("Setting");
export const SecretComponent = requireConstructor<SecretComponentConstructor>("SecretComponent");
export const Modal = requireConstructor<ModalConstructor>("Modal");
export const PluginSettingTab = requireConstructor<PluginSettingTabConstructor>("PluginSettingTab");
export const Plugin = requireConstructor<PluginConstructor>("Plugin");

const platform = runtimeExport("Platform");
export const Platform: { readonly isMobile: boolean } =
	typeof platform === "object" && platform !== null && "isMobile" in platform
		? { isMobile: platform.isMobile === true }
		: { isMobile: false };

export async function requestUrl(params: RequestUrlParam): Promise<RequestUrlResponse> {
	const result = await Promise.resolve(requireCallable("requestUrl")(params));
	if (typeof result !== "object" || result === null) {
		throw new Error("Obsidian requestUrl returned an invalid response");
	}
	const response = result as Record<string, unknown>;
	if (
		typeof response.status !== "number" ||
		typeof response.headers !== "object" ||
		response.headers === null
	) {
		throw new Error("Obsidian requestUrl returned an invalid response shape");
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(response.headers)) {
		if (typeof value === "string") headers[key] = value;
	}
	return {
		status: response.status,
		headers,
		get arrayBuffer(): ArrayBuffer {
			const value = response.arrayBuffer;
			if (!(value instanceof ArrayBuffer)) {
				throw new Error("Obsidian requestUrl returned an invalid response shape");
			}
			return value;
		},
		get json(): unknown {
			return response.json;
		},
		get text(): string {
			const value = response.text;
			if (typeof value !== "string") {
				throw new Error("Obsidian requestUrl returned an invalid response shape");
			}
			return value;
		},
	};
}

export function debounce<T extends (...args: never[]) => unknown>(
	callback: T,
	wait: number,
	immediate?: boolean,
): T & { cancel(): void } {
	const value = requireCallable("debounce")(callback, wait, immediate);
	if (!isCallable(value) || !("cancel" in value) || typeof value.cancel !== "function") {
		throw new Error("Obsidian debounce returned an invalid function");
	}
	return value as T & { cancel(): void };
}

export function setIcon(parent: HTMLElement, iconId: string): void {
	requireCallable("setIcon")(parent, iconId);
}

export function setTooltip(
	parent: HTMLElement,
	tooltip: string | DocumentFragment,
	options?: { placement?: "top" | "right" | "bottom" | "left" },
): void {
	requireCallable("setTooltip")(parent, tooltip, options);
}

export function createFragment(): DocumentFragment {
	const globals: unknown = window;
	if (typeof globals !== "object" || globals === null) {
		throw new Error("Obsidian createFragment global is unavailable");
	}
	const candidate: unknown = (globals as Record<string, unknown>).createFragment;
	if (!isCallable(candidate)) throw new Error("Obsidian createFragment global is unavailable");
	const fragment = candidate();
	if (fragment instanceof DocumentFragment) return fragment;
	throw new Error("Obsidian createFragment returned an invalid fragment");
}
