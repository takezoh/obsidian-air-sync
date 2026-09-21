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
} from "./googledrive/managed.contract-harness";
import {
	registerDropboxManagedIFileSystemContract,
	registerDropboxManagedCachingContract,
	registerDropboxManagedChangeDetectionContract,
	registerDropboxManagedPriorityObservationContract,
} from "./dropbox/managed.contract-harness";
import {
	registerOneDriveManagedIFileSystemContract,
	registerOneDriveManagedCachingContract,
	registerOneDriveManagedChangeDetectionContract,
	registerOneDriveManagedPriorityObservationContract,
} from "./onedrive/managed.contract-harness";

/**
 * The four contracts, for each backend's `BackendModule` + `RemoteBackendAdapter`
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
		},
	},
	dropbox: {
		moduleId: "dropbox",
		contracts: {
			filesystem: registerDropboxManagedIFileSystemContract,
			caching: registerDropboxManagedCachingContract,
			changeDetection: registerDropboxManagedChangeDetectionContract,
			priorityObservation: registerDropboxManagedPriorityObservationContract,
		},
	},
	onedrive: {
		moduleId: "onedrive",
		contracts: {
			filesystem: registerOneDriveManagedIFileSystemContract,
			caching: registerOneDriveManagedCachingContract,
			changeDetection: registerOneDriveManagedChangeDetectionContract,
			priorityObservation: registerOneDriveManagedPriorityObservationContract,
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
	it("covers all three modules × four contracts with validated modules", () => {
		expect(catalogIssues).toEqual([]);
	});
});
