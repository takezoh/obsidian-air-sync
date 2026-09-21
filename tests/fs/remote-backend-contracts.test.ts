import { describe, expect, it } from "vitest";
import {
	validateRemoteBackendCatalog,
	type RemoteBackendCatalog,
} from "./contracts/remote-backend-family";
import {
	registerGoogleDriveManagedIFileSystemContract,
	registerGoogleDriveManagedCachingContract,
	registerGoogleDriveManagedChangeDetectionContract,
	registerGoogleDriveManagedPriorityObservationContract,
	registerGoogleDriveManagedConcurrencyContract,
} from "./googledrive/managed.contract-harness";
import {
	registerDropboxManagedIFileSystemContract,
	registerDropboxManagedCachingContract,
	registerDropboxManagedChangeDetectionContract,
	registerDropboxManagedPriorityObservationContract,
	registerDropboxManagedConcurrencyContract,
} from "./dropbox/managed.contract-harness";
import {
	registerOneDriveManagedIFileSystemContract,
	registerOneDriveManagedCachingContract,
	registerOneDriveManagedChangeDetectionContract,
	registerOneDriveManagedPriorityObservationContract,
	registerOneDriveManagedConcurrencyContract,
} from "./onedrive/managed.contract-harness";

/**
 * The five contracts, for each backend's `BackendModule` + `RemoteBackendAdapter`
 * over core `ManagedRemoteFs`. This is the production path: the legacy
 * constructor-identity catalog and its direct-provider harnesses are gone (T13).
 */
const managedRemoteBackendCatalog = {
	googledrive: {
		moduleId: "googledrive",
		contracts: {
			filesystem: registerGoogleDriveManagedIFileSystemContract,
			caching: registerGoogleDriveManagedCachingContract,
			changeDetection: registerGoogleDriveManagedChangeDetectionContract,
			priorityObservation: registerGoogleDriveManagedPriorityObservationContract,
			concurrency: registerGoogleDriveManagedConcurrencyContract,
		},
	},
	dropbox: {
		moduleId: "dropbox",
		contracts: {
			filesystem: registerDropboxManagedIFileSystemContract,
			caching: registerDropboxManagedCachingContract,
			changeDetection: registerDropboxManagedChangeDetectionContract,
			priorityObservation: registerDropboxManagedPriorityObservationContract,
			concurrency: registerDropboxManagedConcurrencyContract,
		},
	},
	onedrive: {
		moduleId: "onedrive",
		contracts: {
			filesystem: registerOneDriveManagedIFileSystemContract,
			caching: registerOneDriveManagedCachingContract,
			changeDetection: registerOneDriveManagedChangeDetectionContract,
			priorityObservation: registerOneDriveManagedPriorityObservationContract,
			concurrency: registerOneDriveManagedConcurrencyContract,
		},
	},
} satisfies RemoteBackendCatalog;

const catalogIssues = validateRemoteBackendCatalog(managedRemoteBackendCatalog);

for (const [family, cell] of Object.entries(managedRemoteBackendCatalog)) {
	describe(`required managed remote contracts — ${family}`, () => {
		for (const registerContract of Object.values(cell.contracts)) registerContract();
	});
}

describe("backend module conformance catalog", () => {
	it("covers all three modules × five contracts with validated modules", () => {
		expect(catalogIssues).toEqual([]);
	});
});
