import { describe, expect, it } from "vitest";
import { VaultCipher, WrongPassphraseError, randomBlobId } from "../src/crypto/encryption";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("VaultCipher", () => {
  it("round-trips blobs and json through initialize/open", async () => {
    const { cipher, meta } = await VaultCipher.initialize("correct horse battery staple");
    const plaintext = encoder.encode("# My note\n안녕하세요");

    const envelope = await cipher.encrypt(plaintext, "blob");
    expect(new Uint8Array(envelope).slice(0, 4)).toEqual(new Uint8Array([0x4f, 0x53, 0x33, 0x45]));

    const reopened = await VaultCipher.open("correct horse battery staple", meta);
    expect(decoder.decode(await reopened.decrypt(envelope, "blob"))).toBe("# My note\n안녕하세요");

    const json = { hello: "world", n: 42 };
    expect(await reopened.decryptJson(await cipher.encryptJson(json))).toEqual(json);
  }, 30_000);

  it("rejects a wrong passphrase via the key check", async () => {
    const { meta } = await VaultCipher.initialize("right");
    await expect(VaultCipher.open("wrong", meta)).rejects.toBeInstanceOf(WrongPassphraseError);
  }, 30_000);

  it("fails authentication when the envelope is tampered with", async () => {
    const { cipher } = await VaultCipher.initialize("pw");
    const envelope = new Uint8Array(await cipher.encrypt(encoder.encode("data"), "blob"));
    envelope[envelope.length - 1]! ^= 0xff;
    await expect(cipher.decrypt(envelope.buffer as ArrayBuffer, "blob")).rejects.toThrow();
  }, 30_000);

  it("separates blob and meta keys", async () => {
    const { cipher } = await VaultCipher.initialize("pw");
    const envelope = await cipher.encrypt(encoder.encode("data"), "blob");
    await expect(cipher.decrypt(envelope, "meta")).rejects.toThrow();
  }, 30_000);

  it("generates unique opaque blob ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomBlobId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
