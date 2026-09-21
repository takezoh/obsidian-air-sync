import type {
	BackendBinding,
	BackendModule,
	BackendRuntimeContext,
	BackendSettingsDefinition,
	BindingResult,
	JsonObject,
	RemoteBackendAdapter,
} from "../../backend-api";
import { BACKEND_MODULE_API_VERSION } from "../../backend-api";
import { OneDriveAuth, buildOneDriveAuthorizeUrl, DEFAULT_ONEDRIVE_AUTHORITY } from "./auth";
import { OneDriveClient } from "./client";
import { OneDriveAdapter } from "./adapter";
import { createPkceBackendAuth, buildPkceTokenGetter } from "../modules/pkce-module-auth";
import { createContextTransport } from "../http-transport";
import { asString, resolveFolderTarget } from "../modules/module-utils";
import { withAdapterState } from "../modules/adapter-state";
import type { PkceModuleSpec } from "../modules/pkce-module-auth";
import { findOrCreateAppRootFolder } from "./remote-vault";

const SETTINGS: BackendSettingsDefinition = {
	fields: [
		{
			key: "authMode",
			label: "Use your own Microsoft app (custom OAuth)",
			type: "toggle",
			defaultValue: false,
		},
		{ key: "remoteVaultFolderId", label: "Remote folder id", type: "text" },
		{
			key: "customClientId",
			label: "Application (client) ID",
			type: "text",
			visibleWhen: { field: "authMode", equals: true },
		},
		{
			key: "customAuthority",
			label: "Account authority",
			type: "text",
			defaultValue: DEFAULT_ONEDRIVE_AUTHORITY,
			visibleWhen: { field: "authMode", equals: true },
		},
	],
};

function authorityOf(config: Readonly<JsonObject>): string {
	return asString(config.customAuthority) || DEFAULT_ONEDRIVE_AUTHORITY;
}

const spec: PkceModuleSpec = {
	displayName: "OneDrive",
	defaultClientId: "71cd9a2a-a701-4ec2-b7d0-2352e0e84e9f",
	isCustom: (config) => config.authMode === true,
	customClientId: (config) => asString(config.customClientId),
	createManager: (clientId, config, context) => new OneDriveAuth(clientId, createContextTransport(context.http), authorityOf(config), context.logger),
	authorizeUrl: (clientId, codeChallenge, state, config) =>
		buildOneDriveAuthorizeUrl({ clientId, codeChallenge, state, authority: authorityOf(config) }),
	exchangeCode: (manager, code, codeVerifier) => {
		const auth = manager as OneDriveAuth;
		return auth.exchangeCode(code, codeVerifier);
	},
};

const auth = createPkceBackendAuth(spec);

async function buildClientState(
	context: BackendRuntimeContext,
	config: Readonly<JsonObject>,
): Promise<{ client: OneDriveClient; readExpiry: () => number }> {
	const { getToken, readExpiry } = await buildPkceTokenGetter(spec, context, config);
	return { client: new OneDriveClient(getToken, createContextTransport(context.http), context.logger), readExpiry };
}

async function buildClient(
	context: BackendRuntimeContext,
	config: Readonly<JsonObject>,
): Promise<OneDriveClient> {
	return (await buildClientState(context, config)).client;
}

const binding: BackendBinding = {
	resolveDefault: async (context, config, vaultName): Promise<BindingResult> => {
		let folderId = asString(config.remoteVaultFolderId);
		if (!folderId) {
			const name = (asString(config.pendingPickedFolderPath) || vaultName).trim();
			if (!name) throw new Error("Cannot resolve the OneDrive remote vault: the vault name is empty.");
			const client = await buildClient(context, config);
			folderId = (await findOrCreateAppRootFolder(client, name)).id;
		}
		return {
			patch: { set: { remoteVaultFolderId: folderId, pendingPickedFolderPath: "" } },
			target: { id: folderId },
		};
	},
	getDisplayPath: async (context, config, target) => {
		const client = await buildClient(context, config);
		const item = await client.getItem(target.id);
		const parentPath = item.parentReference?.path;
		const displayPath = parentPath ? `${parentPath.split(":").pop() ?? ""}/${item.name}` : item.name;
		return { id: target.id, displayPath };
	},
	listAppRootFolders: async (context, config) => {
		const client = await buildClient(context, config);
		return (await client.listAppRootFolders()).map((item) => item.name);
	},
};

/** The canonical OneDrive backend module. */
export const oneDriveModule: BackendModule = {
	id: "onedrive",
	displayName: "OneDrive",
	version: "1.0.0",
	apiVersion: BACKEND_MODULE_API_VERSION,
	auth,
	settings: SETTINGS,
	binding,
	getTarget: resolveFolderTarget,
	createAdapter: async (context, config, target): Promise<RemoteBackendAdapter> => {
		const { client, readExpiry } = await buildClientState(context, config);
		return withAdapterState(new OneDriveAdapter(client, target.id), () => ({
			accessTokenExpiry: readExpiry(),
		}));
	},
};
