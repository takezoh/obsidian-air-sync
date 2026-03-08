import { getBackendData } from "../backend";
import type { SmartSyncSettings } from "../../settings";
import type { Logger } from "../../logging/logger";
import { GoogleAuth } from "./auth";
import type { IGoogleAuth } from "./auth";
import { GoogleDriveAuthProviderBase, GoogleDriveProviderBase } from "./provider-base";

/** All data stored in backendData["googledrive"] */
export interface GoogleDriveBackendData {
	remoteVaultFolderId: string;
	lastKnownVaultName: string;
	refreshToken: string;
	accessToken: string;
	accessTokenExpiry: number;
	changesStartPageToken: string;
	pendingAuthState: string;
}

const DEFAULT_GDRIVE_DATA: GoogleDriveBackendData = {
	remoteVaultFolderId: "",
	lastKnownVaultName: "",
	refreshToken: "",
	accessToken: "",
	accessTokenExpiry: 0,
	changesStartPageToken: "",
	pendingAuthState: "",
};

/** Type-safe accessor for Google Drive backend data */
function getGDriveData(settings: SmartSyncSettings): GoogleDriveBackendData {
	return {
		...DEFAULT_GDRIVE_DATA,
		...getBackendData<GoogleDriveBackendData>(settings, "googledrive"),
	};
}

/**
 * Google Drive authentication provider (built-in OAuth via auth server).
 */
export class GoogleDriveAuthProvider extends GoogleDriveAuthProviderBase {
	protected createAuth(_backendData: Record<string, unknown>): IGoogleAuth {
		this.googleAuth = new GoogleAuth();
		return this.googleAuth;
	}

	protected createAuthIfNeeded(_backendData: Record<string, unknown>): IGoogleAuth {
		if (!this.googleAuth) {
			this.googleAuth = new GoogleAuth();
		}
		return this.googleAuth;
	}

	getOrCreateGoogleAuth(data: GoogleDriveBackendData, logger?: Logger): IGoogleAuth {
		if (
			!this.googleAuth ||
			this.googleAuth.getTokenState().refreshToken !== data.refreshToken
		) {
			this.googleAuth = new GoogleAuth(logger);
		}
		return this.googleAuth;
	}
}

/**
 * Google Drive backend provider (built-in OAuth).
 */
export class GoogleDriveProvider extends GoogleDriveProviderBase {
	readonly type = "googledrive";
	readonly displayName = "Google Drive";
	readonly auth: GoogleDriveAuthProvider;

	constructor() {
		super();
		this.auth = new GoogleDriveAuthProvider();
	}

	protected getData(settings: SmartSyncSettings): GoogleDriveBackendData {
		return getGDriveData(settings);
	}

	protected getDefaultData(): GoogleDriveBackendData {
		return DEFAULT_GDRIVE_DATA;
	}
}
