import type {
	BackendAuth,
	BackendBinding,
	BackendModule,
	BackendRuntimeContext,
	BackendSettingsDefinition,
	BindingResult,
	JsonObject,
	JsonPatch,
	RemoteBackendAdapter,
} from "../../backend-api";
import { BACKEND_MODULE_API_VERSION } from "../../backend-api";
import { GoogleAuth, GoogleAuthDirect } from "./auth";
import type { IGoogleAuth } from "./auth";
import { GoogleDriveClient } from "./client";
import { GoogleDriveAdapter } from "./adapter";
import { withAdapterState } from "../shared/adapter-state";
import { createContextTransport } from "../../backend-api/http-transport";
import { asString, resolveFolderTarget } from "../shared/module-utils";
import { parseAuthCallbackParams } from "./auth-callback";
import { resolveGoogleDriveRemoteVault } from "./remote-vault";
import { resolveFolderPath } from "./folder-path";
import { inspectGoogleDriveFolder, describeFetchedGoogleDriveFolderProblem } from "./folder-usability";

const SETTINGS: BackendSettingsDefinition = {
	fields: [
		{
			key: "authMode",
			label: "Use your own Google app (custom OAuth)",
			type: "toggle",
			defaultValue: false,
		},
		{ key: "remoteVaultFolderId", label: "Remote folder id", type: "text" },
		{
			key: "customClientId",
			label: "Client ID secret name",
			type: "secret_reference",
			visibleWhen: { field: "authMode", equals: true },
		},
		{
			key: "customClientSecret",
			label: "Client secret secret name",
			type: "secret_reference",
			visibleWhen: { field: "authMode", equals: true },
		},
		{
			key: "customScope",
			label: "OAuth scope",
			type: "text",
			visibleWhen: { field: "authMode", equals: true },
		},
		{
			key: "customRedirectUri",
			label: "Redirect URI",
			type: "text",
			visibleWhen: { field: "authMode", equals: true },
		},
	],
};

async function buildAuth(context: BackendRuntimeContext, config: Readonly<JsonObject>): Promise<IGoogleAuth> {
	if (config.authMode === true) {
		return new GoogleAuthDirect({
			clientId: (await context.secrets.get("customClientId")) ?? "",
			clientSecret: (await context.secrets.get("customClientSecret")) ?? "",
			transport: createContextTransport(context.http),
			scope: asString(config.customScope) || undefined,
			redirectUri: asString(config.customRedirectUri) || undefined,
			logger: context.logger,
		});
	}
	return new GoogleAuth(createContextTransport(context.http), context.logger);
}

const auth: BackendAuth = {
	isAuthenticated: (_context, config) => asString(config.remoteVaultFolderId).length > 0,
	start: async (context, config) => {
		const google = await buildAuth(context, config);
		const url = await google.getAuthorizationUrl();
		await context.auth.openExternal(url);
		const patch: JsonObject = {
			authMode: config.authMode === true,
			pendingAuthState: google.getAuthState() ?? "",
		};
		const verifier = google.getCodeVerifier();
		if (verifier) patch.pendingCodeVerifier = verifier;
		return { set: patch };
	},
	complete: async (context, input, config) => {
		const google = await buildAuth(context, config);
		if (!google.getAuthState() && asString(config.pendingAuthState)) {
			google.setAuthState(asString(config.pendingAuthState));
		}
		if (!google.getCodeVerifier() && asString(config.pendingCodeVerifier)) {
			google.setCodeVerifier(asString(config.pendingCodeVerifier));
		}
		await google.handleAuthCallback(parseAuthCallbackParams(input));
		const tokens = google.getTokenState();
		if (!tokens.refreshToken) {
			throw new Error("The provider did not return a refresh token. Reconnect and consent again.");
		}
		await context.secrets.set("refresh", tokens.refreshToken);
		await context.secrets.set("access", tokens.accessToken);
		return { set: { accessTokenExpiry: tokens.accessTokenExpiry, pendingAuthState: "", pendingCodeVerifier: "" } };
	},
	revoke: async (context, config) => {
		const refresh = await context.secrets.get("refresh");
		if (!refresh) return;
		const google = await buildAuth(context, config);
		google.setTokens(refresh, (await context.secrets.get("access")) ?? "", 0);
		await google.revokeToken();
	},
};

