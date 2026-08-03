/**
 * Transport abstraction so the S3 client can run on Obsidian's requestUrl
 * (bypasses CORS, works on mobile) and on plain fetch (node tests/integration).
 */

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  /** Lowercased header names. */
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** Obsidian transport. Imported lazily so tests never need the obsidian module. */
export class ObsidianHttpClient implements HttpClient {
  constructor(private requestUrl: (opts: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: ArrayBuffer;
    throw?: boolean;
    contentType?: string;
  }) => Promise<{ status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }>) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await this.requestUrl({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
      throw: false,
    });
    return { status: res.status, headers: lowercaseHeaders(res.headers), body: res.arrayBuffer };
  }
}

/** Fetch transport for node-based tests and the integration script. */
export class FetchHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ? new Uint8Array(req.body) : undefined,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: await res.arrayBuffer() };
  }
}
