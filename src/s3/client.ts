import type { HttpClient, HttpResponse } from "../http/client";
import type { S3ConnectionSettings } from "../types";
import { canonicalQueryString, sha256Hex, signRequest, uriEncode } from "./sigv4";
import { xmlBlocks, xmlFirst } from "./xml";

export class S3Error extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly key?: string,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

export interface PutOptions {
  contentType?: string;
  /** Only write if the current object's ETag matches (manifest optimistic locking). */
  ifMatch?: string;
  /** Only write if the object does not exist. */
  ifNoneMatch?: boolean;
}

export interface GetResult {
  body: ArrayBuffer;
  etag: string | null;
}

export interface HeadResult {
  etag: string | null;
  size: number;
}

export interface ListedObject {
  key: string;
  size: number;
  etag: string | null;
  lastModified: string | null;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Thin S3 client over an injected HTTP transport. Only implements the
 * operations the sync engine needs.
 */
export class S3Client {
  constructor(
    private readonly http: HttpClient,
    private readonly conn: S3ConnectionSettings,
  ) {}

  /** Host and canonical path base depending on addressing style. */
  private endpointFor(key: string | null, query: Record<string, string>): {
    url: string;
    host: string;
    canonicalPath: string;
  } {
    const endpoint = new URL(this.conn.endpoint);
    const encodedKey = key === null ? "" : uriEncode(key, true);
    let host: string;
    let path: string;
    if (this.conn.forcePathStyle) {
      host = endpoint.host;
      path = `/${this.conn.bucket}${key === null ? "" : `/${encodedKey}`}`;
    } else {
      host = `${this.conn.bucket}.${endpoint.host}`;
      path = key === null ? "/" : `/${encodedKey}`;
    }
    const qs = canonicalQueryString(query);
    const url = `${endpoint.protocol}//${host}${path}${qs ? `?${qs}` : ""}`;
    return { url, host, canonicalPath: path };
  }

  private async send(
    method: string,
    key: string | null,
    query: Record<string, string>,
    extraHeaders: Record<string, string>,
    body?: ArrayBuffer,
  ): Promise<HttpResponse> {
    const { url, host, canonicalPath } = this.endpointFor(key, query);
    const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;
    const { headers } = await signRequest({
      method,
      canonicalPath,
      query,
      headers: { host, ...extraHeaders },
      payloadHashHex: payloadHash,
      region: this.conn.region,
      service: "s3",
      accessKeyId: this.conn.accessKeyId,
      secretAccessKey: this.conn.secretAccessKey,
    });
    // Transports set Host themselves from the URL; keep it out of the wire headers.
    const { host: _host, ...wireHeaders } = headers;
    return this.http.request({ url, method, headers: wireHeaders, body });
  }

  private throwOnError(res: HttpResponse, context: string, key?: string): void {
    if (res.status >= 200 && res.status < 300) return;
    let code: string | null = null;
    let message = `${context} failed with HTTP ${res.status}`;
    try {
      const text = new TextDecoder().decode(res.body);
      code = xmlFirst(text, "Code");
      const detail = xmlFirst(text, "Message");
      if (detail) message += `: ${detail}`;
    } catch {
      // keep the generic message when the body is not text
    }
    throw new S3Error(message, res.status, code, key);
  }

  fullKey(relativeKey: string): string {
    return this.conn.prefix ? `${this.conn.prefix}/${relativeKey}` : relativeKey;
  }

  async putObject(relativeKey: string, body: ArrayBuffer, opts: PutOptions = {}): Promise<{ etag: string | null }> {
    const headers: Record<string, string> = {
      "content-type": opts.contentType ?? "application/octet-stream",
    };
    if (opts.ifMatch) headers["if-match"] = opts.ifMatch;
    if (opts.ifNoneMatch) headers["if-none-match"] = "*";
    const res = await this.send("PUT", this.fullKey(relativeKey), {}, headers, body);
    this.throwOnError(res, `PUT ${relativeKey}`, relativeKey);
    return { etag: res.headers["etag"] ?? null };
  }

  async getObject(relativeKey: string): Promise<GetResult | null> {
    const res = await this.send("GET", this.fullKey(relativeKey), {}, {});
    if (res.status === 404) return null;
    this.throwOnError(res, `GET ${relativeKey}`, relativeKey);
    return { body: res.body, etag: res.headers["etag"] ?? null };
  }

  async headObject(relativeKey: string): Promise<HeadResult | null> {
    const res = await this.send("HEAD", this.fullKey(relativeKey), {}, {});
    if (res.status === 404) return null;
    this.throwOnError(res, `HEAD ${relativeKey}`, relativeKey);
    return {
      etag: res.headers["etag"] ?? null,
      size: parseInt(res.headers["content-length"] ?? "0", 10),
    };
  }

  async deleteObject(relativeKey: string): Promise<void> {
    const res = await this.send("DELETE", this.fullKey(relativeKey), {}, {});
    if (res.status === 404) return;
    this.throwOnError(res, `DELETE ${relativeKey}`, relativeKey);
  }

  /** Server-side copy within the bucket (used for version history snapshots). */
  async copyObject(fromRelativeKey: string, toRelativeKey: string): Promise<void> {
    const source = `/${this.conn.bucket}/${uriEncode(this.fullKey(fromRelativeKey), true)}`;
    const res = await this.send("PUT", this.fullKey(toRelativeKey), {}, { "x-amz-copy-source": source });
    this.throwOnError(res, `COPY ${fromRelativeKey} -> ${toRelativeKey}`, fromRelativeKey);
  }

  /** List all objects under the prefix + relativePrefix, following pagination. */
  async listObjects(relativePrefix: string): Promise<ListedObject[]> {
    const out: ListedObject[] = [];
    let continuationToken: string | null = null;
    do {
      const query: Record<string, string> = {
        "list-type": "2",
        prefix: this.fullKey(relativePrefix),
        "max-keys": "1000",
      };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const res = await this.send("GET", null, query, {});
      this.throwOnError(res, `LIST ${relativePrefix}`);
      const text = new TextDecoder().decode(res.body);
      for (const block of xmlBlocks(text, "Contents")) {
        const key = xmlFirst(block, "Key");
        if (!key) continue;
        out.push({
          key,
          size: parseInt(xmlFirst(block, "Size") ?? "0", 10),
          etag: xmlFirst(block, "ETag"),
          lastModified: xmlFirst(block, "LastModified"),
        });
      }
      continuationToken = xmlFirst(text, "IsTruncated") === "true" ? xmlFirst(text, "NextContinuationToken") : null;
    } while (continuationToken);
    return out;
  }

  /** Cheap connectivity + credential probe. */
  async testConnection(): Promise<void> {
    const res = await this.send("GET", null, { "list-type": "2", "max-keys": "1", prefix: this.fullKey("") }, {});
    this.throwOnError(res, "Connection test");
  }
}
