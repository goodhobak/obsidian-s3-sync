/**
 * AWS Signature Version 4 signing implemented on WebCrypto only, so it works
 * in the Obsidian desktop/mobile renderer and in node tests alike.
 */

const encoder = new TextEncoder();

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const buf =
    bytes instanceof Uint8Array
      ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      : bytes;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const keyBuf =
    key instanceof Uint8Array
      ? (key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer)
      : key;
  const cryptoKey = await crypto.subtle.importKey("raw", keyBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/** RFC 3986 encode, but keep "/" for path segments when requested. */
export function uriEncode(value: string, keepSlash: boolean): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === "/")) {
      out += ch;
    } else {
      for (const byte of encoder.encode(ch)) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

export interface SignInput {
  method: string;
  /** Absolute path of the request, already URI-encoded per S3 rules. */
  canonicalPath: string;
  /** Query params, raw (unencoded) key/value pairs. */
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHashHex: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injectable clock for tests. */
  now?: Date;
  /**
   * Skip signing the x-amz-content-sha256 header (the payload hash still ends
   * the canonical request). Only used to validate against the official AWS
   * SigV4 test suite, whose vectors omit that header; S3 itself requires it.
   */
  omitContentSha256Header?: boolean;
}

export interface SignedRequest {
  headers: Record<string, string>;
  /** Encoded query string, "" when no params. */
  queryString: string;
}

function amzDate(now: Date): { dateTime: string; date: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { dateTime: iso, date: iso.slice(0, 8) };
}

export function canonicalQueryString(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * Sign a request. Returns the headers to send (input headers + host assumed
 * present + x-amz-date, x-amz-content-sha256, authorization).
 */
export async function signRequest(input: SignInput): Promise<SignedRequest> {
  const { dateTime, date } = amzDate(input.now ?? new Date());

  const headers: Record<string, string> = { ...input.headers };
  headers["x-amz-date"] = dateTime;
  if (!input.omitContentSha256Header) headers["x-amz-content-sha256"] = input.payloadHashHex;

  const sortedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => {
      const original = Object.keys(headers).find((k) => k.toLowerCase() === name);
      const value = headers[original as string] ?? "";
      return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");

  const queryString = canonicalQueryString(input.query);

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalPath,
    queryString,
    canonicalHeaders,
    signedHeaders,
    input.payloadHashHex,
  ].join("\n");

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", dateTime, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), date);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(new Uint8Array(await hmac(kSigning, stringToSign)));

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers, queryString };
}
