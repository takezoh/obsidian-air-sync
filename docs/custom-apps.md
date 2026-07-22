# Custom app setup

Air Sync can connect through **your own** cloud app instead of the built-in connection, so you manage the authorization yourself. For OneDrive, a custom app is also how you reach work/school (organization) accounts, which the built-in (personal-only) connection doesn't support.

This page lists **what each provider app must be configured with, and what you copy into Air Sync** (Settings → Air Sync). Create the app in the provider's console (links below) — the details here are what Air Sync actually needs, not a walkthrough of the console.

**Common to every backend**

- Access stays scoped to Air Sync's own folder (Google Drive `drive.file`, OneDrive / Dropbox App Folder) — the app can't see the rest of your storage.
- Configure the redirect URI and permissions **before** you connect. Changing scopes/permissions afterward means disconnecting and reconnecting so a new token picks them up.
- **Connecting is not syncing.** After you authorize, Air Sync needs a remote folder before anything transfers (OneDrive/Dropbox: pick one in-app after connecting; Google Drive custom: you provide the folder ID up front — see below). On mobile, keep Obsidian in the foreground until the first sync finishes; for a large first sync, enable **Keep screen awake during sync**.

## Google Drive — "Google Drive (custom OAuth)"

Create an **OAuth client ID** of type **Web application** (so it can use the https callback below) in the Google Cloud Console, and enable the Google Drive API for its project.
→ [Create and manage OAuth clients](https://support.google.com/cloud/answer/15549257)

Your OAuth client must have:

- The **Google Drive API** enabled on its project.
- An **authorized redirect URI** matching Air Sync's **Redirect uri** field — default `https://airsync.takezo.dev/callback` (a callback page that hands the code back to Obsidian).
- A **client secret** — unlike the other backends, Google Drive custom is a confidential client and uses both the client ID *and* secret.

Copy into Air Sync:

| Air Sync setting | Value |
|---|---|
| Client ID | Your OAuth client ID |
| Client secret | Your OAuth client secret |
| Scope | Optional — defaults to `https://www.googleapis.com/auth/drive.file` (access only to files the app creates) |
| Include granted scopes | Optional — incremental authorization |
| Redirect uri | Must match the redirect URI on your client (default `https://airsync.takezo.dev/callback`) |
| Remote vault folder ID | The Google Drive folder ID to sync into — **required before you connect** (this backend has no in-app folder picker) |

## OneDrive — "OneDrive (custom app)"

Register an application in Microsoft Entra, then add its redirect URI.
→ [Register an application](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app) · [Add a redirect URI](https://learn.microsoft.com/entra/identity-platform/how-to-add-redirect-uri)

Your app registration must have:

- A **redirect URI** `obsidian://air-sync-auth`, added under the **Mobile & desktop applications** platform (Air Sync uses PKCE with **no client secret**).
- The **Files.ReadWrite.AppFolder** delegated permission.
- **Supported account types** that match the account type you select in Air Sync.

Copy into Air Sync:

| Air Sync setting | Value |
|---|---|
| Application (client) ID | Your app registration's Application (client) ID |
| Account type | Personal only / Work+personal / Work only / Specific tenant (then **Tenant ID**) — must match the registration |

After connecting, choose the remote folder in-app (default folder or pick one).

## Dropbox — "Dropbox (custom app)"

Create an app in the Dropbox App Console with **Scoped access** and **App folder** access.
→ [Dropbox App Console](https://www.dropbox.com/developers/apps)

Your app must have:

- **App folder** access type.
- A **redirect URI** `obsidian://air-sync-auth` (Air Sync uses PKCE with **no app secret**).
- The **`files.metadata.read`**, **`files.content.read`**, and **`files.content.write`** permissions enabled, then **Submit**.

Copy into Air Sync:

| Air Sync setting | Value |
|---|---|
| App key | Your Dropbox app's app key |

After connecting, choose the remote folder in-app. Your synced files live under `Dropbox/Apps/<your app name>/<vault name>/`.
