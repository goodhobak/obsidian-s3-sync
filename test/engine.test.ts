import { beforeEach, describe, expect, it } from "vitest";
import { MassDeleteAbortError, ManifestRollbackError, SyncEngine } from "../src/sync/engine";
import { RemoteStore } from "../src/sync/remote-store";
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
    const blobKey = "files/safe.md";
    s3.corrupt(blobKey);

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

  it("purges tombstones and their history blobs after the TTL (test-reviewer #3)", async () => {
    let clock = 1_000;
    const dev = makeDevice(s3, { clock: () => clock });
    await dev.remote.initialize();
    dev.vault.write("temp.md", "content");
    await dev.engine.syncOnce();
    dev.vault.remove("temp.md");
    await dev.engine.syncOnce(); // creates tombstone + history blob

    const { manifest: m1 } = await dev.remote.loadManifest();
    expect(m1.files["temp.md"]?.deletedAt).toBeGreaterThan(0);

    // Advance past the 30-day TTL and sync again.
    clock += 31 * 24 * 60 * 60 * 1000;
    dev.vault.write("other.md", "trigger a manifest write");
    await dev.engine.syncOnce();

    const { manifest: m2 } = await dev.remote.loadManifest();
    expect(m2.files["temp.md"]).toBeUndefined();
    expect(s3.keys().some((k) => k.startsWith("history/"))).toBe(false);
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
    // q's history still references the shared-v0 hash, so its blob must survive.
    const qSharedHash = manifest.files["q.md"]?.history?.[0]?.hash;
    if (qSharedHash) expect(s3.keys()).toContain(`history/${qSharedHash}`);
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
});
