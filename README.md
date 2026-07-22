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
- **Existing files are handled conservatively.** A first sync *merges* both sides — a file on only one side is copied to the other, never deleted — so a new device or an already-populated folder just brings both sets together. A file is removed only when one that was already in sync gets deleted, and even then it goes to the trash on both sides (recoverable). Clashing edits keep both. Details: [deletion safety](docs/sync-pipeline.md#deletion-safety), [conflict strategies](#conflict-resolution-strategies).

## Conflict resolution strategies

| Strategy | Behavior |
|----------|----------|
| Auto merge (recommended) | Attempts 3-way merge for text files using the last-synced content as the base. If merge is not possible (binary file, no base content, or merge failure), falls back to keeping the newer version by mtime — which replaces the older one. Only when the two can't be ordered (equal or unknown mtime, differing content) does it keep both as a duplicate. |
| Duplicate | When both sides exist, keeps the local version at its original path and saves the remote version alongside it as a `.conflict` file. When an edit clashes with a deletion, the surviving version is restored — the deletion never wins. |

An edit that clashes with a deletion never loses the edit under either strategy. The difference is edit-vs-edit: Auto merge may keep only the newer version, while Duplicate always preserves both. For the complete decision logic — merge eligibility, mtime tie-breaks, and conflict-file naming — see [docs/conflict-resolution.md](docs/conflict-resolution.md).

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

- **A file still looks out of sync after a sync has run** (a note that won't update, or the two sides disagree, and repeated syncs don't fix it): Open **Settings → Air Sync → Advanced** and click **Rescan**. It re-checks your whole vault against your cloud storage from scratch — rather than only what changed since the last sync — comparing files by content, so it re-transfers only what genuinely differs and doesn't reset your existing sync state.
- **Connected, but nothing syncs**: Connecting only authorizes Air Sync — it doesn't sync yet. Make sure you've chosen a remote folder (the **default folder** or **pick an existing folder**); the first sync starts as soon as a folder is selected. On mobile, keep Obsidian open in the foreground while it runs.
- **Files still don't sync after choosing a folder**: Trigger a sync yourself with the **`Air Sync: Sync now`** command, or by clicking the cloud icon in the status bar. The status bar text (Synced / Syncing… / Sync error / Not connected) shows the current state. If it still doesn't run, restart the plugin (disable → enable in Community plugins settings) and try again.
- **Seeing conflicts or `.conflict` files**: These appear when the same file changed on two devices, or when another sync tool is also writing your vault (see [Your vault and your devices](#your-vault-and-your-devices)). When reporting a conflict, please include the file path(s), which devices were involved and the order you edited them, your selected conflict strategy, and — if logging is enabled (**Enable logging** in settings, which writes to `.airsync/` in your vault) — the diagnostic logs. That's what distinguishes a sync-engine issue from a multiple-writer setup.
- **"Authorization failed" right after approving access**: The token exchange needs a working connection immediately after you approve access. Check that the device is online, then click **Connect** and approve access again.
- **The browser didn't return to Obsidian after approving access**: You aren't connected yet, so there's nothing to disconnect — just click **Connect** in the plugin settings to start the flow again.
- **"Authentication expired. Please reconnect in settings."**: Your saved authorization is no longer valid (for example access was revoked, or a refresh token expired). Open **Settings → Air Sync** and reconnect.

## Privacy & network use

Air Sync connects only to the cloud storage you choose, to sync your files:

- **Google Drive** — `googleapis.com` for sync; sign-in happens on `accounts.google.com`, and a small auth server (`auth-airsync.takezo.dev`) performs the sign-in token exchange.
- **OneDrive** — `graph.microsoft.com` for sync; sign-in happens on `login.microsoftonline.com` and returns directly to Obsidian (no relay or picker page — the folder is chosen in-app).
- **Dropbox** — `api.dropboxapi.com` / `content.dropboxapi.com` for sync; sign-in happens on `dropbox.com` and returns directly to Obsidian (no relay or picker page — the folder is chosen in-app).

Your vault data is sent only to your chosen storage provider — never to the auth, redirect, or picker pages.

Air Sync only ever sees the folders it created — never the rest of your Google Drive, OneDrive, or Dropbox. (On OneDrive it uses the App Folder, so it can only access its own folder.)

## Disclaimer

This plugin is provided "as is", without warranty of any kind. The authors are not responsible for any loss or corruption of data, or any other damages arising from the use of this plugin. **Use at your own risk.** It is strongly recommended that you back up your vault before using this plugin.
