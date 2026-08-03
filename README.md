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
  pruned to N per file) and restorable from a modal.
- **End-to-end encryption (optional)** — AES-256-GCM with keys derived from a
  passphrase (PBKDF2, 600k iterations). File contents *and* the manifest are
  encrypted; object keys are opaque ids, so the server learns neither your
  note paths nor their contents.
- **Filtering** — markdown always syncs; images/audio/video/PDF by default;
  other extensions opt-in; excluded folders; max file size; hidden files never
  sync.

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

## Caveats

- Two devices must not sync the *first* version of the same vault prefix at
  the same instant with different encryption settings; the `meta/vault.json`
  bootstrap is `If-None-Match`-guarded, so one of them fails cleanly — rerun.
- Renames are synced as delete + add (no server-side move optimization yet).
- The passphrase is stored in plugin data on each device; losing it makes an
  encrypted remote vault unrecoverable.
