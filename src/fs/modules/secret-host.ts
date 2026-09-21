import type { BackendSecretStore } from "../../backend-api";
import type { ISecretStore } from "../secret-store";

/**
 * Maps a module's logical secret key to a physical SecretStorage key. Core owns
 * the mapping so existing physical keys survive a module-id change; the module
 * never sees a physical name and cannot enumerate or reach another namespace.
 */
export type PhysicalKeyResolver = (moduleId: string, logicalKey: string) => string;

/**
 * The compatibility default: `air-sync-<moduleId>-<logicalKey>-token`, which is
 * exactly the existing built-in key format (`air-sync-googledrive-access-token`).
 * Custom OAuth profiles supply their own resolver at migration time.
 */
export const defaultPhysicalKey: PhysicalKeyResolver = (moduleId, logicalKey) =>
	`air-sync-${moduleId}-${logicalKey}-token`;

/** Build a module-scoped secret store over the host's physical SecretStorage. */
export function createSecretHost(
	store: ISecretStore,
	moduleId: string,
	resolve: PhysicalKeyResolver = defaultPhysicalKey,
): BackendSecretStore {
	const physical = (logicalKey: string): string => resolve(moduleId, logicalKey);
	return {
		get: (logicalKey) => Promise.resolve(store.getSecret(physical(logicalKey))),
		set: (logicalKey, value) => {
			store.setSecret(physical(logicalKey), value);
			return Promise.resolve();
		},
		delete: (logicalKey) => {
			store.setSecret(physical(logicalKey), "");
			return Promise.resolve();
		},
	};
}

/**
 * A module-scoped secret store that also records every logical key the module
 * touched (read, write, or delete). Core owns disconnect; because SecretStorage
 * has no enumeration, this is how the disconnect sequence learns which logical
 * keys to clear without widening the public `BackendSecretStore` with an
 * enumeration it must not have. Tracking reads as well as writes means a
 * disconnect in a later session still clears credentials the module resolved.
 * The physical keys (and therefore existing stored secrets) are unchanged.
 */
export interface TrackedSecretStore extends BackendSecretStore {
	readonly touchedKeys: ReadonlySet<string>;
}

/** Build a tracking secret store; see {@link TrackedSecretStore}. */
export function createTrackedSecretHost(
	store: ISecretStore,
	moduleId: string,
	resolve: PhysicalKeyResolver = defaultPhysicalKey,
): TrackedSecretStore {
	const base = createSecretHost(store, moduleId, resolve);
	const touched = new Set<string>();
	return {
		get: (logicalKey) => {
			touched.add(logicalKey);
			return base.get(logicalKey);
		},
		set: (logicalKey, value) => {
			touched.add(logicalKey);
			return base.set(logicalKey, value);
		},
		delete: (logicalKey) => {
			touched.add(logicalKey);
			return base.delete(logicalKey);
		},
		touchedKeys: touched,
	};
}
