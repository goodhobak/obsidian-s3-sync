import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchHttpClient } from "../src/http/client";
import { S3Client } from "../src/s3/client";
import { SyncEngine } from "../src/sync/engine";
import { RemoteStore } from "../src/sync/remote-store";
import { DEFAULT_SETTINGS, type S3ConnectionSettings } from "../src/types";
import type { LocalFileStat, VaultFiles } from "../src/sync/vault-files";
import { InMemoryIndexStore } from "./fakes";

/**
 * End-to-end test against the user's REAL Obsidian vault subfolder and a live
 * RustFS. Enable with:
 *   LIVE_VAULT=1 LIVE_VAULT_ROOT="$HOME/Documents/Obsidian_remote/99_ZETTEL" \
 *     pnpm exec vitest run --config vitest.config.mts test/live-vault.test.ts
 *
 * Safety: the source is wrapped in a read-only VaultFiles that throws on any
 * write or delete, so the real vault cannot be mutated. Sync runs into an
 * isolated bucket prefix (empty remote => push-only). Pull verification goes to
 * a throwaway temp dir. Remote test objects are deleted in afterAll.
 */
const enabled = process.env["LIVE_VAULT"] === "1";
const vaultRoot = process.env["LIVE_VAULT_ROOT"] ?? "";

const conn: S3ConnectionSettings = {
  endpoint: process.env["RUSTFS_ENDPOINT"] ?? "http://localhost:9000",
  region: "us-east-1",
  bucket: process.env["RUSTFS_BUCKET"] ?? "obsidian-sync-test",
  accessKeyId: process.env["RUSTFS_ACCESS_KEY"] ?? "rustfsadmin",
  secretAccessKey: process.env["RUSTFS_SECRET_KEY"] ?? "rustfsadmin",
  prefix: "",
  forcePathStyle: true,
};

const runPrefix = `livevault-${Date.now().toString(36)}`;

/** Recursively list files under root, returning vault-relative POSIX paths. */
async function walk(root: string, rel = ""): Promise<LocalFileStat[]> {
  const out: LocalFileStat[] = [];
  const dir = rel ? join(root, rel) : root;
  for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
    if (dirent.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      out.push(...(await walk(root, childRel)));
    } else if (dirent.isFile()) {
      const st = await fs.stat(join(root, childRel));
      out.push({ path: childRel, size: st.size, mtime: Math.floor(st.mtimeMs) });
    }
  }
  return out;
}

/** Read-only source over the real vault; any mutation throws (safety). */
class ReadOnlyFsVault implements VaultFiles {
  constructor(private readonly root: string) {}
  async listFiles(): Promise<LocalFileStat[]> {
    return walk(this.root);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const buf = await fs.readFile(join(this.root, path));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  async writeBinary(): Promise<void> {
    throw new Error("SAFETY: refusing to write into the real vault");
  }
  async delete(): Promise<void> {
    throw new Error("SAFETY: refusing to delete from the real vault");
  }
  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(join(this.root, path));
      return true;
    } catch {
      return false;
    }
  }
  async stat(path: string): Promise<LocalFileStat | null> {
    try {
      const st = await fs.stat(join(this.root, path));
      return { path, size: st.size, mtime: Math.floor(st.mtimeMs) };
    } catch {
      return null;
    }
  }
}

/** Read-write target over a throwaway temp dir (the "second device"). */
class TempFsVault implements VaultFiles {
  constructor(private readonly root: string) {}
  async listFiles(): Promise<LocalFileStat[]> {
    try {
      return await walk(this.root);
    } catch {
      return [];
    }
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const buf = await fs.readFile(join(this.root, path));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const full = join(this.root, path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, new Uint8Array(data));
  }
  async delete(path: string): Promise<void> {
    await fs.rm(join(this.root, path), { force: true });
  }
  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(join(this.root, path));
      return true;
    } catch {
      return false;
    }
  }
  async stat(path: string): Promise<LocalFileStat | null> {
    try {
      const st = await fs.stat(join(this.root, path));
      return { path, size: st.size, mtime: Math.floor(st.mtimeMs) };
    } catch {
      return null;
    }
  }
}

function device(root: VaultFiles, prefix: string) {
  const s3 = new S3Client(new FetchHttpClient(), { ...conn, prefix });
  const remote = new RemoteStore(s3, { encryptionEnabled: false, encryptionPassphrase: "" });
  const engine = new SyncEngine(
    root,
    remote,
    new InMemoryIndexStore(),
    { extensions: [], excludedFolders: [], excludedFiles: [], maxFileSize: 0, syncObsidianConfig: false }, // markdown-only
    { versionsToKeep: 3, massDeleteThreshold: 0.5 },
    { confirmMassDelete: async () => false }, // never allow deletes in this test
  );
  return { s3, remote, engine };
}

describe.runIf(enabled)("live vault sync against RustFS", () => {
  let tempDir = "";

  beforeAll(async () => {
    expect(vaultRoot, "set LIVE_VAULT_ROOT").not.toBe("");
    await new S3Client(new FetchHttpClient(), conn).testConnection();
    tempDir = await fs.mkdtemp(join(tmpdir(), "s3sync-pull-"));
  });

  afterAll(async () => {
    // Clean up remote test objects and the temp pull dir. Never touches the vault.
    const s3 = new S3Client(new FetchHttpClient(), { ...conn, prefix: runPrefix });
    for (const obj of await s3.listObjects("")) {
      await s3.deleteObject(obj.key.slice(runPrefix.length + 1));
    }
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("pushes real markdown notes, then a second device pulls them back byte-identical", async () => {
    const source = new ReadOnlyFsVault(vaultRoot);
    const sourceFiles = await source.listFiles();
    const mdCount = sourceFiles.filter((f) => f.path.toLowerCase().endsWith(".md")).length;
    expect(mdCount).toBeGreaterThan(0);

    // --- push from the real vault (read-only source) ---
    const a = device(source, runPrefix);
    await a.remote.initialize();
    const up = await a.engine.syncOnce();
    expect(up.pushed).toBe(mdCount);
    expect(up.deletedLocal).toBe(0); // never mutates local
    expect(up.deletedRemote).toBe(0);
    expect(up.errors).toEqual([]);

    // --- pull onto a fresh device (temp dir) ---
    const b = device(new TempFsVault(tempDir), runPrefix);
    await b.remote.initialize();
    const down = await b.engine.syncOnce();
    expect(down.pulled).toBe(mdCount);
    expect(down.errors).toEqual([]);

    // --- byte-for-byte verification of a representative sample ---
    const mdPaths = sourceFiles.filter((f) => f.path.toLowerCase().endsWith(".md")).map((f) => f.path);
    const sample = mdPaths.filter((_, i) => i % Math.max(1, Math.floor(mdPaths.length / 40)) === 0);
    for (const p of sample) {
      const original = Buffer.from(await source.readBinary(p));
      const pulled = Buffer.from(await fs.readFile(join(tempDir, p)));
      expect(pulled.equals(original), `mismatch for ${p}`).toBe(true);
    }

    // --- idempotency: re-sync from the source is a no-op ---
    const a2 = device(source, runPrefix);
    await a2.remote.initialize();
    const again = await a2.engine.syncOnce();
    expect(again.pushed).toBe(0);
    expect(again.deletedRemote).toBe(0);
  }, 300_000);
});
