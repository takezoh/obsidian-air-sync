# Air Sync

Your Obsidian notes, always up to date on every device — without ever thinking about sync. Edit on your laptop, pick up your phone, and it's caught up before you start typing.

Works on desktop and mobile, powered by your own cloud storage — **Google Drive**, or **Dropbox** (Preview).

> **Requires a Google or Dropbox account.**

## What you get

- **Sync you never notice**: Your vault stays in sync on its own — after every edit, when you switch back to Obsidian, and the moment your connection comes back. You never press a button.
- **Always the latest version**: Open a note and it pulls in the newest version if it changed on another device.
- **Never lose work to a conflict**: Edits made on two devices at once are merged for you. When they truly clash, Air Sync keeps every version safe instead of overwriting — you choose how, and it always keeps files rather than deleting them when in doubt.
- **Set up in a minute**: Connect your cloud account once. There's almost nothing to configure.
- **Control what syncs**: Keep large or private files from syncing, using simple patterns (e.g. `*.zip`, `large-assets/**`).

## Getting started

> **Requires a Google or Dropbox account.**

1. Open the plugin settings (**Settings → Air Sync**).
2. Pick your backend (**Google Drive** or **Dropbox** (Preview)) if more than one is available.
3. Click **Connect to …** (e.g. **Connect to Google Drive** or **Connect to Dropbox**), then approve access in your browser.
4. Choose where to sync: use the **default folder** (named after your vault), or **pick an existing folder**.

That's it — Air Sync syncs into that folder from then on.

The first sync scans your remote folder, so it may take a little while. After that, syncing is fast.

> **Using more than one device?** Air Sync identifies your vault's folder by your vault's name. Connect the other device to the same account, give the vault the same name, and choose the default folder — they'll sync together. A different vault name uses a separate folder that won't sync with the others.

> **Dropbox is in Preview.** While it's in Preview, you supply your own Dropbox **app key** in settings before connecting (Air Sync's own key isn't built in yet). It keeps everything inside its own app folder (`Apps/Air Sync/`), so Air Sync only ever sees the folders it created — not the rest of your Dropbox. To sync into a different folder under there, use **Choose folder** in settings after connecting.

## Settings

The defaults work for most people — you rarely need to change these.

| Setting | Description | Default |
|---------|-------------|---------|
| Backend | Storage backend for sync | Google Drive, Google Drive (custom OAuth), or Dropbox (Preview) |
| Conflict strategy | How conflicting edits are resolved (see [Conflict resolution strategies](#conflict-resolution-strategies)) | Auto merge |

## Commands

| Command | Description |
|---------|-------------|
| `Air Sync: Sync now` | Run a sync manually |

---

## Advanced

### Conflict resolution strategies

| Strategy | Behavior |
|----------|----------|
| Auto merge (recommended) | Attempts 3-way merge for text files using the last-synced content as the base. If merge is not possible (binary file, no base content, or merge failure), falls back to keep newer (by mtime). If mtime is equal or unknown, creates a duplicate. |
| Duplicate | Always saves the remote version as a `.conflict` file and keeps the local version at the original path. |

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

### Advanced settings

| Setting | Description | Default |
|---------|-------------|---------|
| Dot-prefixed paths to sync | Dot-prefixed folders to include in sync (e.g. `.templates`) | (none) |
| Ignore patterns | Glob patterns to exclude (one per line) | Desktop: (none), Mobile: `.md`/`.canvas`/`.base` only |
| Mobile max file size | Skip files larger than this on mobile | 10 MB |
| Enable logging | Write sync logs to `.airsync/` in your vault | Off |
| Log level | Minimum log level (debug / info / warn / error) | info |

### Custom OAuth (Google Drive)

The built-in Google Drive connection uses the `drive.file` scope, which only allows access to files the plugin itself created. With custom OAuth, you can use your own Google Cloud OAuth client and manage authorization independently.

The authorization code exchange is protected by PKCE — the code cannot be used without the verifier held only by the plugin.

> **Note**: Tokens are stored in Obsidian's secret storage, which is accessible to other plugins. The built-in OAuth limits exposure with the `drive.file` scope. Custom OAuth may increase risk depending on the scope you configure.

## Troubleshooting

- **Sync looks stuck or incomplete** (for example after Obsidian was closed mid-sync): Open **Settings → Air Sync → Advanced** and click **Rescan**. It re-checks everything against your cloud storage and finishes any leftover work — comparing files rather than re-downloading what you already have, and keeping your sync history.
- **Authentication completes but sync doesn't start**: Restart the plugin (disable → enable in Community plugins settings), then try syncing manually.
- **Token error after successful authorization**: Check that the device has a stable network connection — token exchange requires connectivity immediately after authorization.
- **The browser callback didn't return to Obsidian**: Try disconnecting and reconnecting from the plugin settings.

## Privacy & network use

> Air Sync connects only to the cloud storage you choose, to sync your files:
> - **Google Drive** — `googleapis.com` for sync; sign-in happens on `accounts.google.com`, and a small auth server (`auth-airsync.takezo.dev`) performs the sign-in token exchange.
> - **Dropbox** — `api.dropboxapi.com` / `content.dropboxapi.com` for sync; sign-in and the folder picker run on `dropbox.com`, reached through helper pages on `airsync.takezo.dev` that redirect the sign-in result back to Obsidian and host the folder picker.
>
> Your vault data is sent only to your chosen storage provider — never to the auth, redirect, or picker pages.

## Disclaimer

This plugin is provided "as is", without warranty of any kind. The authors are not responsible for any loss or corruption of data, or any other damages arising from the use of this plugin. **Use at your own risk.** It is strongly recommended that you back up your vault before using this plugin.
