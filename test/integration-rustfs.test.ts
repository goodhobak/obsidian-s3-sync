import { beforeAll, describe, expect, it } from "vitest";
import { FetchHttpClient } from "../src/http/client";
import { S3Client } from "../src/s3/client";
import { SyncEngine } from "../src/sync/engine";
import { ManifestConflictError, RemoteStore } from "../src/sync/remote-store";
import { DEFAULT_SETTINGS, type S3ConnectionSettings } from "../src/types";
import { InMemoryIndexStore, InMemoryVault } from "./fakes";

/**
 * End-to-end run against a real S3-compatible server (RustFS).
 * Enable with: RUSTFS_INTEGRATION=1 pnpm integration
 */
const enabled = process.env["RUSTFS_INTEGRATION"] === "1";

const conn: S3ConnectionSettings = {
  endpoint: process.env["RUSTFS_ENDPOINT"] ?? "http://localhost:9000",
  region: "us-east-1",
  bucket: process.env["RUSTFS_BUCKET"] ?? "obsidian-sync-test",
  accessKeyId: process.env["RUSTFS_ACCESS_KEY"] ?? "rustfsadmin",
  secretAccessKey: process.env["RUSTFS_SECRET_KEY"] ?? "rustfsadmin",
  prefix: "",
  forcePathStyle: true,
};

const runId = `it-${Date.now().toString(36)}`;

function makeDevice(prefix: string, encryption?: { passphrase: string }) {
  const s3 = new S3Client(new FetchHttpClient(), { ...conn, prefix });
  const vault = new InMemoryVault();
  const remote = new RemoteStore(s3, {
    encryptionEnabled: Boolean(encryption),
    encryptionPassphrase: encryption?.passphrase ?? "",
  });
  const engine = new SyncEngine(
    vault,
    remote,
    new InMemoryIndexStore(),
    DEFAULT_SETTINGS.filters,
    { versionsToKeep: 3, massDeleteThreshold: 0.5 },
    { confirmMassDelete: async () => true },
  );
  return { s3, vault, remote, engine };
}

describe.runIf(enabled)("RustFS integration", () => {
  beforeAll(async () => {
    const probe = new S3Client(new FetchHttpClient(), conn);
    await probe.testConnection();
  });

  it("does basic object CRUD with SigV4 auth", async () => {
    const { s3 } = makeDevice(`${runId}/crud`);
    const body = new TextEncoder().encode("hello rustfs — 한글 콘텐츠").buffer as ArrayBuffer;
    await s3.putObject("files/한글 노트 & specials.md", body);

    const got = await s3.getObject("files/한글 노트 & specials.md");
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.body)).toContain("한글 콘텐츠");

    const listed = await s3.listObjects("files/");
    expect(listed.map((o) => o.key)).toContain(`${runId}/crud/files/한글 노트 & specials.md`);

    await s3.deleteObject("files/한글 노트 & specials.md");
    expect(await s3.getObject("files/한글 노트 & specials.md")).toBeNull();
  });

  it("enforces conditional writes for manifest locking", async () => {
    const { s3 } = makeDevice(`${runId}/cond`);
    const bodyA = new TextEncoder().encode("A").buffer as ArrayBuffer;
    const bodyB = new TextEncoder().encode("B").buffer as ArrayBuffer;

    const first = await s3.putObject("meta/lock-probe", bodyA, { ifNoneMatch: true });
    expect(first.etag).toBeTruthy();

    // If-None-Match must reject a second create.
    await expect(s3.putObject("meta/lock-probe", bodyB, { ifNoneMatch: true })).rejects.toThrow();

    // If-Match with the current etag succeeds; a stale etag must fail.
    const second = await s3.putObject("meta/lock-probe", bodyB, { ifMatch: first.etag! });
    await expect(s3.putObject("meta/lock-probe", bodyA, { ifMatch: first.etag! })).rejects.toThrow();
    expect(second.etag).not.toBe(first.etag);
  });

  it("syncs two devices bi-directionally (plaintext)", async () => {
    const prefix = `${runId}/plain`;
    const a = makeDevice(prefix);
    const b = makeDevice(prefix);

    a.vault.write("notes/first.md", "# from A");
    a.vault.write("img/pic.png", "PNG-bytes");
    await a.remote.initialize();
    const up = await a.engine.syncOnce();
    expect(up.pushed).toBe(2);

    await b.remote.initialize();
    const down = await b.engine.syncOnce();
    expect(down.pulled).toBe(2);
    expect(b.vault.read("notes/first.md")).toBe("# from A");

    // Edit on B, delete on A propagate correctly.
    b.vault.write("notes/first.md", "# edited on B");
    await b.engine.syncOnce();
    a.vault.remove("img/pic.png");
    const mixed = await a.engine.syncOnce();
    expect(mixed.pulled).toBe(1);
    expect(mixed.deletedRemote).toBe(1);
    expect(a.vault.read("notes/first.md")).toBe("# edited on B");

    const bFinal = await b.engine.syncOnce();
    expect(bFinal.deletedLocal).toBe(1);
    expect(b.vault.read("img/pic.png")).toBeNull();
  });

  it("detects manifest races between devices", async () => {
    const prefix = `${runId}/race`;
    const winner = makeDevice(prefix);
    winner.vault.write("w.md", "winner");
    await winner.remote.initialize();

    const loser = makeDevice(prefix);
    await loser.remote.initialize();
    const { etag: staleEtag } = await loser.remote.loadManifest();

    await winner.engine.syncOnce(); // manifest now exists / changed

    const manifest = { schemaVersion: 1 as const, revision: 99, updatedAt: 1, files: {} };
    await expect(loser.remote.saveManifest(manifest, staleEtag)).rejects.toBeInstanceOf(ManifestConflictError);
  });

  it("keeps restorable version history on the server", async () => {
    const prefix = `${runId}/hist`;
    const a = makeDevice(prefix);
    await a.remote.initialize();
    a.vault.write("doc.md", "v1 content");
    await a.engine.syncOnce();
    a.vault.write("doc.md", "v2 content");
    await a.engine.syncOnce();

    const { manifest } = await a.remote.loadManifest();
    const entry = manifest.files["doc.md"];
    expect(entry?.history?.length).toBe(1);
    expect(await a.engine.restoreVersion("doc.md", entry!.history![0]!.hash)).toBe(true);
    expect(a.vault.read("doc.md")).toBe("v1 content");
  });

  it("syncs an end-to-end encrypted vault without leaking plaintext", async () => {
    const prefix = `${runId}/enc`;
    const a = makeDevice(prefix, { passphrase: "integration-pw" });
    const b = makeDevice(prefix, { passphrase: "integration-pw" });

    a.vault.write("secret/plan.md", "# secret plan: attack at dawn");
    await a.remote.initialize();
    await a.engine.syncOnce();

    await b.remote.initialize();
    const down = await b.engine.syncOnce();
    expect(down.pulled).toBe(1);
    expect(b.vault.read("secret/plan.md")).toBe("# secret plan: attack at dawn");

    // Inspect raw bucket contents: no path or plaintext leakage.
    const raw = new S3Client(new FetchHttpClient(), { ...conn, prefix });
    for (const obj of await raw.listObjects("")) {
      expect(obj.key).not.toContain("plan.md");
      const body = await raw.getObject(obj.key.slice(prefix.length + 1));
      if (body && !obj.key.endsWith("vault.json")) {
        expect(new TextDecoder().decode(body.body)).not.toContain("attack at dawn");
      }
    }
  }, 120_000);
});
