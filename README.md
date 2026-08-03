# Obsidian S3 Sync

Sync your Obsidian vault with any S3-compatible storage — **RustFS**, MinIO,
AWS S3, Cloudflare R2 — with no sync server in between. Optional end-to-end
encryption. Works on desktop and mobile.

## Features

- **Direct S3 sync** — the plugin talks straight to your bucket with AWS
  Signature V4. No companion server, no account, no subscription.
- **Mobile-compatible** — no AWS SDK; a lightweight SigV4 client built on
  Obsidian's `requestUrl` (bypasses CORS, runs on iOS/Android).
- **True bi-directional sync** — a remote manifest plus a local index give
  every file a base/local/remote 3-way view, so edits, deletes, and new files
  propagate correctly between any number of devices.
- **Multi-device safe** — the manifest is written with `If-Match` conditional
  requests (optimistic locking). A losing device retries on a fresh view
  instead of clobbering the winner. Verified against RustFS.
- **Conflict handling that never discards content** — concurrent edits to the
  same markdown file are 3-way merged when the edits don't overlap; otherwise
  the other version lands as a `Note (conflict 2026-08-03 154233).md` copy.
- **Deletion safety** — deletions propagate via tombstones (30-day TTL), local
  deletions go to the trash per your Obsidian preference, and a mass-delete
  guard asks before a sync removes a large share of the vault.
- **Version history** — old versions are kept server-side (content-addressed,
  pruned to N per file). Right-click any file → **S3 Sync: version history** to
  see every stored version, **compare** a diff against the current file, and
  **restore** one.
- **Sync log** — every run is recorded (pushed/pulled/deleted/merged/conflicts/
  errors, newest first). Open it with the **Show sync log** command.
- **Resolve conflicts & errors** — when a sync keeps both versions of a file
  (conflict copy) or a file fails to sync, the **Resolve conflicts and errors**
  command (or the "Resolve" link in the notice / sync log) opens a window to
  compare the two versions and choose *keep remote*, *use my version*, or *open
  both to merge by hand*; failed files get a one-click retry.
- **End-to-end encryption (optional)** — AES-256-GCM with keys derived from a
  passphrase (PBKDF2, 600k iterations). File contents *and* the manifest are
  encrypted; object keys are opaque ids, so the server learns neither your
  note paths nor their contents.
- **Filtering** — markdown always syncs; images/audio/video/PDF by default;
  other extensions opt-in; a searchable folder-exclusion list (with an
  "include subfolders" option and an Apply button); max file size; hidden
  files never sync.
- **Optional `.obsidian` config sync** — sync your plugins, themes, snippets
  and settings across devices. This plugin's own folder and per-device
  workspace layout are always excluded, so your S3 credentials and passphrase
  are never uploaded. Off by default; enable it on every device for two-way
  config sync.
- **Inbound / outbound indicators** — the status bar and side panel show live
  `↓ downloaded` / `↑ uploaded` counts during a sync.
- **Right-sidebar panel** — a cloud icon in the ribbon opens a panel with
  tabbed action buttons (Sync now, Version history, Resolve, Log, Test,
  Reset, Settings), a live status tab, and a recent-runs log.

## Install with BRAT

This plugin isn't in the community directory yet. Install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable **BRAT** from Community plugins.
2. BRAT → **Add beta plugin** → enter `https://github.com/goodhobak/obsidian-s3-sync`.
3. BRAT installs the latest release and enables **S3 Sync**.

To update later: BRAT → **Check for updates**.

## Quick start with RustFS

1. Run RustFS (or any S3 server) and create a bucket:
   ```bash
   docker run -d -p 9000:9000 -e RUSTFS_VOLUMES=/data \
     -e RUSTFS_ACCESS_KEY=rustfsadmin -e RUSTFS_SECRET_KEY=rustfsadmin \
     -v rustfs-data:/data rustfs/rustfs:latest
   aws --endpoint-url http://localhost:9000 s3 mb s3://obsidian
   ```
2. Copy `main.js`, `manifest.json`, `styles.css` into
   `<vault>/.obsidian/plugins/s3-sync/` and enable the plugin.
3. In the plugin settings, set endpoint `http://localhost:9000`, bucket
   `obsidian`, your keys, keep **Path-style addressing** on, and press
   **Test**.
4. Decide about end-to-end encryption **before the first sync** (the remote
   vault records the choice), then run **S3 Sync: Sync now**.

## Remote layout

```
<prefix>/
  meta/vault.json        # plaintext marker: encrypted? KDF params, key-check
  meta/manifest.json     # (or manifest.enc) file index, ETag-locked
  files/<path>           # plaintext mode: live blobs mirror vault paths
  blobs/<random-id>      # encrypted mode: opaque live blobs
  history/<sha256>       # content-addressed old versions
```

## Development

```bash
pnpm install
pnpm test            # unit tests (SigV4 vectors, engine scenarios, crypto)
pnpm build           # typecheck + production bundle
pnpm integration     # end-to-end against RustFS on localhost:9000
```

Integration env vars: `RUSTFS_ENDPOINT`, `RUSTFS_BUCKET`, `RUSTFS_ACCESS_KEY`,
`RUSTFS_SECRET_KEY`.

## Releasing (auto-update)

Installed copies auto-update because each release ships `main.js`,
`manifest.json` and `styles.css` as assets and `versions.json` records the
minimum app version. BRAT checks for and applies updates (enable "Auto-update
plugins at startup" in BRAT, or use **Check for updates**).

To cut a new version, just bump and push a tag — GitHub Actions
(`.github/workflows/release.yml`) type-checks, tests, builds, and publishes the
release automatically:

```bash
pnpm version 0.1.1 --no-git-tag-version   # syncs manifest.json + versions.json
git commit -am "chore: release 0.1.1"
git tag 0.1.1 && git push origin main --tags
```

## Security model

- **Untrusted server.** Every downloaded blob is verified: its SHA-256 must
  match the (authenticated) manifest entry, and in encrypted mode the content
  hash is bound into the AES-GCM AAD. A malicious or corrupt server cannot
  swap, tamper with, or substitute file contents — a failed check skips the
  file rather than writing bad bytes.
- **No out-of-vault writes.** Remote-controlled manifest paths are validated
  (`..`, absolute, empty segments, backslashes, and NUL are rejected) before
  any file is written, so a hostile manifest cannot escape the vault.
- **Rollback protection.** If the remote manifest revision goes backwards
  (replay, or a bucket restored from backup), sync refuses to run rather than
  resurrecting deleted notes. To intentionally accept an older bucket, use
  **Reset local sync state** in settings.
- **Secrets on disk.** The S3 secret key and the E2E passphrase are stored in
  the plugin's `data.json` (Obsidian has no secure-storage API). They live
  under `.obsidian` and are never uploaded, but anyone who can read that
  folder can read them. Treat the device as part of your trust boundary.

## Caveats

- Two devices must not sync the *first* version of the same vault prefix at
  the same instant with different encryption settings; the `meta/vault.json`
  bootstrap is `If-None-Match`-guarded, so one of them fails cleanly — rerun.
- Renames are synced as delete + add (no server-side move optimization yet).
- The passphrase is stored in plugin data on each device; losing it makes an
  encrypted remote vault unrecoverable. There is no passphrase confirmation
  field yet, so double-check it when first creating an encrypted vault.
- Case-only renames (`Note.md` → `note.md`) are handled so the file is not
  lost on macOS/iOS, but two files differing only in case cannot coexist in
  one vault on a case-insensitive filesystem.
