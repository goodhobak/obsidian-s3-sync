import { beforeEach, describe, expect, it } from "vitest";
import { MassDeleteAbortError, ManifestRollbackError, SyncEngine } from "../src/sync/engine";
import { RemoteStore } from "../src/sync/remote-store";
import { sha256Hex } from "../src/s3/sigv4";
import { DEFAULT_SETTINGS, type SyncFilterSettings } from "../src/types";
import { InMemoryIndexStore, InMemoryS3, InMemoryVault } from "./fakes";

interface Device {
  vault: InMemoryVault;
  engine: SyncEngine;
  remote: RemoteStore;
}

const filters: SyncFilterSettings = { ...DEFAULT_SETTINGS.filters, excludedFolders: [] };

function makeDevice(
  s3: InMemoryS3,
  opts: {
    encryption?: { enabled: boolean; passphrase: string };
    confirmMassDelete?: boolean;
    filterOverride?: SyncFilterSettings;
    versionsToKeep?: number;
    clock?: () => number;
  } = {},
): Device {
  const vault = new InMemoryVault();
  const remote = new RemoteStore(s3, {
    encryptionEnabled: opts.encryption?.enabled ?? false,
    encryptionPassphrase: opts.encryption?.passphrase ?? "",
  });
  const engine = new SyncEngine(
    vault,
    remote,
    new InMemoryIndexStore(),
    opts.filterOverride ?? filters,
    { versionsToKeep: opts.versionsToKeep ?? 5, massDeleteThreshold: 0.5 },
    { confirmMassDelete: async () => opts.confirmMassDelete ?? true },
    opts.clock,
  );
  return { vault, engine, remote };
}

async function sync(device: Device) {
  await device.remote.initialize();
  return device.engine.syncOnce();
}

