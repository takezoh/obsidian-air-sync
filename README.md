# Air Sync

Your Obsidian notes, always up to date on every device — without ever thinking about sync. Edit on your laptop, pick up your phone, and it's caught up before you start typing.

Works on desktop and mobile, powered by your own cloud storage:

- **Google Drive**
- **OneDrive** — personal Microsoft accounts (built-in); work/school accounts with a custom app (see Advanced)
- **Dropbox**

## What you get

- **Syncs itself**: Your vault stays current on every device — no button to press.
- **Survives interruptions**: Close Obsidian or lock your phone mid-sync; it picks up where it left off.
- **Quick on big vaults**: Only what changed moves — easy on data and battery.
- **Two-device edits, merged**: Edits from two devices come together when they can — no messy "conflicted copy" files.
- **Set up in a minute**: Connect once; almost nothing to configure.
- **Choose what syncs**: Skip big attachments or a private folder.

## Getting started

1. Open the plugin settings (**Settings → Air Sync**).
2. Pick your backend if more than one is available.
3. Click **Connect**, then approve access in your browser.
4. Choose where to sync: use the **default folder** (named after your vault), or **pick an existing folder**.

That's it — Air Sync syncs into that folder from then on.

The first sync scans your remote folder, so it may take a little while. After that, syncing is fast.

## Conflict resolution strategies

| Strategy | Behavior |
|----------|----------|
| Auto merge (recommended) | Attempts 3-way merge for text files using the last-synced content as the base. If merge is not possible (binary file, no base content, or merge failure), falls back to keep newer (by mtime). If mtime is equal or unknown, creates a duplicate. |
| Duplicate | Always saves the remote version as a `.conflict` file and keeps the local version at the original path. |

## Commands

| Command | Description |
|---------|-------------|
| `Air Sync: Sync now` | Run a sync manually |

---

## Advanced

### Syncing the config directory

If you want to try syncing Obsidian's config directory (`.obsidian/`), add it to **Dot-prefixed paths to sync** and use **Ignore patterns** to select what to include.

> **Warning**: The config directory contains Obsidian's internal metadata. Syncing it across devices may cause settings loss, layout corruption, or plugin malfunction.

Example:

```
.obsidian/**
!.obsidian/*.json
.obsidian/workspace.json
.obsidian/workspace-mobile.json
!.obsidian/plugins/
!.obsidian/plugins/**
.obsidian/plugins/*/data.json
```

### Custom OAuth (Google Drive)

The built-in Google Drive connection uses the `drive.file` scope, which only allows access to files the plugin itself created. With custom OAuth, you can use your own Google Cloud OAuth client and manage authorization independently.

The authorization code exchange is protected by PKCE — the code cannot be used without the verifier held only by the plugin.

> **Note**: Tokens are stored in Obsidian's secret storage, which is accessible to other plugins. The built-in OAuth limits exposure with the `drive.file` scope. Custom OAuth may increase risk depending on the scope you configure.

### Custom app (OneDrive & Dropbox)

OneDrive and Dropbox also offer a **custom app** backend, where you register your own app and enter its client id (Dropbox app key / Entra application ID). The id is a public PKCE identifier — there is no secret to manage. Register `obsidian://air-sync-auth` as a redirect URI in your app.

For **OneDrive**, the custom app additionally lets you choose the **account type**:

| Account type | Who can sign in |
|---|---|
| Personal accounts only | Personal Microsoft accounts (same as the built-in) |
| Work/school + personal | Both work/school (Azure AD) and personal accounts |
| Work/school only | Work/school (Azure AD) accounts |
| Specific tenant | A single Azure AD directory (enter its tenant ID) |

This is what lets a custom OneDrive app reach work/school accounts the built-in (personal-only) connection cannot. Your selection must match the supported account types configured in your app registration, and work/school sign-in may still require your organization's admin consent.

> **Note**: The custom app still uses the same App Folder scope, so access stays confined to the plugin's own folder.

## Troubleshooting

- **Sync looks stuck or incomplete** (for example after Obsidian was closed mid-sync): Open **Settings → Air Sync → Advanced** and click **Rescan**. It re-checks everything against your cloud storage and finishes any leftover work — comparing files rather than re-downloading what you already have, and keeping your sync history.
- **Authentication completes but sync doesn't start**: Restart the plugin (disable → enable in Community plugins settings), then try syncing manually.
- **Token error after successful authorization**: Check that the device has a stable network connection — token exchange requires connectivity immediately after authorization.
- **The browser callback didn't return to Obsidian**: Try disconnecting and reconnecting from the plugin settings.

## Privacy & network use

Air Sync connects only to the cloud storage you choose, to sync your files:

- **Google Drive** — `googleapis.com` for sync; sign-in happens on `accounts.google.com`, and a small auth server (`auth-airsync.takezo.dev`) performs the sign-in token exchange.
- **OneDrive** — `graph.microsoft.com` for sync; sign-in happens on `login.microsoftonline.com` and returns directly to Obsidian (no relay or picker page — the folder is chosen in-app). Personal Microsoft accounts with the built-in connection; work/school accounts with a custom app.
- **Dropbox** — `api.dropboxapi.com` / `content.dropboxapi.com` for sync; sign-in happens on `dropbox.com` and returns directly to Obsidian (no relay or picker page — the folder is chosen in-app).

Your vault data is sent only to your chosen storage provider — never to the auth, redirect, or picker pages.

Air Sync only ever sees the folders it created — never the rest of your Google Drive, OneDrive, or Dropbox. (On OneDrive it uses the App Folder, so it can only access its own folder.)

## Disclaimer

This plugin is provided "as is", without warranty of any kind. The authors are not responsible for any loss or corruption of data, or any other damages arising from the use of this plugin. **Use at your own risk.** It is strongly recommended that you back up your vault before using this plugin.
