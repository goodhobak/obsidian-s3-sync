/**
 * Optional end-to-end encryption.
 *
 * Passphrase -> PBKDF2-SHA256 (600k iterations) -> master key
 * master key -> HKDF-SHA256 with purpose-scoped info -> AES-256-GCM keys
 *
 * Blob envelope (binary):
 *   offset size  value
 *   0      4     magic "OS3E"
 *   4      1     format version 0x01
 *   5      12    AES-GCM nonce
 *   17     rest  ciphertext + auth tag
 *
 * Vault meta object (plaintext JSON at meta/vault.json) stores the KDF salt and
 * a key-check value so a wrong passphrase is detected before any sync work.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAGIC = [0x4f, 0x53, 0x33, 0x45]; // "OS3E"
const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 600_000;
const NONCE_LENGTH = 12;

export interface VaultCryptoMeta {
  schemaVersion: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  saltB64: string;
  /** AES-GCM encryption of the fixed string "s3-sync-key-check" under the blob key. */
  keyCheckB64: string;
  createdAt: number;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const KEY_CHECK_PLAINTEXT = "s3-sync-key-check";

async function deriveMasterKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS },
    baseKey,
    256,
  );
  return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
}

async function deriveAesKey(masterKey: CryptoKey, purpose: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(0), info: toArrayBuffer(encoder.encode(`s3-sync/v1/${purpose}`)) },
    masterKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export class VaultCipher {
  private constructor(
    private readonly blobKey: CryptoKey,
    private readonly metaKey: CryptoKey,
  ) {}

  /** Create keys for a brand-new encrypted vault; returns the meta to upload. */
  static async initialize(passphrase: string): Promise<{ cipher: VaultCipher; meta: VaultCryptoMeta }> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const cipher = await VaultCipher.derive(passphrase, salt);
    const keyCheck = await cipher.encrypt(encoder.encode(KEY_CHECK_PLAINTEXT), "blob");
    return {
      cipher,
      meta: {
        schemaVersion: 1,
        kdf: "PBKDF2-SHA256",
        iterations: PBKDF2_ITERATIONS,
        saltB64: toBase64(salt),
        keyCheckB64: toBase64(new Uint8Array(keyCheck)),
        createdAt: Date.now(),
      },
    };
  }

  /** Open an existing encrypted vault; throws WrongPassphraseError on mismatch. */
  static async open(passphrase: string, meta: VaultCryptoMeta): Promise<VaultCipher> {
    const cipher = await VaultCipher.derive(passphrase, fromBase64(meta.saltB64));
    try {
      const check = await cipher.decrypt(toArrayBuffer(fromBase64(meta.keyCheckB64)), "blob");
      if (decoder.decode(check) !== KEY_CHECK_PLAINTEXT) throw new Error("mismatch");
    } catch {
      throw new WrongPassphraseError();
    }
    return cipher;
  }

  private static async derive(passphrase: string, salt: Uint8Array): Promise<VaultCipher> {
    const master = await deriveMasterKey(passphrase, salt);
    return new VaultCipher(await deriveAesKey(master, "blob"), await deriveAesKey(master, "meta"));
  }

  /**
   * @param aad Additional authenticated data. Binds the ciphertext to its
   * context (e.g. the blobKey) so a server cannot swap one valid blob for
   * another: decryption of a swapped blob fails authentication.
   */
  async encrypt(
    plaintext: Uint8Array | ArrayBuffer,
    purpose: "blob" | "meta",
    aad?: string,
  ): Promise<ArrayBuffer> {
    const key = purpose === "blob" ? this.blobKey : this.metaKey;
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
    const data = plaintext instanceof Uint8Array ? toArrayBuffer(plaintext) : plaintext;
    const params: AesGcmParams = { name: "AES-GCM", iv: toArrayBuffer(nonce) };
    if (aad !== undefined) params.additionalData = toArrayBuffer(encoder.encode(aad));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(params, key, data));
    const out = new Uint8Array(4 + 1 + NONCE_LENGTH + ciphertext.byteLength);
    out.set(MAGIC, 0);
    out[4] = FORMAT_VERSION;
    out.set(nonce, 5);
    out.set(ciphertext, 5 + NONCE_LENGTH);
    return toArrayBuffer(out);
  }

  async decrypt(envelope: ArrayBuffer, purpose: "blob" | "meta", aad?: string): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(envelope);
    if (bytes.byteLength < 5 + NONCE_LENGTH || MAGIC.some((b, i) => bytes[i] !== b)) {
      throw new Error("Not an S3 Sync encrypted envelope");
    }
    if (bytes[4] !== FORMAT_VERSION) {
      throw new Error(`Unsupported envelope version ${bytes[4]}`);
    }
    const key = purpose === "blob" ? this.blobKey : this.metaKey;
    const nonce = bytes.slice(5, 5 + NONCE_LENGTH);
    const ciphertext = bytes.slice(5 + NONCE_LENGTH);
    const params: AesGcmParams = { name: "AES-GCM", iv: toArrayBuffer(nonce) };
    if (aad !== undefined) params.additionalData = toArrayBuffer(encoder.encode(aad));
    return crypto.subtle.decrypt(params, key, toArrayBuffer(ciphertext));
  }

  async encryptJson(value: unknown, aad?: string): Promise<ArrayBuffer> {
    return this.encrypt(encoder.encode(JSON.stringify(value)), "meta", aad);
  }

  async decryptJson<T>(envelope: ArrayBuffer, aad?: string): Promise<T> {
    return JSON.parse(decoder.decode(await this.decrypt(envelope, "meta", aad))) as T;
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong encryption passphrase for this remote vault");
    this.name = "WrongPassphraseError";
  }
}

/** Random opaque blob id for encrypted mode so object keys leak no file paths. */
export function randomBlobId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
