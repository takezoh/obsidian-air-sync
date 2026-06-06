import type { ISecretStore } from "./secret-store";

/**
 * Deterministic SecretStorage key for a backend secret.
 *
 * The format is intentionally stable (`air-sync-<type>-<name>-token`) so that
 * secrets stored by earlier versions survive this generalization — existing
 * users do not need to reconnect.
 */
function secretKey(backendType: string, name: string): string {
	return `air-sync-${backendType}-${name}-token`;
}

/**
 * Store an opaque secret for a backend under the given name.
 *
 * Empty values are skipped (a backend may not have every secret, e.g. pCloud
 * has no refresh token). Use {@link clearBackendSecrets} to remove a secret.
 */
export function setBackendSecret(store: ISecretStore, backendType: string, name: string, value: string): void {
	if (value) {
		store.setSecret(secretKey(backendType, name), value);
	}
}

/** Read an opaque backend secret, or `""` if absent. */
export function getBackendSecret(store: ISecretStore, backendType: string, name: string): string {
	return store.getSecret(secretKey(backendType, name)) ?? "";
}

/** Whether a backend secret of the given name is present. */
export function hasBackendSecret(store: ISecretStore, backendType: string, name: string): boolean {
	return !!store.getSecret(secretKey(backendType, name));
}

/** Clear the named backend secrets. */
export function clearBackendSecrets(store: ISecretStore, backendType: string, names: string[]): void {
	for (const name of names) {
		store.setSecret(secretKey(backendType, name), "");
	}
}
