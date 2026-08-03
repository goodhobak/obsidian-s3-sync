import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/s3/sigv4";
import {
  BlobIntegrityError,
  EncryptionMismatchError,
  ManifestConflictError,
  RemoteStore,
} from "../src/sync/remote-store";
import { InMemoryS3 } from "./fakes";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

function plainStore(s3: InMemoryS3) {
  return new RemoteStore(s3, { encryptionEnabled: false, encryptionPassphrase: "" });
}
function encStore(s3: InMemoryS3, passphrase = "pw") {
  return new RemoteStore(s3, { encryptionEnabled: true, encryptionPassphrase: passphrase });
}

describe("RemoteStore blob integrity", () => {
  it("round-trips a blob and verifies its hash (plaintext)", async () => {
    const s3 = new InMemoryS3();
    const store = plainStore(s3);
    await store.initialize();
    const data = enc("hello");
    const hash = await sha256Hex(data);
    const { blobKey, uploaded } = await store.uploadBlob(hash, data);
    expect(uploaded).toBe(true);
    expect(dec((await store.downloadBlob(blobKey, hash))!)).toBe("hello");
  });

  it("deduplicates identical content (second upload is skipped)", async () => {
    const s3 = new InMemoryS3();
    const store = plainStore(s3);
    await store.initialize();
    const data = enc("dup");
    const hash = await sha256Hex(data);
    const first = await store.uploadBlob(hash, data);
    const second = await store.uploadBlob(hash, data);
    expect(first.uploaded).toBe(true);
    expect(second.uploaded).toBe(false); // deduped
    expect(second.blobKey).toBe(first.blobKey);
    // Exactly one blob object stored.
    expect(s3.keys().filter((k) => k.startsWith("blobs/")).length).toBe(1);
  });

  it("rejects a tampered blob (plaintext) via sha256 mismatch", async () => {
    const s3 = new InMemoryS3();
    const store = plainStore(s3);
    await store.initialize();
    const data = enc("hello");
    const hash = await sha256Hex(data);
    const { blobKey } = await store.uploadBlob(hash, data);
    s3.corrupt(blobKey);
    await expect(store.downloadBlob(blobKey, hash)).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it("defeats a blob-swap in encrypted mode (AAD + hash bind content)", async () => {
    const s3 = new InMemoryS3();
    const store = encStore(s3);
    await store.initialize();
    const aData = enc("content of A");
    const bData = enc("content of B");
    const aHash = await sha256Hex(aData);
    const bHash = await sha256Hex(bData);
    const a = await store.uploadBlob(aHash, aData);
    const b = await store.uploadBlob(bHash, bData);

    // Attacker serves B's ciphertext where A's key was requested.
    const swapped = s3.objects.get(b.blobKey)!;
    s3.objects.set(a.blobKey, { body: swapped.body.slice(0), etag: swapped.etag });

    // Decryption with A's AAD (blob:aHash) fails authentication, OR the bytes
    // fail the hash check — either way, no silent swap.
    await expect(store.downloadBlob(a.blobKey, aHash)).rejects.toThrow();
  });

  it("uses opaque (non-plaintext-hash) storage keys in encrypted mode", async () => {
    const s3 = new InMemoryS3();
    const store = encStore(s3);
    await store.initialize();
    const data = enc("secret content");
    const hash = await sha256Hex(data);
    const { blobKey } = await store.uploadBlob(hash, data);
    expect(blobKey).not.toContain(hash); // server never sees the plaintext hash
  });

  it("returns null for a missing blob", async () => {
    const s3 = new InMemoryS3();
    const store = plainStore(s3);
    await store.initialize();
    expect(await store.downloadBlob("files/missing.md", "deadbeef")).toBeNull();
  });
});

describe("RemoteStore manifest locking", () => {
  it("If-None-Match creates, If-Match guards updates, stale etag conflicts", async () => {
    const s3 = new InMemoryS3();
    const store = plainStore(s3);
    await store.initialize();

    const m1 = { schemaVersion: 1 as const, revision: 1, updatedAt: 1, files: {} };
    const etag1 = await store.saveManifest(m1, null); // create
    expect(etag1).toBeTruthy();

    const m2 = { ...m1, revision: 2 };
    const etag2 = await store.saveManifest(m2, etag1); // update with current etag
    expect(etag2).not.toBe(etag1);

    // Saving with the now-stale etag1 must conflict.
    await expect(store.saveManifest({ ...m1, revision: 3 }, etag1)).rejects.toBeInstanceOf(ManifestConflictError);
  });
});

describe("RemoteStore encryption bootstrap", () => {
  it("rejects plain-local against an encrypted remote", async () => {
    const s3 = new InMemoryS3();
    await encStore(s3).initialize(); // create encrypted vault meta
    await expect(plainStore(s3).initialize()).rejects.toBeInstanceOf(EncryptionMismatchError);
  });

  it("rejects encrypted-local against a plain remote", async () => {
    const s3 = new InMemoryS3();
    await plainStore(s3).initialize();
    await expect(encStore(s3).initialize()).rejects.toBeInstanceOf(EncryptionMismatchError);
  });

  it("opening an encrypted vault with the wrong passphrase fails", async () => {
    const s3 = new InMemoryS3();
    await encStore(s3, "right").initialize();
    await expect(encStore(s3, "wrong").initialize()).rejects.toThrow();
  }, 60_000);
});
