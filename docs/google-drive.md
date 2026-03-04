# Google Drive Backend

Setup instructions and technical details for the Smart Sync Google Drive backend.

## Connection Steps

1. Open the plugin settings (**Settings → Smart Sync**)
2. Enter the sync target folder ID under **Drive folder ID**
3. Click the **Connect to Google Drive** button
4. Complete the Google account authorization in the browser
5. The plugin automatically receives the callback via `obsidian://smart-sync-auth` protocol handler

If the automatic callback fails, copy the redirect URL from the browser and paste it into the **Authorization code** field in settings.

### How to Get the Drive Folder ID

Open the folder in Google Drive and copy the ID portion at the end of the URL:

```
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                       This part is the folder ID
```

## Backend-Specific Settings

| Setting | Description |
|---------|-------------|
| Drive folder ID | Google Drive folder ID for the sync target |

## Technical Details

### OAuth 2.0 + PKCE

The authentication flow uses OAuth 2.0 Authorization Code Grant + PKCE (S256). OAuth client ID and secret are embedded in the plugin — no user configuration needed. The embedded client secret does not pose a security risk: the redirect URI is restricted to a specific domain in the GCP console, and PKCE ensures that intercepted authorization codes cannot be exchanged for tokens without the `code_verifier`.

Internal flow (corresponds to Connection Steps 3–5 above):

1. **[Step 3]** The plugin generates a PKCE code challenge and opens Google's authorization endpoint
2. **[Step 4]** After the user authorizes, Google redirects to a GitHub Pages relay (`obsidian-smart-sync-oauth-relay`)
3. **[Step 5]** The relay redirects to `obsidian://smart-sync-auth?code=...&state=...`, which the plugin handles via a protocol handler
4. Access and refresh tokens are obtained directly from Google's token endpoint
5. Access tokens are automatically refreshed 60 seconds before expiry

The PKCE `pendingCodeVerifier` and `pendingAuthState` are persisted in settings, allowing the auth flow to continue even if the plugin is reloaded mid-flow.

If the protocol handler callback fails (e.g. on some mobile browsers), users can manually copy the redirect URL and paste it into the settings UI as a fallback.

#### Why a GitHub Pages relay is needed

Google OAuth requires redirect URIs to use `http://` or `https://` — custom schemes like `obsidian://` are not allowed for Web application OAuth clients. The relay page (`obsidian-smart-sync-oauth-relay`) hosted on GitHub Pages receives the authorization code via HTTPS redirect, then forwards it to `obsidian://smart-sync-auth?code=...&state=...` to hand control back to the plugin.

#### Why the relay is safe

The relay only forwards the authorization code — it cannot obtain tokens with it. PKCE (S256) ensures that the authorization code is useless without the `code_verifier`, which never leaves the user's device. Even if the relay were compromised and the code intercepted, an attacker could not exchange it for tokens without the `code_verifier`. Additionally, the plugin verifies the `state` parameter against a locally stored value before processing the callback, preventing forged redirects.

### Drive API Usage

- **HTTP client**: Uses Obsidian's `requestUrl()` (bypasses CORS, no external HTTP library needed)
- **Folder structure**: Uses Drive's native folder hierarchy as-is (not flat). This provides better browsability on the Drive side
- **Upload**: Multipart upload for files ≤ 5 MB, resumable upload for files > 5 MB
- **Incremental fetch**: Uses the `changes.list` API for incremental change detection. Only the initial sync requires a full scan; subsequent syncs use a persisted `startPageToken` to fetch only changes

### Caching Strategy

`GoogleDriveFs` maintains the following caches:

- `pathToFile: Map<string, DriveFile>` — path → Drive metadata
- `idToPath: Map<string, string>` — ID → path reverse lookup
- `folders: Set<string>` — set of folder paths

Caches are protected by `AsyncMutex`. Network I/O (downloads/uploads) executes outside the mutex to prevent deadlocks. Falls back to a full scan on HTTP 410 (expired token).

### Initial Sync

The first sync after connecting performs a full scan of the Drive folder. This may take a significant amount of time depending on vault size (number of files and total data). Subsequent syncs use the `changes.list` API for incremental updates and are much faster.

### Mobile Support

The plugin is configured with `isDesktopOnly: false`. The `obsidian://` protocol handler should work on both desktop and mobile. If the protocol handler fails on mobile, the manual callback URL paste fallback is available in settings.

#### Troubleshooting on mobile

- **Authentication completes but sync doesn't start**: Restart the plugin (disable → enable in Community plugins settings), then try syncing manually
- **Token error after successful authorization**: Check that the device has a stable network connection — token exchange with Google's endpoint requires connectivity immediately after authorization
- **Protocol handler not triggered**: Use the manual fallback — copy the full redirect URL from the browser and paste it into the **Authorization code** field in settings
