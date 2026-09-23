import { BACKEND_MODULE_API_VERSION } from "../../backend-api";

/**
 * Canonical backend ids. These are the three persisted `settings.backendType`
 * values after migration (see docs/adr — backend module boundary).
 *
 * `*-custom` are legacy settings aliases ONLY: they are read to migrate an old
 * vault, never registered as a fourth/sixth module id.
 */
export const CANONICAL_BACKEND_IDS = ["googledrive", "onedrive", "dropbox"] as const;
export type CanonicalBackendId = (typeof CANONICAL_BACKEND_IDS)[number];

/** Legacy `backendType` aliases mapped to their canonical module id. */
export const LEGACY_BACKEND_ALIASES: Readonly<Record<string, CanonicalBackendId>> = {
	"googledrive-custom": "googledrive",
	"onedrive-custom": "onedrive",
	"dropbox-custom": "dropbox",
};

export interface ModuleValidationIssue {
	/** Stable machine code (e.g. `missing_function`, `alias_id`). */
	readonly code: string;
	/** Dotted location within the candidate (e.g. `auth.start`). */
	readonly path: string;
	readonly message: string;
}

export type ModuleValidationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly issues: readonly ModuleValidationIssue[] };

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
/** Config-bag keys are camelCase (e.g. `rootId`), unlike lowercase module ids. */
const SETTING_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SETTING_FIELD_TYPES: ReadonlySet<string> = new Set([
	"text",
	"secret_reference",
	"select",
	"toggle",
]);

/** The `conditionalContentUpdate` coverage values a v2 adapter may declare. */
const CONTENT_UPDATE_COVERAGE: ReadonlySet<string> = new Set(["all", "none"]);
/** The `versionBoundRead` binding modes a v3 adapter may declare. */
const VERSION_BOUND_READ_MODES: ReadonlySet<string> = new Set(["revision", "reobserve"]);
/** The addressing schemes a v3 adapter may declare. */
const REMOTE_ADDRESSING_MODES: ReadonlySet<string> = new Set(["parent_id", "provider_path"]);

type Json = Readonly<Record<string, unknown>>;

function isJson(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
	return typeof value === "function";
}

class Issues {
	private readonly collected: ModuleValidationIssue[] = [];

	add(code: string, path: string, message: string): void {
		this.collected.push({ code, path, message });
	}

	get empty(): boolean {
		return this.collected.length === 0;
	}

	result(): ModuleValidationResult {
		return this.empty ? { ok: true } : { ok: false, issues: [...this.collected] };
	}
}

function validateStringField(
	issues: Issues,
	record: Json,
	key: string,
	path: string,
	pattern?: RegExp,
): void {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		issues.add("missing_string", path, `${path} must be a non-empty string`);
		return;
	}
	if (pattern && !pattern.test(value)) {
		issues.add("invalid_string", path, `${path} has an invalid format`);
	}
}

function validateFunction(issues: Issues, record: Json, key: string, path: string, required: boolean): void {
	const value = record[key];
	if (value === undefined) {
		if (required) issues.add("missing_function", path, `${path} is required`);
		return;
	}
	if (!isFunction(value)) {
		issues.add("invalid_function", path, `${path} must be a function`);
	}
}

function validateAuth(issues: Issues, module: Json): void {
	const auth = module.auth;
	if (!isJson(auth)) {
		issues.add("missing_object", "auth", "auth must be an object");
		return;
	}
	validateFunction(issues, auth, "start", "auth.start", true);
	validateFunction(issues, auth, "complete", "auth.complete", true);
	validateFunction(issues, auth, "revoke", "auth.revoke", false);
	validateCredentialKeys(issues, auth);
}

/**
 * Core derives credential readiness from the keys a module DECLARES, and clears
 * exactly those on disconnect. Validate the declaration so a malformed module
 * cannot smuggle an unreadable key into that derivation.
 */
