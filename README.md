# Air Sync

Your Obsidian notes, always up to date on every device — without ever thinking about sync. Edit on your laptop, pick up your phone, and it's caught up before you start typing.

Works on desktop and mobile, powered by your own cloud storage:

- **Google Drive**
- **OneDrive**
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

### Your vault and your devices

- **Keep your vault in local storage.** Create your Obsidian vault on your device — **not** inside a folder that another cloud drive already syncs (iCloud Drive, or the Dropbox / OneDrive / Google Drive desktop apps). Air Sync copies your notes to the cloud for you.
- **Don't open the cloud folder as a vault.** The folder Air Sync creates in your cloud storage is a managed mirror — opening it directly in Obsidian as a vault is not supported. Keep working in your local vault; Air Sync keeps the cloud copy in step.
- **Let Air Sync be the only sync tool for a vault.** Two sync mechanisms managing the same files at once is a common cause of conflicts.
- **Use the same folder on every device.** During setup you choose which cloud folder to sync into — pick the **same folder** on each device so they share one set of notes.
- **Conflicting changes keep both versions.** Your edits and deletions sync normally. But when two changes genuinely clash — the same note edited on two devices, or edited on one and deleted on another — Air Sync saves both as a conflict copy rather than silently overwriting or dropping one. See [Conflict resolution strategies](#conflict-resolution-strategies) for how it decides.

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

## Custom OAuth apps

Prefer your own cloud app over the built-in connection? Air Sync supports a **custom app / custom OAuth** backend for Google Drive, OneDrive, and Dropbox — you register the app with the provider and enter its identifiers in Air Sync. This is also the way to reach OneDrive work/school accounts.

See the **[custom app setup guide](docs/custom-apps.md)** for what each backend needs and how it maps to Air Sync's settings. The guide links to each provider's official developer documentation for the registration steps themselves.

> **Note**: Custom apps still use a scoped / App Folder connection, so access stays confined to the plugin's own folder. Tokens are stored in Obsidian's secret storage (accessible to other plugins); a broader scope you configure yourself may increase exposure.

## Troubleshooting

- **Sync looks stuck or incomplete** (for example after Obsidian was closed mid-sync): Open **Settings → Air Sync → Advanced** and click **Rescan**. It re-checks everything against your cloud storage and finishes any leftover work — comparing files rather than re-downloading what you already have, and keeping your sync history.
- **Connected, but no files download**: Connecting only authorizes Air Sync — it doesn't sync yet. Make sure you've chosen a remote folder (the **default folder** or **pick an existing folder**); the first sync starts as soon as a folder is selected. On mobile, keep Obsidian open in the foreground while it runs.
- **Authentication completes but sync doesn't start**: First confirm a remote folder is chosen (see above). If it still doesn't start, restart the plugin (disable → enable in Community plugins settings), then try syncing manually.
- **Seeing conflicts or `.conflict` files**: These appear when the same file changed on two devices, or when another sync tool is also writing your vault (see [Your vault and your devices](#your-vault-and-your-devices)). When reporting a conflict, please include the file path(s), which devices were involved and the order you edited them, your selected conflict strategy, and — if logging is enabled — the diagnostic logs. That's what distinguishes a sync-engine issue from a multiple-writer setup.
- **Token error after successful authorization**: Check that the device has a stable network connection — token exchange requires connectivity immediately after authorization.
- **The browser callback didn't return to Obsidian**: Try disconnecting and reconnecting from the plugin settings.

## Privacy & network use

Air Sync connects only to the cloud storage you choose, to sync your files:

- **Google Drive** — `googleapis.com` for sync; sign-in happens on `accounts.google.com`, and a small auth server (`auth-airsync.takezo.dev`) performs the sign-in token exchange.
- **OneDrive** — `graph.microsoft.com` for sync; sign-in happens on `login.microsoftonline.com` and returns directly to Obsidian (no relay or picker page — the folder is chosen in-app).
- **Dropbox** — `api.dropboxapi.com` / `content.dropboxapi.com` for sync; sign-in happens on `dropbox.com` and returns directly to Obsidian (no relay or picker page — the folder is chosen in-app).

Your vault data is sent only to your chosen storage provider — never to the auth, redirect, or picker pages.

Air Sync only ever sees the folders it created — never the rest of your Google Drive, OneDrive, or Dropbox. (On OneDrive it uses the App Folder, so it can only access its own folder.)

## Disclaimer

This plugin is provided "as is", without warranty of any kind. The authors are not responsible for any loss or corruption of data, or any other damages arising from the use of this plugin. **Use at your own risk.** It is strongly recommended that you back up your vault before using this plugin.
