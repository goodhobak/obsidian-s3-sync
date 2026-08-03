import { S3Error, type GetResult, type PutOptions } from "../s3/client";
import { VaultCipher, WrongPassphraseError, randomBlobId, type VaultCryptoMeta } from "../crypto/encryption";
import { sha256Hex } from "../s3/sigv4";
import { emptyManifest, type RemoteManifest } from "../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const VAULT_META_KEY = "meta/vault.json";
const MANIFEST_PLAIN_KEY = "meta/manifest.json";
const MANIFEST_ENC_KEY = "meta/manifest.enc";

export interface VaultMeta {
  schemaVersion: 1;
  encrypted: boolean;
  crypto?: VaultCryptoMeta;
  createdAt: number;
}

export class ManifestConflictError extends Error {
  constructor() {
    super("Remote manifest was updated by another device");
    this.name = "ManifestConflictError";
  }
}

export class BlobIntegrityError extends Error {
  constructor(blobKey: string, expected: string, actual: string) {
    super(`Blob ${blobKey} failed integrity check (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
    this.name = "BlobIntegrityError";
  }
}

export class EncryptionMismatchError extends Error {
  constructor(remoteEncrypted: boolean) {
    super(
      remoteEncrypted
        ? "Remote vault is end-to-end encrypted but encryption is disabled in settings"
        : "Remote vault is not encrypted but encryption is enabled in settings",
    );
    this.name = "EncryptionMismatchError";
  }
}

export interface LoadedManifest {
  manifest: RemoteManifest;
  etag: string | null;
}

/** The subset of S3Client the remote store needs (kept narrow for tests). */
export interface S3Api {
  putObject(relativeKey: string, body: ArrayBuffer, opts?: PutOptions): Promise<{ etag: string | null }>;
  getObject(relativeKey: string): Promise<GetResult | null>;
  deleteObject(relativeKey: string): Promise<void>;
  copyObject(fromRelativeKey: string, toRelativeKey: string): Promise<void>;
}

/**
 * Remote side of the sync engine: vault meta bootstrap, manifest load/save with
 * ETag optimistic locking, and blob transfer with transparent encryption.
 */
export class RemoteStore {
  private cipher: VaultCipher | null = null;
  private encrypted = false;

  constructor(
    private readonly s3: S3Api,
    private readonly settings: { encryptionEnabled: boolean; encryptionPassphrase: string },
  ) {}

  get isEncrypted(): boolean {
    return this.encrypted;
  }

  /**
   * Load or create meta/vault.json and derive keys when encrypted.
   * Must be called once before any manifest/blob operation.
   */
  async initialize(): Promise<void> {
    const existing = await this.s3.getObject(VAULT_META_KEY);
    if (existing) {
      const meta = JSON.parse(decoder.decode(existing.body)) as VaultMeta;
      if (meta.encrypted !== this.settings.encryptionEnabled) {
        throw new EncryptionMismatchError(meta.encrypted);
      }
      this.encrypted = meta.encrypted;
      if (meta.encrypted) {
        if (!meta.crypto) throw new Error("Remote vault meta is missing crypto parameters");
        this.cipher = await VaultCipher.open(this.settings.encryptionPassphrase, meta.crypto);
      }
      return;
    }

    // Fresh remote vault: create meta according to local settings.
    this.encrypted = this.settings.encryptionEnabled;
    let crypto: VaultCryptoMeta | undefined;
    if (this.encrypted) {
      if (!this.settings.encryptionPassphrase) throw new WrongPassphraseError();
      const init = await VaultCipher.initialize(this.settings.encryptionPassphrase);
      this.cipher = init.cipher;
      crypto = init.meta;
    }
    const meta: VaultMeta = { schemaVersion: 1, encrypted: this.encrypted, crypto, createdAt: Date.now() };
    await this.s3.putObject(VAULT_META_KEY, encoder.encode(JSON.stringify(meta)).buffer as ArrayBuffer, {
      contentType: "application/json",
      ifNoneMatch: true,
    });
  }

  private get manifestKey(): string {
    return this.encrypted ? MANIFEST_ENC_KEY : MANIFEST_PLAIN_KEY;
  }

  async loadManifest(): Promise<LoadedManifest> {
    const res = await this.s3.getObject(this.manifestKey);
    if (!res) return { manifest: emptyManifest(), etag: null };
    const manifest = this.cipher
      ? await this.cipher.decryptJson<RemoteManifest>(res.body, this.manifestKey)
      : (JSON.parse(decoder.decode(res.body)) as RemoteManifest);
    return { manifest, etag: res.etag };
  }

  /**
   * Persist the manifest guarded by the ETag observed at load time.
   * Throws ManifestConflictError when another device won the race.
   */
  async saveManifest(manifest: RemoteManifest, expectedEtag: string | null): Promise<string | null> {
    const body = this.cipher
      ? await this.cipher.encryptJson(manifest, this.manifestKey)
      : (encoder.encode(JSON.stringify(manifest)).buffer as ArrayBuffer);
    try {
      const res = await this.s3.putObject(this.manifestKey, body, {
        contentType: this.cipher ? "application/octet-stream" : "application/json",
        ...(expectedEtag ? { ifMatch: expectedEtag } : { ifNoneMatch: true }),
      });
      return res.etag;
    } catch (err) {
      if (err instanceof S3Error && (err.status === 412 || err.status === 409)) {
        throw new ManifestConflictError();
      }
      throw err;
    }
  }

  /** Blob key for a new live version of a vault path. */
  newBlobKey(path: string): string {
    return this.encrypted ? `blobs/${randomBlobId()}` : `files/${path}`;
  }

  historyBlobKey(hash: string): string {
    return `history/${hash}`;
  }

  /**
   * @param hash SHA-256 (hex) of the plaintext. Bound as AES-GCM AAD so a blob
   * cannot be replayed as different content, and used to verify integrity on
   * download. The hash is content-identity, so it stays valid across the
   * server-side copy that produces history blobs.
   */
  async uploadBlob(blobKey: string, plaintext: ArrayBuffer, hash: string): Promise<void> {
    const body = this.cipher ? await this.cipher.encrypt(plaintext, "blob", `blob:${hash}`) : plaintext;
    await this.s3.putObject(blobKey, body);
  }

  /**
   * Download, decrypt, and verify a blob against its expected plaintext hash.
   * Returns null if the object is missing. Throws BlobIntegrityError if the
   * decrypted bytes do not hash to expectedHash (tamper / blob-swap / corruption).
   */
  async downloadBlob(blobKey: string, expectedHash: string): Promise<ArrayBuffer | null> {
    const res = await this.s3.getObject(blobKey);
    if (!res) return null;
    const plaintext = this.cipher ? await this.cipher.decrypt(res.body, "blob", `blob:${expectedHash}`) : res.body;
    const actual = await sha256Hex(plaintext);
    if (actual !== expectedHash) throw new BlobIntegrityError(blobKey, expectedHash, actual);
    return plaintext;
  }

  async deleteBlob(blobKey: string): Promise<void> {
    await this.s3.deleteObject(blobKey);
  }

  /** Server-side snapshot of the current live blob into content-addressed history. */
  async snapshotToHistory(liveBlobKey: string, hash: string): Promise<void> {
    await this.s3.copyObject(liveBlobKey, this.historyBlobKey(hash));
  }

  async downloadHistoryBlob(hash: string): Promise<ArrayBuffer | null> {
    return this.downloadBlob(this.historyBlobKey(hash), hash);
  }

  async deleteHistoryBlob(hash: string): Promise<void> {
    await this.s3.deleteObject(this.historyBlobKey(hash));
  }
}