function validateCredentialKeys(issues: Issues, auth: Json): void {
	const keys = auth.credentialKeys;
	if (!Array.isArray(keys)) {
		issues.add("missing_credential_keys", "auth.credentialKeys", "auth.credentialKeys must be an array");
		return;
	}
	const seen = new Set<string>();
	keys.forEach((key: unknown, index: number) => {
		const path = `auth.credentialKeys[${index}]`;
		if (typeof key !== "string" || key.length === 0) {
			issues.add("invalid_credential_key", path, `${path} must be a non-empty string`);
			return;
		}
		if (seen.has(key)) issues.add("duplicate_credential_key", path, `duplicate credential key ${key}`);
		seen.add(key);
	});
}

/**
 * A logical key cannot be both a module-owned credential and a user-owned secret
 * reference. Core's readiness reads the plugin-owned physical key while the
 * module reads the referenced secret, so an overlap strands the module
 * permanently unauthenticated. Reject the collision at registration.
 */
function validateCredentialReferenceCollision(issues: Issues, module: Json): void {
	const auth = module.auth;
	const settings = module.settings;
	if (!isJson(auth) || !Array.isArray(auth.credentialKeys)) return;
	if (!isJson(settings) || !Array.isArray(settings.fields)) return;
	const references = new Set(
		settings.fields
			.filter((field): field is Json => isJson(field) && field.type === "secret_reference")
			.map((field) => field.key)
			.filter((key): key is string => typeof key === "string"),
	);
	for (const key of auth.credentialKeys) {
		if (typeof key === "string" && references.has(key)) {
			issues.add(
				"credential_reference_collision",
				"auth.credentialKeys",
				`"${key}" is declared both as a credential key and a secret_reference field`,
			);
		}
	}
}

function validateBinding(issues: Issues, module: Json): void {
	const binding = module.binding;
	if (!isJson(binding)) {
		issues.add("missing_object", "binding", "binding must be an object");
		return;
	}
	validateFunction(issues, binding, "resolveDefault", "binding.resolveDefault", true);
	validateFunction(issues, binding, "beginPick", "binding.beginPick", false);
	validateFunction(issues, binding, "completePick", "binding.completePick", false);
	validateFunction(issues, binding, "getDisplayPath", "binding.getDisplayPath", false);
	const hasBegin = binding.beginPick !== undefined;
	const hasComplete = binding.completePick !== undefined;
	if (hasBegin !== hasComplete) {
		issues.add(
			"unpaired_picker",
			"binding",
			"beginPick and completePick must be declared together",
		);
	}
}

function validateSettings(issues: Issues, module: Json): void {
	const settings = module.settings;
	if (settings === undefined) return;
	if (!isJson(settings) || !Array.isArray(settings.fields)) {
		issues.add("invalid_settings", "settings", "settings.fields must be an array");
		return;
	}
	const seen = new Set<string>();
	settings.fields.forEach((field: unknown, index: number) => {
		const path = `settings.fields[${index}]`;
		if (!isJson(field)) {
			issues.add("invalid_field", path, `${path} must be an object`);
			return;
		}
		validateStringField(issues, field, "key", `${path}.key`, SETTING_KEY_PATTERN);
		validateStringField(issues, field, "label", `${path}.label`);
		const type = field.type;
		if (typeof type !== "string" || !SETTING_FIELD_TYPES.has(type)) {
			issues.add("invalid_field_type", `${path}.type`, `${path}.type is not a supported field type`);
		}
		const key = field.key;
		if (typeof key === "string") {
			if (seen.has(key)) issues.add("duplicate_field", `${path}.key`, `duplicate field key ${key}`);
			seen.add(key);
		}
		if (type === "select" && !Array.isArray(field.options)) {
			issues.add("missing_options", `${path}.options`, "a select field needs options");
		}
	});
}

