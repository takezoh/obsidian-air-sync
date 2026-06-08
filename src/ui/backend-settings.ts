import { getBackendProvider } from "../fs/registry";
import type { IBackendSettingsRenderer } from "../fs/settings-renderer";

/**
 * Resolve a backend's settings renderer by type. There is no separate renderer
 * registry: each backend supplies its renderer via
 * {@link IBackendProvider.createSettingsRenderer}, so the `fs/registry` provider
 * list is the single source of truth — no parallel UI-side array to keep in sync by
 * hand (the previous duplication, guarded only by an integrity test).
 */
export function getBackendSettingsRenderer(type: string): IBackendSettingsRenderer | undefined {
	return getBackendProvider(type)?.createSettingsRenderer?.();
}
