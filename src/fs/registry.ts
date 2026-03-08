import type { IBackendProvider } from "./backend";
import type { ISecretStore } from "./secret-store";
import { GoogleDriveProvider } from "./googledrive/provider";
import { GoogleDriveCustomProvider } from "./googledrive/provider-custom";

/**
 * Registry of available backend providers.
 * New backends are added here — no changes needed in main.ts or sync/.
 * Call `initRegistry()` once during plugin load to inject the secret store.
 */
let providers: IBackendProvider[] = [];
let providerMap = new Map<string, IBackendProvider>();

/** Initialize the provider registry with the given secret store. */
export function initRegistry(secretStore: ISecretStore): void {
	providers = [
		new GoogleDriveProvider(secretStore),
		new GoogleDriveCustomProvider(secretStore),
	];
	providerMap = new Map<string, IBackendProvider>();
	for (const p of providers) {
		if (providerMap.has(p.type)) continue;
		providerMap.set(p.type, p);
	}
}

/** Get a backend provider by type, or undefined if unknown */
export function getBackendProvider(
	type: string
): IBackendProvider | undefined {
	return providerMap.get(type);
}

/** Get all registered backend providers (returns a copy) */
export function getAllBackendProviders(): readonly IBackendProvider[] {
	return [...providers];
}
