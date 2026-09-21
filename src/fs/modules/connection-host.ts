import type {
	BackendModule,
	BackendRuntimeContext,
	BackendTarget,
	JsonObject,
	JsonPatch,
} from "../../backend-api";
import type { ISecretStore } from "../secret-store";
import { applyJsonPatch } from "./config-patch";
import { createAuthHost } from "./auth-host";
import type { BackendAuthHostController, ExternalUrlOpener } from "./auth-host";
import { beginFolderPick, completeFolderPick } from "./folder-pick-host";
import { createRuntimeHost } from "./runtime-host";
import type { BackendRuntimeHost, RuntimeLogSink } from "./runtime-host";
import { createTrackedSecretHost } from "./secret-host";
import type { PhysicalKeyResolver, TrackedSecretStore } from "./secret-host";

/**
 * Core-owned persistence for the active backendData bag. Each connection reads
 * the latest bag and writes whole-bag replacements; a module never sees this.
 */
export interface ModuleConfigStore {
	read(): Readonly<JsonObject>;
	write(next: JsonObject): Promise<void>;
	clear(): Promise<void>;
}

export interface ModuleConnectionOptions {
	readonly module: BackendModule;
	/** Connection generation; bumped on every (re)connect. */
	readonly generation: number;
	/** Whether `generation` is still the live connection generation. */
	readonly isCurrentGeneration: (generation: number) => boolean;
	readonly secrets: ISecretStore;
	readonly sink: RuntimeLogSink;
	readonly config: ModuleConfigStore;
	readonly resolvePhysicalKey?: PhysicalKeyResolver;
	readonly openUrl?: ExternalUrlOpener;
}

/**
 * One module connection's core-owned lifecycle. It owns the {@link createAuthHost}
 * bound to the connection generation and builds the module's
 * {@link BackendRuntimeContext} with that real host — a module's `context.auth`
 * is never a caller-supplied stub. Every patch the module returns is applied
 * only while the generation is current.
 */
export interface ModuleConnection {
	readonly moduleId: string;
	readonly generation: number;
	readonly auth: BackendAuthHostController;
	readonly context: BackendRuntimeContext;
	isCurrent(): boolean;
	/** Run `auth.start`; persists its patch. `false` if the generation is stale. */
	startAuth(): Promise<boolean>;
	/** Run `auth.complete`; persists its patch. `false` if the generation is stale. */
	completeAuth(input: string): Promise<boolean>;
	beginPick(): Promise<boolean>;
	completePick(params: Readonly<Record<string, string>>): Promise<BackendTarget | null>;
	/** Folder names directly under an App-Folder root, for the core in-app picker. */
	listAppRootFolders(): Promise<readonly string[]>;
	resolveDefaultFolder(vaultName: string): Promise<BackendTarget | null>;
	revoke(): Promise<void>;
	/** The ADR disconnect sequence; see {@link disconnectModule}. */
	disconnect(): Promise<void>;
	dispose(): Promise<void>;
}

/** The steps of the disconnect sequence, in the order core must run them. */
export interface ModuleDisconnectSteps {
	revoke(): Promise<void>;
	clearSecrets(): Promise<void>;
	clearConfig(): Promise<void>;
	releaseAdapter(): Promise<void>;
}

/**
 * The ADR-owned disconnect sequence: revoke (best effort) → clear module secret
 * namespace → clear active config → dispose the connection (which closes the
 * prepared managed filesystem and its checkpoint store). Revocation failure never
 * blocks local teardown; the remaining steps always run in order. The target's
 * checkpoint/baseline are cleared by `BackendManager.resetAll` BEFORE this runs.
 */
export async function disconnectModule(steps: ModuleDisconnectSteps): Promise<void> {
	try {
		await steps.revoke();
	} catch {
		// Best effort: a provider revoke failure must not strand local state.
	}
	await steps.clearSecrets();
	await steps.clearConfig();
	await steps.releaseAdapter();
}

/** Logical keys the module declared as secret references in its settings. */
function declaredSecretKeys(module: BackendModule): readonly string[] {
	return (module.settings?.fields ?? [])
		.filter((field) => field.type === "secret_reference")
		.map((field) => field.key);
}

/**
 * Logical keys that name a user-owned secret reference. Core NEVER deletes these:
 * the value is a name of a secret the user created, not a plugin-owned token. They
 * are cleared from the live connection (the module simply stops using them), but
 * the referenced secret is left intact.
 */
function secretReferenceKeys(module: BackendModule): ReadonlySet<string> {
	return new Set(declaredSecretKeys(module));
}

/** Build a connection host for one module and one generation. Performs no I/O. */
export function createModuleConnection(options: ModuleConnectionOptions): ModuleConnection {
	const { module, generation } = options;
	const auth = createAuthHost({
		generation,
		isCurrentGeneration: options.isCurrentGeneration,
		openUrl: options.openUrl,
	});
	const secrets: TrackedSecretStore = createTrackedSecretHost(
		options.secrets,
		module.id,
		options.resolvePhysicalKey,
	);
	const runtime: BackendRuntimeHost = createRuntimeHost({
		moduleId: module.id,
		generation,
		secrets: options.secrets,
		secretsHost: secrets,
		sink: options.sink,
		auth,
	});
	let disposed = false;

	const isLive = (): boolean => !disposed && options.isCurrentGeneration(generation);

	const commit = async (patch: JsonPatch): Promise<boolean> => {
		if (!isLive()) return false;
		await options.config.write(applyJsonPatch(options.config.read(), patch));
		return true;
	};

	const clearSecrets = async (): Promise<void> => {
		const keys = new Set([
			...secrets.touchedKeys,
			...declaredSecretKeys(module),
			...module.auth.credentialKeys,
		]);
		const references = secretReferenceKeys(module);
		for (const key of keys) {
			// A `secret_reference` value is a user-owned secret name, never a
			// plugin-owned token — clearing it would delete the user's secret.
			if (references.has(key)) continue;
			await secrets.delete(key);
		}
	};

	const beginAuth = async (
		run: () => Promise<JsonPatch>,
	): Promise<boolean> => {
		if (!isLive()) return false;
		return commit(await run());
	};

	const connection: ModuleConnection = {
		moduleId: module.id,
		generation,
		auth,
		context: runtime.context,
		isCurrent: isLive,
		startAuth: () => beginAuth(() => module.auth.start(runtime.context, options.config.read())),
		completeAuth: (input) =>
			beginAuth(() => module.auth.complete(runtime.context, input, options.config.read())),
		beginPick: () =>
			beginFolderPick({
				binding: module.binding,
				context: runtime.context,
				config: { read: () => options.config.read(), commit },
			}),
		completePick: (params) =>
			completeFolderPick(
				{
					binding: module.binding,
					context: runtime.context,
					config: { read: () => options.config.read(), commit },
				},
				params,
			),
		listAppRootFolders: async () => {
			if (!module.binding.listAppRootFolders) return [];
			return module.binding.listAppRootFolders(runtime.context, options.config.read());
		},
		resolveDefaultFolder: async (vaultName) => {
			const result = await module.binding.resolveDefault(
				runtime.context,
				options.config.read(),
				vaultName,
			);
			return (await commit(result.patch)) ? result.target : null;
		},
		revoke: async () => {
			await module.auth.revoke?.(runtime.context, options.config.read());
		},
		disconnect: () =>
			disconnectModule({
				revoke: () => connection.revoke(),
				clearSecrets,
				clearConfig: () => options.config.clear(),
				releaseAdapter: async () => {
					await connection.dispose();
				},
			}),
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			auth.cancelAll();
			await runtime.dispose();
		},
	};
	return connection;
}