function validateModuleIdentity(issues: Issues, module: Json): void {
	validateStringField(issues, module, "id", "id", MODULE_ID_PATTERN);
	const id = module.id;
	if (typeof id === "string" && Object.prototype.hasOwnProperty.call(LEGACY_BACKEND_ALIASES, id)) {
		issues.add("alias_id", "id", "a legacy alias cannot be registered as a module id");
	}
	validateStringField(issues, module, "displayName", "displayName");
	validateStringField(issues, module, "version", "version", SEMVER_PATTERN);
	const apiVersion = module.apiVersion;
	if (apiVersion !== BACKEND_MODULE_API_VERSION) {
		issues.add("unsupported_api_version", "apiVersion", "unsupported Backend Module API version");
	}
}

/**
 * Structurally validate a candidate module before it participates in backend
 * initialization. Pure: no I/O, no registry side effects.
 *
 * This checks shape/declarations only. Duplicate-id and reserved-id conflicts
 * between modules are a registry concern (T02), not a property of one candidate.
 */
export function validateBackendModule(candidate: unknown): ModuleValidationResult {
	const issues = new Issues();
	if (!isJson(candidate)) {
		issues.add("invalid_module", "", "a backend module must be a plain object");
		return issues.result();
	}
	validateModuleIdentity(issues, candidate);
	validateFunction(issues, candidate, "getTarget", "getTarget", true);
	validateFunction(issues, candidate, "createAdapter", "createAdapter", true);
	validateFunction(issues, candidate, "disconnectConfig", "disconnectConfig", false);
	validateAuth(issues, candidate);
	validateBinding(issues, candidate);
	validateSettings(issues, candidate);
	validateCredentialReferenceCollision(issues, candidate);
	return issues.result();
}

/**
 * Runtime-validate the adapter a module returns, immediately after creation.
 *
 * `createAdapter` is declared to return a `RemoteBackendAdapter`, but a
 * dynamically loaded JavaScript module is not bound by TypeScript: it can omit
 * `capabilities`/`addressing` or use a value outside the declared enums. This
 * checks the v3 declaration before the adapter reaches `ManagedRemoteFs`.
 */
export function validateAdapter(candidate: unknown): ModuleValidationResult {
	const issues = new Issues();
	if (!isJson(candidate)) {
		issues.add("invalid_adapter", "", "an adapter must be a plain object");
		return issues.result();
	}
	const addressing = candidate.addressing;
	if (typeof addressing !== "string" || !REMOTE_ADDRESSING_MODES.has(addressing)) {
		issues.add(
			"invalid_addressing",
			"addressing",
			"addressing must be parent_id | provider_path",
		);
	}
	const capabilities = candidate.capabilities;
	if (!isJson(capabilities)) {
		issues.add("missing_capabilities", "capabilities", "adapter.capabilities is required");
		return issues.result();
	}
	for (const key of ["exclusiveCreate", "conditionalMetadataMutation"]) {
		if (typeof capabilities[key] !== "boolean") {
			issues.add("invalid_capability", `capabilities.${key}`, `capabilities.${key} must be a boolean`);
		}
	}
	const coverage = capabilities.conditionalContentUpdate;
	if (typeof coverage !== "string" || !CONTENT_UPDATE_COVERAGE.has(coverage)) {
		issues.add(
			"invalid_capability",
			"capabilities.conditionalContentUpdate",
			"capabilities.conditionalContentUpdate must be all | none",
		);
	}
	const readMode = capabilities.versionBoundRead;
	if (typeof readMode !== "string" || !VERSION_BOUND_READ_MODES.has(readMode)) {
		issues.add(
			"invalid_capability",
			"capabilities.versionBoundRead",
			"capabilities.versionBoundRead must be revision | reobserve",
		);
	}
	// The delta-completion read is optional: a provider whose delta is already
	// complete omits it and stays valid. A declared-but-malformed member is
	// rejected here, before ManagedRemoteFs can invoke it.
	const listSubtreeById = candidate.listSubtreeById;
	if (listSubtreeById !== undefined && !isFunction(listSubtreeById)) {
		issues.add(
			"invalid_member",
			"listSubtreeById",
			"adapter.listSubtreeById must be a function when declared",
		);
	}
	return issues.result();
}
