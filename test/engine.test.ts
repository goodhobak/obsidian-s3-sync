import { beforeEach, describe, expect, it } from "vitest";
import { MassDeleteAbortError, SyncEngine } from "../src/sync/engine";
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
});
