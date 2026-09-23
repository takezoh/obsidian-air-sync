/**
 * Backend Module API v3 — the public contract between core and a backend module.
 *
 * This entry point is imported by core and by backend modules. Its transitive
 * imports must stay free of core internals, Obsidian, stores, and Node/Electron:
 * a module author should be able to build a static fake module with only these
 * types. `backend-module-boundary-guard.test.mjs` (run by `lint:bot-repro`)
 * pins that property.
 *
 * Some symbols here have no direct caller yet: they are exported only because a
 * public union member names them, so a module can address/narrow that variant.
 * Those exports are intentional and are not dead surface to prune.
 */
export type { JsonValue, JsonObject } from "./json";
export { isJsonObject } from "./json";

export type {
	BackendErrorKind,
	BackendErrorShape,
} from "./errors";
export { backendError, isBackendErrorShape } from "./errors";

export type {
	RemoteObject,
	RemoteObjectKind,
	RemoteChecksum,
	RemotePathAuthority,
	RemoteLocation,
	RemoteAddressing,
} from "./remote-object";
export { isRemoteDirectory } from "./remote-object";

export type {
	RemoteBackendAdapter,
	RemoteBackendCapabilities,
	RemoteChange,
	RemoteChangeResult,
	SubtreeReadResult,
	ExpectedVersion,
	VersionBoundReadInput,
	VersionBoundReadResult,
	DestinationAddress,
	CreateFileInput,
	UpdateFileInput,
	CreateDirectoryInput,
	MoveInput,
	DeleteInput,
} from "./remote-adapter";

export type {
	BackendRuntimeContext,
	BackendHttpClient,
	BackendHttpRequest,
	BackendHttpResponse,
	BackendHttpMethod,
	BackendSecretStore,
	BackendLogger,
	BackendAuthHost,
} from "./runtime";

export type { BackendAuth } from "./auth";

export type { BackendTarget, JsonPatch, BindingResult, BackendBinding } from "./binding";

export type {
	BackendSettingField,
	BackendSettingsDefinition,
} from "./settings";

export type { BackendChecksumAlgorithm } from "./checksums";

export type { BackendModule } from "./module";
export { BACKEND_MODULE_API_VERSION } from "./module";

// Runtime helpers a module bundles. They are provider-neutral, browser-safe,
// and free of core internals so a static built-in and an external artifact can
// both use them.
export {
	AuthError,
	isAuthFailure,
	toError,
	toAuthError,
	errorMessage,
	getErrorInfo,
	classifyHttpError,
	decideRetry,
	sleep,
} from "./error-classification";
export type {
	ErrorKind,
	ErrorClassification,
	ErrorInfo,
	RetryDecision,
} from "./error-classification";

export { getHeader, headerKeys } from "./headers";
export type { HeaderBag } from "./headers";

export { createContextTransport } from "./http-transport";
export type {
	HttpTransport,
	HttpTransportRequest,
	HttpTransportResponse,
} from "./http-transport";

export {
	MAX_LOGGED_BODY_CHARS,
	MAX_MESSAGE_BODY_CHARS,
	describeErrorBody,
	logBackendErrorResponse,
} from "./backend-error-log";

export {
	base64ToBase64Url,
	buildOAuthState,
	computeS256Challenge,
	extractThrownErrorDetail,
	extractTokenErrorDetail,
	generateRandomString,
	parsePkceCallback,
} from "./oauth-pkce";
export { BaseOAuthTokenManager } from "./oauth-pkce";
export type { OAuthTokenResponse, PkceCallbackParams } from "./oauth-pkce";

export {
	REMOTE_VAULT_ROOT,
	INTERNAL_METADATA_PATH,
} from "./remote-vault-contract";
export type { RemoteVaultResolution } from "./remote-vault-contract";

export { AsyncMutex, AsyncPool, AdaptivePool } from "./async-queue";
export type { AdaptivePoolOpts } from "./async-queue";
