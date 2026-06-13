# Air Sync

Your Obsidian notes, always up to date on every device — without ever thinking about sync. Edit on your laptop, pick up your phone, and it's caught up before you start typing.

Works on desktop and mobile, powered by your own cloud storage:

- **Google Drive**
- **Dropbox** — *Preview*
- **OneDrive** — *Preview* (personal Microsoft accounts only)

## What you get

- **Sync you never notice**: Your vault stays in sync on its own — after every edit, when you switch back to Obsidian, and the moment your connection comes back. You never press a button.
- **Always the latest version**: Open a note and it pulls in the newest version if it changed on another device.
- **Never lose work to a conflict**: Edits made on two devices at once are merged for you. When they truly clash, Air Sync keeps every version safe instead of overwriting — you choose how, and it always keeps files rather than deleting them when in doubt.
- **Set up in a minute**: Connect your cloud account once. There's almost nothing to configure.
- **Control what syncs**: Keep large or private files from syncing, using simple patterns (e.g. `*.zip`, `large-assets/**`).

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

## Settings

All settings live under **Settings → Air Sync**.

| Setting | What it does |
|---------|--------------|
| Conflict strategy | How to resolve a file changed on two devices at once — **Auto merge** (recommended) or **Always create duplicate**. See [Conflict resolution strategies](#conflict-resolution-strategies). |
| Remote backend | Which cloud service to sync with. Shown only when more than one backend is available. |
| Rescan vault | Discards the remote sync checkpoint and fully reconciles on the next sync. Use it if sync seems stuck after an interruption (see Troubleshooting). |
| Dot-prefixed paths to sync | Dot-prefixed folders to include in sync (e.g. `.templates`), one per line. |
| Ignore patterns | Gitignore-style patterns to exclude from sync (e.g. `*.zip`, `large-assets/**`), one per line. |
| Mobile max file size (MB) | Files larger than this are skipped on mobile. Default `10`. |
| Keep screen awake during sync | Mobile only — prevents the screen from sleeping mid-sync so long syncs aren't interrupted. Default off. |
| Show sync notifications | Show a brief notice summarizing each completed sync. Default off. |
| Enable logging | Write sync logs to `.airsync/` in your vault for debugging. Default off. |
| Log level | Minimum level of messages to log (Debug / Info / Warn / Error). Default Info. |

> Auto merge uses a 3-way merge for text files; it is always on as part of the Auto-merge strategy and has no separate toggle.

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

## Troubleshooting

- **Sync looks stuck or incomplete** (for example after Obsidian was closed mid-sync): Open **Settings → Air Sync → Advanced** and click **Rescan**. It re-checks everything against your cloud storage and finishes any leftover work — comparing files rather than re-downloading what you already have, and keeping your sync history.
- **Authentication completes but sync doesn't start**: Restart the plugin (disable → enable in Community plugins settings), then try syncing manually.
- **Token error after successful authorization**: Check that the device has a stable network connection — token exchange requires connectivity immediately after authorization.
- **The browser callback didn't return to Obsidian**: Try disconnecting and reconnecting from the plugin settings.

## Privacy & network use

Air Sync connects only to the cloud storage you choose, to sync your files:

- **Google Drive** — `googleapis.com` for sync; sign-in happens on `accounts.google.com`, and a small auth server (`auth-airsync.takezo.dev`) performs the sign-in token exchange.
- **Dropbox** — `api.dropboxapi.com` / `content.dropboxapi.com` for sync; sign-in happens on `dropbox.com` and returns directly to Obsidian (no relay or picker page — the folder is chosen in-app).
- **OneDrive** — `graph.microsoft.com` for sync; sign-in happens on `login.microsoftonline.com` and returns directly to Obsidian (no relay or picker page — the folder is chosen in-app). Personal Microsoft accounts only.

Your vault data is sent only to your chosen storage provider — never to the auth, redirect, or picker pages.

Air Sync only ever sees the folders it created — never the rest of your Google Drive, Dropbox, or OneDrive. (On OneDrive it uses the App Folder, so it can only access its own folder.)

## Disclaimer

This plugin is provided "as is", without warranty of any kind. The authors are not responsible for any loss or corruption of data, or any other damages arising from the use of this plugin. **Use at your own risk.** It is strongly recommended that you back up your vault before using this plugin.
