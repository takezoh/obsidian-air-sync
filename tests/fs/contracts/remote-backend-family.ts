import type { BackendModule } from "../../../src/backend-api";
import { googleDriveModule } from "../../../src/fs/googledrive/module";
import { oneDriveModule } from "../../../src/fs/onedrive/module";
import { dropboxModule } from "../../../src/fs/dropbox/module";
import { BackendModuleRegistry } from "../../../src/fs/modules/registry";

/**
 * The three canonical backend modules, each keyed by its own id. This is the
 * module-definition catalog: a cell is addressed by the module's validated id, not
 * by a filesystem constructor, so the same catalog works for a future external
 * module that never subclasses a core filesystem.
 */
export const REMOTE_BACKEND_MODULES = {
	googledrive: googleDriveModule,
	onedrive: oneDriveModule,
	dropbox: dropboxModule,
} as const satisfies Readonly<Record<string, BackendModule>>;

export type RemoteBackendFamily = keyof typeof REMOTE_BACKEND_MODULES;

/** The canonical ids, in catalog order. */
export const MANAGED_REMOTE_BACKEND_FAMILIES = Object.keys(
	REMOTE_BACKEND_MODULES,
) as readonly RemoteBackendFamily[];

/** The four contracts every backend module must satisfy through `ManagedRemoteFs`. */
export const REMOTE_BACKEND_CONTRACT_KINDS = [
	"filesystem",
	"caching",
	"changeDetection",
	"priorityObservation",
] as const;

export type RemoteBackendContractKind = (typeof REMOTE_BACKEND_CONTRACT_KINDS)[number];

/**
 * One backend's conformance cell: the module whose REAL adapter the harnesses build
 * from, plus the registration for each required contract. `moduleId` is asserted
 * against the catalog key so a mis-registered adapter (e.g. Google's wiring in the
 * Dropbox cell) is a guard failure, not a silently green contract.
 */
export interface RemoteBackendCatalogCell {
	readonly moduleId: string;
	readonly contracts: Readonly<Record<RemoteBackendContractKind, unknown>>;
}

export type RemoteBackendCatalog = Readonly<Record<RemoteBackendFamily, RemoteBackendCatalogCell>>;

/**
 * Validate the conformance catalog: every required module is present and registerable
 * through the real registry, each cell names the module it exercises, and every cell
 * declares all four contracts. Returns human-readable issues (empty = valid). Kept
 * pure so a mutation witness can assert the guard goes RED without a build.
 */
export function validateRemoteBackendCatalog(catalog: RemoteBackendCatalog): readonly string[] {
	const issues: string[] = [];
	const families = Object.keys(catalog).sort();
	const expected = [...MANAGED_REMOTE_BACKEND_FAMILIES].sort();
	if (families.join(",") !== expected.join(",")) {
		issues.push(`catalog families ${families.join(",")} !== required ${expected.join(",")}`);
	}

	const registry = new BackendModuleRegistry();
	for (const family of MANAGED_REMOTE_BACKEND_FAMILIES) {
		const module = REMOTE_BACKEND_MODULES[family];
		if (module.id !== family) {
			issues.push(`module registered at key "${family}" has id "${module.id}"`);
		}
		const registration = registry.register(module);
		if (!registration.ok) {
			issues.push(`module "${family}" failed registry validation: ${registration.issues.map((i) => i.code).join(",")}`);
		}
		const cell = catalog[family];
		if (!cell) continue;
		if (cell.moduleId !== family) {
			issues.push(`cell "${family}" exercises module "${cell.moduleId}"`);
		}
		for (const kind of REMOTE_BACKEND_CONTRACT_KINDS) {
			if (!(kind in cell.contracts)) issues.push(`cell "${family}" is missing the "${kind}" contract`);
		}
	}
	return issues;
}

/** The six auth cases: three modules × built-in/custom OAuth. */
export const REMOTE_BACKEND_AUTH_CASES = MANAGED_REMOTE_BACKEND_FAMILIES.flatMap((moduleId) =>
	(["default", "custom"] as const).map((authMode) => ({ moduleId, authMode })),
);
