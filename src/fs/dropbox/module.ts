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
import { DROPBOX_AUTH } from "../auth-config";
import { DropboxAuth, buildDropboxAuthorizeUrl } from "./auth";
import { DropboxClient } from "./client";
import { DropboxAdapter } from "./adapter";
import { createPkceBackendAuth, buildPkceTokenGetter } from "../modules/pkce-module-auth";
import { createContextTransport } from "../http-transport";
import { asString, resolveFolderTarget } from "../modules/module-utils";
import { withAdapterState } from "../modules/adapter-state";
import type { PkceModuleSpec } from "../modules/pkce-module-auth";

const SETTINGS: BackendSettingsDefinition = {
	fields: [
		{
			key: "authMode",
			label: "Use your own Dropbox app (custom OAuth)",
			type: "toggle",
			defaultValue: false,
		},
		{ key: "remoteVaultFolderId", label: "Remote folder id", type: "text" },
		{
			key: "customClientId",
			label: "App key",
			type: "text",
			visibleWhen: { field: "authMode", equals: true },
		},
	],
};

const spec: PkceModuleSpec = {
	displayName: "Dropbox",
	defaultClientId: DROPBOX_AUTH.clientId,
	isCustom: (config) => config.authMode === true,
	customClientId: (config) => asString(config.customClientId),
	createManager: (clientId, _config, context) => new DropboxAuth(clientId, createContextTransport(context.http), context.logger),
	authorizeUrl: (clientId, codeChallenge, state) => buildDropboxAuthorizeUrl({ clientId, codeChallenge, state }),
	exchangeCode: (manager, code, codeVerifier) => {
		const auth = manager as DropboxAuth;
		return auth.exchangeCode(code, codeVerifier);
	},
};

const auth = createPkceBackendAuth(spec);

async function buildClientState(
	context: BackendRuntimeContext,
	config: Readonly<JsonObject>,
): Promise<{ client: DropboxClient; readExpiry: () => number }> {
	const { getToken, readExpiry } = await buildPkceTokenGetter(spec, context, config);
	return { client: new DropboxClient(getToken, createContextTransport(context.http), context.logger), readExpiry };
}

async function buildClient(
	context: BackendRuntimeContext,
	config: Readonly<JsonObject>,
): Promise<DropboxClient> {
	return (await buildClientState(context, config)).client;
}

const binding: BackendBinding = {
	resolveDefault: async (context, config, vaultName): Promise<BindingResult> => {
		let folderId = asString(config.remoteVaultFolderId);
		if (!folderId) {
			const name = (asString(config.pendingPickedFolderPath) || vaultName).trim();
			if (!name) throw new Error("Cannot resolve the Dropbox remote vault: the vault name is empty.");
			const client = await buildClient(context, config);
			const vault = await client.createFolder(`/${name}`);
			if (vault[".tag"] !== "folder" || !vault.id) {
				throw new Error(`A file named "${name}" already exists in the app folder; choose a different name.`);
			}
			folderId = vault.id;
		}
		return {
			patch: { set: { remoteVaultFolderId: folderId, pendingPickedFolderPath: "" } },
			target: { id: folderId },
		};
	},
	getDisplayPath: async (context, config, target) => {
		const client = await buildClient(context, config);
		const meta = await client.getMetadata(target.id);
		return meta.path_display ? { id: target.id, displayPath: meta.path_display } : null;
	},
	listAppRootFolders: async (context, config) => {
		const client = await buildClient(context, config);
		return (await client.listAppRootFolders()).map((entry) => entry.name);
	},
};

/** The canonical Dropbox backend module. */
export const dropboxModule: BackendModule = {
	id: "dropbox",
	displayName: "Dropbox",
	version: "1.0.0",
	apiVersion: BACKEND_MODULE_API_VERSION,
	auth,
	settings: SETTINGS,
	binding,
	getTarget: resolveFolderTarget,
	createAdapter: async (context, config, target): Promise<RemoteBackendAdapter> => {
		const { client, readExpiry } = await buildClientState(context, config);
		return withAdapterState(new DropboxAdapter(client, target.id), () => ({
			accessTokenExpiry: readExpiry(),
		}));
	},
};
