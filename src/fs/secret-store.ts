/**
 * Lightweight interface abstracting secret storage.
 * Providers receive this via constructor injection instead of `App`,
 * keeping the backend layer free of Obsidian-specific imports.
 */
export interface ISecretStore {
	getSecret(key: string): string | null;
	setSecret(key: string, value: string): void;
}
