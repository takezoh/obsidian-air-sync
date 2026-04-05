# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- `.airsync` (the sync-state folder) is no longer synced by default. Users who want it
  synced can add `.airsync` to the *Dot paths to sync* list. `LocalFs` now uses the Obsidian
  vault API for all normal paths and falls back to raw file I/O only for dot-prefixed paths
  explicitly listed for sync; the `DotPathAdapter` shim has been removed.

## [0.1.17] - 2026-03-29

### Added
- Rename/move propagation: local file renames are now detected and pushed to the remote as
  native rename operations rather than a delete + re-upload.
- Remote renames are applied locally using the native `localFs.rename()` API when available.
- Folder renames are coalesced into a single rename action so that moving a directory does
  not generate one action per descendant file.

### Fixed
- Rename optimization was not firing when the hot filter or hash comparison rejected
  candidate pairs.
- Remote folder-rename coalescing was scanning sync actions instead of file pairs.
- `isFolder` flag was not being set on full-scan-delta rename pairs; consumed pairs were
  not being filtered out after a folder rename matched.
- Deleted old paths were not being reported when a remote file was moved or renamed.