async function buildClient(
	context: BackendRuntimeContext,
	config: Readonly<JsonObject>,
): Promise<GoogleDriveClient> {
	const google = await buildAuth(context, config);
	const expiry = typeof config.accessTokenExpiry === "number" ? config.accessTokenExpiry : 0;
	google.setRefreshTokenRotatedHook((rotated) => context.secrets.set("refresh", rotated));
	google.setTokens(
		(await context.secrets.get("refresh")) ?? "",
		(await context.secrets.get("access")) ?? "",
		expiry,
	);
	return new GoogleDriveClient((force) => google.getAccessToken(force), createContextTransport(context.http), context.logger);
}

async function buildClientState(
	context: BackendRuntimeContext,
	config: Readonly<JsonObject>,
): Promise<{ client: GoogleDriveClient; readExpiry: () => number }> {
	const google = await buildAuth(context, config);
	const expiry = typeof config.accessTokenExpiry === "number" ? config.accessTokenExpiry : 0;
	google.setRefreshTokenRotatedHook((rotated) => context.secrets.set("refresh", rotated));
	google.setTokens(
		(await context.secrets.get("refresh")) ?? "",
		(await context.secrets.get("access")) ?? "",
		expiry,
	);
	return {
		client: new GoogleDriveClient((force) => google.getAccessToken(force), createContextTransport(context.http), context.logger),
		readExpiry: () => google.getTokenState().accessTokenExpiry,
	};
}

const binding: BackendBinding = {
	resolveDefault: async (context, config, vaultName): Promise<BindingResult> => {
		const client = await buildClient(context, config);
		const cached = asString(config.remoteVaultFolderId) || undefined;
		const resolution = await resolveGoogleDriveRemoteVault(client, vaultName, cached);
		const id = asString(resolution.backendUpdates.remoteVaultFolderId);
		return { patch: { set: { remoteVaultFolderId: id } }, target: { id } };
	},
	beginPick: async (context, config): Promise<JsonPatch> => {
		const google = await buildAuth(context, config);
		if (!(google instanceof GoogleAuth)) {
			throw new Error("Folder picking is only available with Air Sync's Google app.");
		}
		const url = await google.getFolderPickerAuthorizationUrl();
		await context.auth.openExternal(url);
		const state = google.getAuthState() ?? "";
		return { set: { pendingAuthState: state, pendingFolderPickState: state } };
	},
	completePick: async (context, params, config): Promise<BindingResult> => {
		const expected = asString(config.pendingFolderPickState);
		if (!expected || params.state !== expected) throw new Error("State mismatch - possible CSRF attack");
		const picked = (params.picked_file_ids ?? "").split(",").map((v) => v.trim()).filter(Boolean);
		if (picked.length !== 1) throw new Error("Please select exactly one folder.");
		const id = picked[0]!;
		const client = await buildClient(context, config);
		const inspection = await inspectGoogleDriveFolder(client, id);
		if (!inspection.usable) throw new Error("That folder is not usable. Re-pick it in the Google Picker.");
		return { patch: { set: { remoteVaultFolderId: id, pendingFolderPickState: "" } }, target: { id } };
	},
	getDisplayPath: async (context, config, target) => {
		const client = await buildClient(context, config);
		const resolved = await resolveFolderPath(client, target.id);
		if (!resolved) return null;
		return resolved.problem
			? {
					id: target.id,
					displayPath: resolved.path,
					warning: describeFetchedGoogleDriveFolderProblem(resolved.problem),
				}
			: { id: target.id, displayPath: resolved.path };
	},
};

/** The canonical Google Drive backend module. */
export const googleDriveModule: BackendModule = {
	id: "googledrive",
	displayName: "Google Drive",
	version: "1.0.0",
	apiVersion: BACKEND_MODULE_API_VERSION,
	auth,
	settings: SETTINGS,
	binding,
	getTarget: resolveFolderTarget,
	createAdapter: async (context, config, target): Promise<RemoteBackendAdapter> => {
		const { client, readExpiry } = await buildClientState(context, config);
		return withAdapterState(new GoogleDriveAdapter(client, target.id), () => ({
			accessTokenExpiry: readExpiry(),
		}));
	},
};
