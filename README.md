# Air Sync

Sync your Obsidian vault bidirectionally with cloud storage, resolving conflicts and concurrent edits automatically via 3-way merge.

Works on both desktop and mobile, and currently supports Google Drive as a storage backend.

> **Requires a Google account.** This plugin communicates with Google Drive API (`googleapis.com`) for file sync and with an auth server (`auth-airsync.takezo.dev`) for OAuth token exchange. No vault data is sent to the auth server — it only handles authentication tokens. Custom OAuth lets you manage authorization independently.

## Features

- **Invisible two-way sync**: Local and remote stay in sync automatically on file changes, app focus, and network restore — you never have to trigger it
- **Always the latest version**: Opening a note immediately pulls the newest version if it changed on another device
- **Safe conflict resolution**: Concurrent edits to text files are merged automatically via 3-way merge; for everything else, choose auto merge, keep both copies, or be asked each time — with a built-in bias toward keeping files over deleting them
- **Control what syncs**: Exclude files and folders with glob patterns (e.g. `*.zip`, `large-assets/**`)

## Google Drive setup

1. Open the plugin settings (**Settings → Air Sync**)
2. Click the **Connect to Google Drive** button
3. Complete the Google account authorization in the browser
4. The plugin automatically receives the callback via `obsidian://` protocol handler
5. A remote vault folder is created automatically in your Google Drive

If the automatic callback fails, try disconnecting and reconnecting from the plugin settings.

The first sync after connecting performs a full scan of the Drive folder. This may take some time depending on vault size. Subsequent syncs use incremental change detection and are much faster.

### Custom OAuth (advanced)

The built-in OAuth uses the `drive.file` scope, which only allows access to files created by the plugin itself. With custom OAuth, you can use your own Google Cloud OAuth client to manage authorization independently.

The authorization code exchange is protected by PKCE — the code cannot be used without the verifier held only by the plugin.

> **Note**: Tokens are stored in Obsidian's secret storage, which is accessible to other plugins. The built-in OAuth limits exposure with the `drive.file` scope. Custom OAuth may increase risk depending on the scope you configure.

### Troubleshooting

- **Authentication completes but sync doesn't start**: Restart the plugin (disable → enable in Community plugins settings), then try syncing manually
- **Token error after successful authorization**: Check that the device has a stable network connection — token exchange requires connectivity immediately after authorization
- **Protocol handler not triggered**: Try disconnecting and reconnecting from the plugin settings

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Backend | Storage backend for sync | Google Drive (or Google Drive custom OAuth) |
| Conflict strategy | Resolution strategy for conflicts (see below) | Auto merge |

### Advanced

| Setting | Description | Default |
|---------|-------------|---------|
| Dot-prefixed paths to sync | Dot-prefixed folders to include in sync (e.g. `.templates`) | (none) |
| Ignore patterns | Glob patterns to exclude (one per line) | Desktop: (none), Mobile: `.md`/`.canvas`/`.base` only |
| Mobile max file size | Skip files larger than this on mobile | 10 MB |
| Enable logging | Write sync logs to `.airsync/` in your vault | Off |
| Log level | Minimum log level (debug / info / warn / error) | info |

### Conflict resolution strategies

| Strategy | Behavior |
|----------|----------|
| Auto merge (recommended) | Attempts 3-way merge for text files using the last-synced content as the base. If merge is not possible (binary file, no base content, or merge failure), falls back to keep newer (by mtime). If mtime is equal or unknown, creates a duplicate. |
| Duplicate | Always saves the remote version as a `.conflict` file and keeps the local version at the original path. |
| Ask | Shows a modal for each conflict, letting you choose keep local, keep remote, or duplicate. |

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

## Commands

| Command | Description |
|---------|-------------|
| `Air Sync: Sync now` | Run sync manually |

## Disclaimer

This plugin is provided "as is", without warranty of any kind. The authors are not responsible for any loss or corruption of data, or any other damages arising from the use of this plugin. **Use at your own risk.** It is strongly recommended that you back up your vault before using this plugin.

## License

MIT
