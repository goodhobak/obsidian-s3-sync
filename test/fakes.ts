import { S3Error, type GetResult, type PutOptions } from "../src/s3/client";
import type { S3Api } from "../src/sync/remote-store";
import type { IndexStore, LocalFileStat, VaultFiles } from "../src/sync/vault-files";
import type { LocalIndex } from "../src/types";

/** In-memory S3 with real If-Match / If-None-Match semantics. */
export class InMemoryS3 implements S3Api {
  objects = new Map<string, { body: ArrayBuffer; etag: string }>();
  private etagCounter = 0;

  async putObject(key: string, body: ArrayBuffer, opts: PutOptions = {}): Promise<{ etag: string | null }> {
    const existing = this.objects.get(key);
    if (opts.ifNoneMatch && existing) {
      throw new S3Error(`PUT ${key} precondition failed`, 412, "PreconditionFailed", key);
    }
    if (opts.ifMatch && (!existing || existing.etag !== opts.ifMatch)) {
      throw new S3Error(`PUT ${key} precondition failed`, 412, "PreconditionFailed", key);
    }
    const etag = `"etag-${++this.etagCounter}"`;
    this.objects.set(key, { body: body.slice(0), etag });
    return { etag };
  }

  async getObject(key: string): Promise<GetResult | null> {
    const obj = this.objects.get(key);
    return obj ? { body: obj.body.slice(0), etag: obj.etag } : null;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async copyObject(from: string, to: string): Promise<void> {
    const src = this.objects.get(from);
    if (!src) throw new S3Error(`COPY ${from}: no such key`, 404, "NoSuchKey", from);
    this.objects.set(to, { body: src.body.slice(0), etag: `"etag-${++this.etagCounter}"` });
  }
}

/** In-memory vault filesystem. */
export class InMemoryVault implements VaultFiles {
  files = new Map<string, { data: ArrayBuffer; mtime: number }>();
  private clock = 1_000_000;

  write(path: string, text: string): void {
    const bytes = new TextEncoder().encode(text);
    this.files.set(path, { data: bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer, mtime: ++this.clock });
  }

  read(path: string): string | null {
    const f = this.files.get(path);
    return f ? new TextDecoder().decode(f.data) : null;
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  async listFiles(): Promise<LocalFileStat[]> {
    return [...this.files.entries()].map(([path, f]) => ({ path, size: f.data.byteLength, mtime: f.mtime }));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(path);
    if (!f) throw new Error(`not found: ${path}`);
    return f.data.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer, mtime?: number): Promise<void> {
    const stamp = mtime ?? ++this.clock;
    // Like a real wall clock, never fall behind timestamps we have observed.
    this.clock = Math.max(this.clock, stamp);
    this.files.set(path, { data: data.slice(0), mtime: stamp });
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async stat(path: string): Promise<LocalFileStat | null> {
    const f = this.files.get(path);
    return f ? { path, size: f.data.byteLength, mtime: f.mtime } : null;
  }
}

export class InMemoryIndexStore implements IndexStore<LocalIndex> {
  private value: LocalIndex | null = null;

  async load(): Promise<LocalIndex | null> {
    return this.value ? (JSON.parse(JSON.stringify(this.value)) as LocalIndex) : null;
  }

  async save(value: LocalIndex): Promise<void> {
    this.value = JSON.parse(JSON.stringify(value)) as LocalIndex;
  }
}
