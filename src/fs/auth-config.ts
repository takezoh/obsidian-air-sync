/**
 * Centralized auth identity config for every cloud backend: auth-relay server,
 * public OAuth client ids, and redirect URIs. Kept in one place — rather than
 * scattered across each backend's auth.ts — so the auth surface is auditable at
 * a glance and the cross-backend duplicate (the shared obsidian:// redirect)
 * cannot drift. OAuth endpoint URLs and scopes stay in each backend's auth.ts.
 */

/**
 * Direct deep link back to the in-plugin protocol handler — no relay page.
 * Shared by Dropbox and OneDrive: both register `obsidian://air-sync-auth` as a
 * redirect URI. Custom-scheme redirects are permitted for PKCE apps (the
 * authorization-code flow otherwise requires https/localhost), so the code can
 * return straight to Obsidian.
 */
export const PLUGIN_REDIRECT_URI = "obsidian://air-sync-auth";

/** Air Sync auth relay server (confidential client; server-side token exchange). */
const GOOGLE_AUTH_SERVER_URL = "https://auth-airsync.takezo.dev";

export const GOOGLE_DRIVE_AUTH = {
	authServerUrl: GOOGLE_AUTH_SERVER_URL,
	clientId: "135801498656-lfjor2ml3v26t9l63mkoka0bndgl9eue.apps.googleusercontent.com",
	redirectUri: `${GOOGLE_AUTH_SERVER_URL}/google/callback`,
	tokenRefreshUrl: `${GOOGLE_AUTH_SERVER_URL}/google/token/refresh`,
} as const;

/** Default redirect URI for user-supplied (direct) Google credentials. */
export const DEFAULT_CUSTOM_REDIRECT_URI = "https://airsync.takezo.dev/callback";

/**
 * Public OAuth app for the Air Sync Dropbox app (App folder permission).
 *
 * PKCE means there is NO client secret anywhere — the `code_verifier` is the
 * ephemeral proof. Registered at https://www.dropbox.com/developers/apps with
 * `obsidian://air-sync-auth` as a redirect URI (Dropbox allows custom schemes for
 * PKCE apps). The Dropbox backend is still labelled "Preview" in the UI, but the
 * key is embedded so it connects with no per-user setup.
 */
export const DROPBOX_AUTH = {
	clientId: "icsyogaens93hde",
	redirectUri: PLUGIN_REDIRECT_URI,
} as const;

/**
 * Public OAuth app for the Air Sync OneDrive app (Files.ReadWrite.AppFolder).
 *
 * The real Entra (Azure AD) application (client) id, registered at
 * https://entra.microsoft.com with `obsidian://air-sync-auth` as a redirect URI and
 * "Personal Microsoft accounts only" as the supported account type. PKCE means there
 * is NO client secret anywhere — the `code_verifier` is the ephemeral proof. The
 * contract tests pass a fake client id, so they are green regardless of this value.
 */
export const ONEDRIVE_AUTH = {
	clientId: "71cd9a2a-a701-4ec2-b7d0-2352e0e84e9f",
	redirectUri: PLUGIN_REDIRECT_URI,
} as const;