describe("SyncEngine", () => {
  let s3: InMemoryS3;
  let a: Device;
  let b: Device;

  beforeEach(() => {
    s3 = new InMemoryS3();
    a = makeDevice(s3);
    b = makeDevice(s3);
  });

  it("pushes new files and pulls them on another device", async () => {
    a.vault.write("notes/hello.md", "# Hello");
    a.vault.write("assets/pic.png", "PNGDATA");
    const up = await sync(a);
    expect(up.pushed).toBe(2);

    const down = await sync(b);
    expect(down.pulled).toBe(2);
    expect(b.vault.read("notes/hello.md")).toBe("# Hello");
    expect(b.vault.read("assets/pic.png")).toBe("PNGDATA");
  });

  it("propagates edits", async () => {
    a.vault.write("n.md", "v1");
    await sync(a);
    await sync(b);

    b.vault.write("n.md", "v2");
    await sync(b);
    const res = await sync(a);
    expect(res.pulled).toBe(1);
    expect(a.vault.read("n.md")).toBe("v2");
  });

  it("propagates deletions via tombstones", async () => {
    a.vault.write("gone.md", "bye");
    await sync(a);
    await sync(b);

    a.vault.remove("gone.md");
    const res = await sync(a);
    expect(res.deletedRemote).toBe(1);

    const bRes = await sync(b);
    expect(bRes.deletedLocal).toBe(1);
    expect(b.vault.read("gone.md")).toBeNull();
  });

  it("does not treat filter exclusions as deletions", async () => {
    a.vault.write("keep/secret.md", "s");
    await sync(a);

    const excluding = makeDevice(s3, {
      filterOverride: { ...filters, excludedFolders: ["keep"] },
    });
    // Reuse a's vault so index says the file was synced, then filters hide it.
    const filtered = new SyncEngine(
      a.vault,
      excluding.remote,
      new InMemoryIndexStore(),
      { ...filters, excludedFolders: ["keep"] },
      { versionsToKeep: 5, massDeleteThreshold: 0.5 },
      { confirmMassDelete: async () => true },
    );
    await excluding.remote.initialize();
    await filtered.syncOnce();

    const check = await sync(b);
    expect(check.pulled).toBe(1); // remote copy still exists
  });

  it("does not treat per-file exclusions as deletions (device-local skip)", async () => {
    a.vault.write("media/big.mp4", "HUGE");
    a.vault.write("notes/n.md", "n");
    await sync(a);

    // Same vault, new device state that excludes the file: it must be forgotten
    // locally, never tombstoned remotely.
    const excluding = makeDevice(s3);
    const filtered = new SyncEngine(
      a.vault,
      excluding.remote,
      new InMemoryIndexStore(),
      { ...filters, excludedFiles: ["media/big.mp4"] },
      { versionsToKeep: 5, massDeleteThreshold: 0.5 },
      { confirmMassDelete: async () => true },
    );
    await excluding.remote.initialize();
    const res = await filtered.syncOnce();
    expect(res.deletedRemote).toBe(0);

    // Another device still pulls both files — the remote copy survived.
    const check = await sync(b);
    expect(check.pulled).toBe(2);
    expect(b.vault.read("media/big.mp4")).toBe("HUGE");
  });

  it("an excluded remote file is not downloaded on this device", async () => {
    a.vault.write("media/big.mp4", "HUGE");
    a.vault.write("notes/n.md", "n");
    await sync(a);

    const c = makeDevice(s3, { filterOverride: { ...filters, excludedFiles: ["media/big.mp4"] } });
    const res = await sync(c);
    expect(res.pulled).toBe(1);
    expect(c.vault.read("media/big.mp4")).toBeNull();
    expect(c.vault.read("notes/n.md")).toBe("n");
  });

  it("creates a conflict copy for divergent binary-ish edits", async () => {
    a.vault.write("c.md", "base\n");
    await sync(a);
    await sync(b);

    // Divergent same-line edits (unmergeable) with history disabled → conflict copy.
    const a2 = makeDevice(s3, { versionsToKeep: 0 });
    a2.vault.write("c.md", "base\n"); // simulate same base
    await sync(a2);

    a.vault.write("c.md", "left\n");
    b.vault.write("c.md", "right\n");
    await sync(a);
    const res = await sync(b);
    expect(res.conflicts).toBe(1);

    // Remote version lands on the canonical path; local words survive in a copy.
    expect(b.vault.read("c.md")).toBe("left\n");
    const conflictFile = [...b.vault.files.keys()].find((p) => p.includes("(conflict"));
    expect(conflictFile).toBeDefined();
    expect(b.vault.read(conflictFile!)).toBe("right\n");

    // The conflict copy syncs back to the other device.
    const back = await sync(a);
    expect(back.pulled).toBe(1);
  });

  it("three-way merges non-overlapping markdown edits", async () => {
    const base = ["# T", "", "alpha", "beta", "gamma", "", "end"].join("\n");
    a.vault.write("m.md", base);
    await sync(a);
    await sync(b);

    a.vault.write("m.md", base.replace("alpha", "alpha-local-A"));
    await sync(a); // pushes v2, captures base into history

    b.vault.write("m.md", base.replace("end", "end-local-B"));
    const res = await sync(b);
    expect(res.merged).toBe(1);
    expect(b.vault.read("m.md")).toContain("alpha-local-A");
    expect(b.vault.read("m.md")).toContain("end-local-B");

    const final = await sync(a);
    expect(final.pulled).toBe(1);
    expect(a.vault.read("m.md")).toBe(b.vault.read("m.md"));
  });

  it("edit wins over delete", async () => {
    a.vault.write("e.md", "v1");
    await sync(a);
    await sync(b);

    a.vault.remove("e.md");
    await sync(a); // tombstone

    b.vault.write("e.md", "v2 edited");
    await sync(b); // resurrect

    const res = await sync(a);
    expect(res.pulled).toBe(1);
    expect(a.vault.read("e.md")).toBe("v2 edited");
  });

  it("aborts on unconfirmed mass deletion", async () => {
    for (let i = 0; i < 10; i++) a.vault.write(`f${i}.md`, `${i}`);
    await sync(a);

    for (let i = 0; i < 10; i++) a.vault.remove(`f${i}.md`);
    const guarded = makeDevice(s3, { confirmMassDelete: false });
    const engine = new SyncEngine(
      a.vault,
      guarded.remote,
      // reuse a's index so deletions are detected
      (a as unknown as { engine: { indexStore: unknown } }).engine["indexStore"] as never,
      filters,
      { versionsToKeep: 5, massDeleteThreshold: 0.5 },
      { confirmMassDelete: async () => false },
    );
    await guarded.remote.initialize();
    await expect(engine.syncOnce()).rejects.toBeInstanceOf(MassDeleteAbortError);

    // Nothing was tombstoned remotely.
    const check = await sync(b);
    expect(check.pulled).toBe(10);
  });

  it("keeps version history and restores old versions", async () => {
    a.vault.write("h.md", "version 1");
    await sync(a);
    a.vault.write("h.md", "version 2");
    await sync(a);

    const { manifest } = await a.remote.loadManifest();
    const entry = manifest.files["h.md"];
    expect(entry?.history).toHaveLength(1);

    const ok = await a.engine.restoreVersion("h.md", entry!.history![0]!.hash);
    expect(ok).toBe(true);
    expect(a.vault.read("h.md")).toBe("version 1");
  });

  it("restores an old version in ENCRYPTED mode (content-addressed AAD survives the server-side copy)", async () => {
    const dev = makeDevice(s3, { encryption: { enabled: true, passphrase: "pw123" } });
    await dev.remote.initialize();
    dev.vault.write("h.md", "encrypted version 1");
    await dev.engine.syncOnce();
    dev.vault.write("h.md", "encrypted version 2");
    await dev.engine.syncOnce();

    const { manifest } = await dev.remote.loadManifest();
    const oldHash = manifest.files["h.md"]?.history?.[0]?.hash;
    expect(oldHash).toBeTruthy();

    // History blob is a server-side copy of the old live blob; decrypt must
    // still succeed because the AAD is bound to the content hash, not the key.
    const ok = await dev.engine.restoreVersion("h.md", oldHash!);
    expect(ok).toBe(true);
    expect(dev.vault.read("h.md")).toBe("encrypted version 1");
  }, 60_000);

  it("syncs end-to-end encrypted vaults with opaque keys", async () => {
    const ea = makeDevice(s3, { encryption: { enabled: true, passphrase: "pw123" } });
    const eb = makeDevice(s3, { encryption: { enabled: true, passphrase: "pw123" } });

    ea.vault.write("secret/note.md", "# top secret");
    await sync(ea);
    const down = await sync(eb);
    expect(down.pulled).toBe(1);
    expect(eb.vault.read("secret/note.md")).toBe("# top secret");

    // No object key or byte on the wire reveals the path or content.
    for (const [key, obj] of s3.objects) {
      expect(key).not.toContain("note.md");
      if (key.startsWith("blobs/") || key.endsWith(".enc")) {
        expect(new TextDecoder().decode(obj.body)).not.toContain("top secret");
      }
    }
  }, 60_000);

  it("rejects mismatched encryption settings", async () => {
    const plain = makeDevice(s3);
    plain.vault.write("x.md", "x");
    await sync(plain);

    const enc = makeDevice(s3, { encryption: { enabled: true, passphrase: "pw" } });
    await expect(sync(enc)).rejects.toThrow(/not encrypted/);
  }, 60_000);

  it("recovers when another device wins the manifest race", async () => {
    a.vault.write("r.md", "a-version");
    b.vault.write("s.md", "b-version");
    await sync(a);
    // b starts from a stale (empty) etag view internally but retries and lands both files.
    const res = await sync(b);
    expect(res.pushed).toBe(1);
    expect(res.pulled).toBe(1);

    const final = await sync(a);
    expect(final.pulled).toBe(1);
    expect(a.vault.read("s.md")).toBe("b-version");
  });

  it("reports inbound (pull) and outbound (push) direction counts", async () => {
    // Seed remote with two files another device can pull.
    a.vault.write("remote1.md", "r1");
    a.vault.write("remote2.md", "r2");
    await sync(a);

    // b has one local file to push and two to pull => outbound 1, inbound 2.
    b.vault.write("local1.md", "l1");
    const io: Array<{ inbound: number; outbound: number }> = [];
    const engine = new SyncEngine(
      b.vault,
      b.remote,
      new InMemoryIndexStore(),
      filters,
      { versionsToKeep: 5, massDeleteThreshold: 0.5 },
      { confirmMassDelete: async () => true, onProgress: (p) => io.push({ inbound: p.inbound, outbound: p.outbound }) },
    );
    await b.remote.initialize();
    const res = await engine.syncOnce();

    expect(res.pulled).toBe(2);
    expect(res.pushed).toBe(1);
    const last = io[io.length - 1]!;
    expect(last.inbound).toBe(2);
    expect(last.outbound).toBe(1);
  });

  it("reports progress with completed/total reaching parity at the end", async () => {
    const s3b = new InMemoryS3();
    const dev = makeDevice(s3b);
    const seen: Array<{ completed: number; total: number }> = [];
    const engine = new SyncEngine(
      dev.vault,
      dev.remote,
      new InMemoryIndexStore(),
      filters,
      { versionsToKeep: 5, massDeleteThreshold: 0.5 },
      {
        confirmMassDelete: async () => true,
        onProgress: (p) => seen.push({ completed: p.completed, total: p.total }),
      },
    );
    dev.vault.write("a.md", "1");
    dev.vault.write("b.md", "2");
    dev.vault.write("c/d.md", "3");
    await dev.remote.initialize();
    await engine.syncOnce();

    const withPlan = seen.filter((p) => p.total > 0);
    expect(withPlan.length).toBeGreaterThan(0);
    // Never report more completed than planned.
    for (const p of withPlan) expect(p.completed).toBeLessThanOrEqual(p.total);
    // By the end, all planned operations are counted complete.
    const last = withPlan[withPlan.length - 1]!;
    expect(last.completed).toBe(last.total);
    expect(last.total).toBe(3);
  });

  // --- regression tests for review findings --------------------------------

  it("skips a file whose remote blob is corrupted, without writing garbage (sec-M1)", async () => {
    a.vault.write("safe.md", "trustworthy");
    await sync(a);
    const { manifest } = await a.remote.loadManifest();
    s3.corrupt(manifest.files["safe.md"]!.blobKey);

    const res = await sync(b);
    expect(res.pulled).toBe(0);
    expect(res.errors.some((e) => e.includes("Integrity check failed"))).toBe(true);
    expect(b.vault.read("safe.md")).toBeNull(); // no corrupt bytes written
    // Structured failure record is surfaced for the Resolve UI.
    expect(res.failedFiles).toEqual([
      expect.objectContaining({ path: "safe.md", kind: "integrity" }),
    ]);
  });

  it("records a conflict copy in the summary for the Resolve UI", async () => {
    a.vault.write("c.md", "base\n");
    await sync(a);
    await sync(b);

    // Divergent same-line edits with history disabled => conflict copy (not merge).
    const a2 = makeDevice(s3, { versionsToKeep: 0 });
    a2.vault.write("c.md", "base\n");
    await sync(a2);
    a.vault.write("c.md", "left\n");
    b.vault.write("c.md", "right\n");
    await sync(a);
    const res = await sync(b);

    expect(res.conflicts).toBe(1);
    expect(res.conflictCopies).toHaveLength(1);
    expect(res.conflictCopies[0]!.path).toBe("c.md");
    expect(res.conflictCopies[0]!.conflictCopy).toContain("(conflict");
    // The recorded copy path actually exists in the vault.
    expect(b.vault.read(res.conflictCopies[0]!.conflictCopy)).toBe("right\n");
  });

  it("refuses to sync when the remote manifest revision rolls back (sec-M3)", async () => {
    a.vault.write("x.md", "v1");
    await sync(a);
    await sync(b); // b now records manifestRevision from a's push

    // Simulate a malicious/backup rollback: replace the manifest with an older revision.
    const older = { schemaVersion: 1 as const, revision: 0, updatedAt: 0, files: {} };
    const cur = await b.remote.loadManifest();
    await b.remote.saveManifest(older, cur.etag);

    await expect(sync(b)).rejects.toBeInstanceOf(ManifestRollbackError);
  });

  it("cleans up uploaded blobs when a push attempt fails (quality-M1)", async () => {
    const enc = makeDevice(s3, { encryption: { enabled: true, passphrase: "pw" } });
    await enc.remote.initialize();
    enc.vault.write("a.md", "aaa");
    enc.vault.write("b.md", "bbb");
    const before = s3.keys().filter((k) => k.startsWith("blobs/")).length;

    // Make saveManifest throw a non-conflict error after blobs are uploaded.
    const orig = enc.remote.saveManifest.bind(enc.remote);
    let called = false;
    enc.remote.saveManifest = async () => {
      called = true;
      throw new Error("simulated network failure during manifest save");
    };
    await expect(enc.engine.syncOnce()).rejects.toThrow("simulated network failure");
    expect(called).toBe(true);
    enc.remote.saveManifest = orig;

    // No orphaned blobs left behind from the failed attempt.
    const after = s3.keys().filter((k) => k.startsWith("blobs/")).length;
    expect(after).toBe(before);
  }, 60_000);

  it("retains deleted files indefinitely (recoverable, no time-based purge)", async () => {
    let clock = 1_000;
    const dev = makeDevice(s3, { clock: () => clock });
    await dev.remote.initialize();
    dev.vault.write("temp.md", "content");
    await dev.engine.syncOnce();
    dev.vault.remove("temp.md");
    await dev.engine.syncOnce(); // tombstone + retained backup

    const { manifest: m1 } = await dev.remote.loadManifest();
    expect(m1.files["temp.md"]?.deletedAt).toBeGreaterThan(0);
    expect(m1.files["temp.md"]?.history?.[0]?.hash).toBeTruthy();

    // Advance well past any old TTL — the deleted file must still be there.
    clock += 400 * 24 * 60 * 60 * 1000;
    dev.vault.write("other.md", "trigger a manifest write");
    await dev.engine.syncOnce();

    const { manifest: m2 } = await dev.remote.loadManifest();
    expect(m2.files["temp.md"]?.deletedAt).toBeGreaterThan(0); // still recoverable
    // Its backup blob is still stored.
    const hash = m2.files["temp.md"]!.history![0]!.hash;
    expect(s3.keys()).toContain(`blobs/${hash}`);
  });

  it("keeps 5 backups by default for a deleted file and can restore it", async () => {
    const dev = makeDevice(s3); // versionsToKeep defaults to 5
    await dev.remote.initialize();
    for (let i = 1; i <= 7; i++) {
      dev.vault.write("d.md", `version ${i}`);
      await dev.engine.syncOnce();
    }
    dev.vault.remove("d.md");
    await dev.engine.syncOnce();

    const deleted = await dev.engine.listDeleted();
    expect(deleted.map((f) => f.path)).toContain("d.md");
    const entry = deleted.find((f) => f.path === "d.md")!;
    expect(entry.versions.length).toBe(5); // 5 backups retained (v7..v3)

    // Restore brings the newest backup (v7) back; next sync clears the tombstone.
    expect(await dev.engine.restoreDeleted("d.md")).toBe(true);
    expect(dev.vault.read("d.md")).toBe("version 7");
    await dev.engine.syncOnce();
    const { manifest } = await dev.remote.loadManifest();
    expect(manifest.files["d.md"]?.deletedAt).toBeUndefined(); // resurrected
  });

  it("permanently deletes a file only via purge, freeing its blobs", async () => {
    const dev = makeDevice(s3);
    await dev.remote.initialize();
    dev.vault.write("gone.md", "bye");
    await dev.engine.syncOnce();
    dev.vault.remove("gone.md");
    await dev.engine.syncOnce();

    const { manifest: before } = await dev.remote.loadManifest();
    const hash = before.files["gone.md"]!.history![0]!.hash;
    expect(s3.keys()).toContain(`blobs/${hash}`);

    const purged = await dev.engine.purgeDeleted(["gone.md"]);
    expect(purged).toBe(1);

    const { manifest: after } = await dev.remote.loadManifest();
    expect(after.files["gone.md"]).toBeUndefined();
    expect(s3.keys()).not.toContain(`blobs/${hash}`); // blob removed only on purge
  });

  it("stores identical content once, deduplicated across paths", async () => {
    const dev = makeDevice(s3);
    await dev.remote.initialize();
    dev.vault.write("one.md", "identical body");
    dev.vault.write("two.md", "identical body");
    dev.vault.write("three.md", "identical body");
    await dev.engine.syncOnce();

    // Three paths, one stored blob.
    expect(s3.keys().filter((k) => k.startsWith("blobs/")).length).toBe(1);
    const { manifest } = await dev.remote.loadManifest();
    expect(manifest.files["one.md"]!.blobKey).toBe(manifest.files["two.md"]!.blobKey);
  });

  it("prunes history beyond versionsToKeep but keeps blobs shared across paths (test-reviewer #4)", async () => {
    const dev = makeDevice(s3, { versionsToKeep: 2 });
    await dev.remote.initialize();

    // Two paths share identical content -> identical history hash.
    dev.vault.write("p.md", "shared-v0");
    dev.vault.write("q.md", "shared-v0");
    await dev.engine.syncOnce();

    // Edit q so p's "shared-v0" blob becomes q's history (shared hash across paths).
    dev.vault.write("q.md", "q-v1");
    await dev.engine.syncOnce();

    // Push p past the cap so its own older versions prune.
    dev.vault.write("p.md", "shared-v0"); // keep p live on the shared hash
    dev.vault.write("p.md", "p-v1");
    await dev.engine.syncOnce();
    dev.vault.write("p.md", "p-v2");
    await dev.engine.syncOnce();
    dev.vault.write("p.md", "p-v3");
    await dev.engine.syncOnce();

    const { manifest } = await dev.remote.loadManifest();
    expect((manifest.files["p.md"]?.history?.length ?? 0)).toBeLessThanOrEqual(2);
    // q's history still references the shared-v0 hash, so its content-addressed blob must survive.
    const qSharedHash = manifest.files["q.md"]?.history?.[0]?.hash;
    if (qSharedHash) expect(s3.keys()).toContain(`blobs/${qSharedHash}`);
  });

  it("does not delete a file that a same-cycle pull rewrote under a different case (quality-H2)", async () => {
    // Device A creates Note.md; B syncs it.
    a.vault.write("Note.md", "hello");
    await sync(a);
    await sync(b);

    // A renames Note.md -> note.md (case-only). On a case-sensitive store this is
    // a delete of Note.md + add of note.md.
    a.vault.remove("Note.md");
    a.vault.write("note.md", "hello");
    await sync(a);

    // B applies: it should end with note.md present (not deleted by the Note.md tombstone).
    await sync(b);
    const survivors = [...b.vault.files.keys()].filter((k) => k.toLowerCase() === "note.md");
    expect(survivors.length).toBeGreaterThanOrEqual(1);
    expect(b.vault.read(survivors[0]!)).toBe("hello");
  });

  it("isolates a single un-writable file — one bad name does not abort the sync (Windows)", async () => {
    for (let i = 0; i < 4; i++) a.vault.write(`ok${i}.md`, `body ${i}`);
    a.vault.write("bad:name?.md", "unwritable on windows");
    await sync(a);

    // Device b: simulate the OS rejecting the illegal filename on write.
    const vault = b.vault;
    const orig = vault.writeBinary.bind(vault);
    vault.writeBinary = async (path, data, mtime) => {
      if (path === "bad:name?.md") throw new Error('File name cannot contain: * " \\ / < > : | ?');
      return orig(path, data, mtime);
    };

    const res = await sync(b); // must NOT throw
    expect(res.pulled).toBe(4); // the 4 good files still synced
    expect(res.failedFiles.map((f) => f.path)).toContain("bad:name?.md");
    for (let i = 0; i < 4; i++) expect(b.vault.read(`ok${i}.md`)).toBe(`body ${i}`);
  });

  it("isolates a single failed upload — a dropped connection does not abort push", async () => {
    const dev = makeDevice(s3);
    await dev.remote.initialize();
    dev.vault.write("a.md", "aaa");
    dev.vault.write("bad.md", "bbb");
    dev.vault.write("c.md", "ccc");

    const orig = dev.remote.uploadBlob.bind(dev.remote);
    dev.remote.uploadBlob = async (hash, content) => {
      if (new TextDecoder().decode(content) === "bbb") throw new Error("Request Failed. IOException Stream closed");
      return orig(hash, content);
    };

    const res = await dev.engine.syncOnce(); // must NOT throw
    expect(res.pushed).toBe(2);
    expect(res.failedFiles.map((f) => f.path)).toContain("bad.md");

    const { manifest } = await dev.remote.loadManifest();
    expect(manifest.files["a.md"]).toBeTruthy();
    expect(manifest.files["c.md"]).toBeTruthy();
    expect(manifest.files["bad.md"]).toBeUndefined(); // not committed since upload failed
  });

  it("stops the push phase after many consecutive upload failures (circuit breaker)", async () => {
    const dev = makeDevice(s3);
    await dev.remote.initialize();
    for (let i = 0; i < 50; i++) dev.vault.write(`f${i}.md`, `body ${i}`);

    let attempts = 0;
    dev.remote.uploadBlob = async () => {
      attempts++;
      throw new Error('Request Failed. UnknownHostException Unable to resolve host "example"');
    };

    const res = await dev.engine.syncOnce(); // must NOT throw
    expect(res.pushed).toBe(0);
    expect(attempts).toBeLessThanOrEqual(8); // stopped early, not all 50
    expect(res.errors.some((e) => e.includes("Network appears unavailable"))).toBe(true);
  });

  it("retries a transient manifest-save failure", async () => {
    const dev = makeDevice(s3);
    await dev.remote.initialize();
    dev.vault.write("x.md", "x");

    const orig = dev.remote.saveManifest.bind(dev.remote);
    let calls = 0;
    dev.remote.saveManifest = async (m, etag) => {
      if (++calls === 1) throw new Error("Request Failed. IOException Stream closed");
      return orig(m, etag);
    };

    const res = await dev.engine.syncOnce(); // retries and succeeds
    expect(res.pushed).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    const { manifest } = await dev.remote.loadManifest();
    expect(manifest.files["x.md"]).toBeTruthy();
  });

  it("checkpoints the index during a large inbound sync (resumable on kill)", async () => {
    for (let i = 0; i < 60; i++) a.vault.write(`f${i}.md`, `content ${i}`);
    await sync(a);

    const store = new InMemoryIndexStore();
    let saves = 0;
    const origSave = store.save.bind(store);
    store.save = async (v) => {
      saves++;
      return origSave(v);
    };
    const engine = new SyncEngine(b.vault, b.remote, store, filters, { versionsToKeep: 5, massDeleteThreshold: 0.5 }, {
      confirmMassDelete: async () => true,
    });
    await b.remote.initialize();
    await engine.syncOnce();

    // 60 pulls with CHECKPOINT_EVERY=25 => at least 2 mid-run checkpoints + final save.
    expect(saves).toBeGreaterThanOrEqual(3);
  });

  it("skips pulling remote files over the max file size (mobile OOM guard)", async () => {
    a.vault.write("small.md", "tiny");
    a.vault.write("big.md", "x".repeat(500));
    await sync(a);

    // Device b caps files at 100 bytes.
    const engine = new SyncEngine(
      b.vault,
      b.remote,
      new InMemoryIndexStore(),
      { ...filters, maxFileSize: 100 },
      { versionsToKeep: 5, massDeleteThreshold: 0.5 },
      { confirmMassDelete: async () => true },
    );
    await b.remote.initialize();
    const res = await engine.syncOnce();

    expect(b.vault.read("small.md")).toBe("tiny"); // small file synced
    expect(b.vault.read("big.md")).toBeNull(); // large file skipped, not downloaded
    expect(res.failedFiles.map((f) => f.path)).toContain("big.md");
    expect(res.failedFiles.find((f) => f.path === "big.md")!.reason).toMatch(/exceeds the max file size/);
  });

  it("downloads smallest files first (progress before large files)", async () => {
    a.vault.write("huge.md", "x".repeat(1000));
    a.vault.write("tiny.md", "a");
    a.vault.write("mid.md", "x".repeat(100));
    await sync(a);

    const order: string[] = [];
    const engine = new SyncEngine(b.vault, b.remote, new InMemoryIndexStore(), filters, { versionsToKeep: 5, massDeleteThreshold: 0.5 }, {
      confirmMassDelete: async () => true,
      onProgress: (p) => {
        const m = p.message.match(/^Downloading (.+)$/);
        if (m) order.push(m[1]!);
      },
    });
    await b.remote.initialize();
    await engine.syncOnce();

    expect(order).toEqual(["tiny.md", "mid.md", "huge.md"]);
  });

  it("migrates a legacy layout to content-addressed and GCs orphans", async () => {
    const dev = makeDevice(s3);
    await dev.remote.initialize();

    // Seed a pre-dedup layout by hand: a live blob at files/note.md, a legacy
    // history/<hash> object, an orphan blob, and a manifest pointing at them.
    const liveContent = new TextEncoder().encode("live body").buffer as ArrayBuffer;
    const liveHash = await sha256Hex(liveContent);
    const oldContent = new TextEncoder().encode("older body").buffer as ArrayBuffer;
    const oldHash = await sha256Hex(oldContent);
    await s3.putObject("files/note.md", liveContent);
    await s3.putObject(`history/${oldHash}`, oldContent);
    await s3.putObject("blobs/orphan-xyz", new TextEncoder().encode("garbage").buffer as ArrayBuffer);
    await dev.remote.saveManifest(
      {
        schemaVersion: 1,
        revision: 1,
        updatedAt: 1,
        files: {
          "note.md": {
            hash: liveHash,
            size: 9,
            mtime: 1,
            rev: 1,
            blobKey: "files/note.md",
            history: [{ hash: oldHash, size: 10, ts: 1 }],
          },
        },
      },
      null,
    );

    // Dry run reports but changes nothing.
    const dry = await dev.engine.migrateStorage({ dryRun: true });
    expect(dry.repointed).toBe(1);
    expect(dry.deletedLegacy).toBe(2);
    expect(dry.deletedOrphan).toBe(1);
    expect(s3.keys()).toContain("files/note.md"); // untouched

    const report = await dev.engine.migrateStorage();
    expect(report.rehomed).toBe(2); // live + history re-homed
    expect(report.missing).toEqual([]);

    // Content-addressed blobs now exist; legacy + orphan gone.
    expect(s3.keys()).toContain(`blobs/${liveHash}`);
    expect(s3.keys()).toContain(`blobs/${oldHash}`);
    expect(s3.keys().some((k) => k.startsWith("files/"))).toBe(false);
    expect(s3.keys().some((k) => k.startsWith("history/"))).toBe(false);
    expect(s3.keys()).not.toContain("blobs/orphan-xyz");

    // Manifest repointed; both live and history content still retrievable.
    const { manifest } = await dev.remote.loadManifest();
    expect(manifest.files["note.md"]!.blobKey).toBe(`blobs/${liveHash}`);
    expect(await dev.engine.restoreVersion("note.md", oldHash)).toBe(true);
    expect(dev.vault.read("note.md")).toBe("older body");

    // Idempotent: a second migration finds nothing to do.
    const again = await dev.engine.migrateStorage();
    expect(again.rehomed).toBe(0);
    expect(again.deletedLegacy).toBe(0);
    expect(again.deletedOrphan).toBe(0);
  });

  it("resumes a killed inbound sync from a checkpoint (no restart from zero)", async () => {
    for (let i = 0; i < 60; i++) a.vault.write(`g${i}.md`, `v${i}`);
    await sync(a);

    // First attempt on b is "killed" mid-run (simulate an OS termination via an
    // uncaught throw once ~40 files have downloaded — past the 25-file checkpoint).
    const store = new InMemoryIndexStore();
    let downloads = 0;
    const engine1 = new SyncEngine(b.vault, b.remote, store, filters, { versionsToKeep: 5, massDeleteThreshold: 0.5 }, {
      confirmMassDelete: async () => true,
      onProgress: (p) => {
        if (p.message.startsWith("Downloading") && ++downloads >= 40) throw new Error("process killed");
      },
    });
    await b.remote.initialize();
    await expect(engine1.syncOnce()).rejects.toThrow("process killed");

    // The 25-file checkpoint persisted; not everything was lost.
    const checkpointed = Object.keys((await store.load())!.files).length;
    expect(checkpointed).toBeGreaterThanOrEqual(25);

    // Restart with the SAME index: a fresh sync completes the rest without
    // re-pulling the already-synced files from zero.
    const engine2 = new SyncEngine(b.vault, b.remote, store, filters, { versionsToKeep: 5, massDeleteThreshold: 0.5 }, {
      confirmMassDelete: async () => true,
    });
    const res = await engine2.syncOnce();

    for (let i = 0; i < 60; i++) expect(b.vault.read(`g${i}.md`)).toBe(`v${i}`);
    expect(res.errors).toEqual([]);
    expect(res.pulled).toBeLessThan(60); // resumed, did not re-download all 60
  });

  // --- security regression tests -------------------------------------------

  it("refuses to restore a version to a traversal or config path (sec-1.1)", async () => {
    const dev = makeDevice(s3);
    await dev.remote.initialize();
    // Hostile tombstone/manifest keys must never reach writeBinary via restore.
    expect(await dev.engine.restoreVersion("../evil.md", "deadbeef")).toBe(false);
    expect(await dev.engine.restoreVersion(".obsidian/plugins/x/main.js", "deadbeef")).toBe(false);
    expect(await dev.engine.restoreVersion("a\\b.md", "deadbeef")).toBe(false);
    expect(dev.vault.files.size).toBe(0); // nothing written
  });

  it("syncs .obsidian config only when the vault is encrypted (sec-2.1 gate)", async () => {
    const cfgFilters = { ...filters, syncObsidianConfig: true };

    // Plaintext: the config file is NOT pushed even with config sync enabled.
    const plain = makeDevice(new InMemoryS3(), { filterOverride: cfgFilters });
    plain.vault.write(".obsidian/appearance.json", "{}");
    plain.vault.write("note.md", "hi");
    await plain.remote.initialize();
    const r1 = await plain.engine.syncOnce();
    expect(r1.pushed).toBe(1);
    expect((await plain.remote.loadManifest()).manifest.files[".obsidian/appearance.json"]).toBeUndefined();

    // Encrypted: the config file IS pushed (authenticated manifest).
    const enc = makeDevice(new InMemoryS3(), {
      filterOverride: cfgFilters,
      encryption: { enabled: true, passphrase: "pw" },
    });
    enc.vault.write(".obsidian/appearance.json", "{}");
    enc.vault.write("note.md", "hi");
    await enc.remote.initialize();
    const r2 = await enc.engine.syncOnce();
    expect(r2.pushed).toBe(2);
    expect((await enc.remote.loadManifest()).manifest.files[".obsidian/appearance.json"]).toBeTruthy();
  }, 60_000);

  it("skips a conflict whose remote version exceeds the max file size (sec-5.1)", async () => {
    const big = "x".repeat(500);
    a.vault.write("c.md", "base\n");
    await sync(a);
    await sync(b);

    // Diverge both sides; device b caps files at 100 bytes and the remote is large.
    a.vault.write("c.md", big);
    await sync(a);
    b.vault.write("c.md", "mine\n");

    const engine = new SyncEngine(
      b.vault,
      b.remote,
      new InMemoryIndexStore(),
      { ...filters, maxFileSize: 100 },
      { versionsToKeep: 5, massDeleteThreshold: 0.5 },
      { confirmMassDelete: async () => true },
    );
    await b.remote.initialize();
    const res = await engine.syncOnce();
    expect(res.failedFiles.map((f) => f.path)).toContain("c.md");
    expect(res.failedFiles.find((f) => f.path === "c.md")!.reason).toMatch(/exceeds the max file size/);
    expect(b.vault.read("c.md")).toBe("mine\n"); // local untouched, no huge download
  });
});
