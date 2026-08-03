import { describe, expect, it } from "vitest";
import { S3Client, isTransientNetworkError } from "../src/s3/client";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/http/client";
import type { S3ConnectionSettings } from "../src/types";

const conn: S3ConnectionSettings = {
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  bucket: "b",
  accessKeyId: "k",
  secretAccessKey: "s",
  prefix: "",
  forcePathStyle: true,
};

function ok(): HttpResponse {
  return { status: 200, headers: {}, body: new ArrayBuffer(0) };
}

/** Transport that throws `failures` transient errors, then succeeds. */
class FlakyHttp implements HttpClient {
  calls = 0;
  constructor(
    private readonly failures: number,
    private readonly error = new Error("Request Failed. IOException Stream closed"),
  ) {}
  async request(_req: HttpRequest): Promise<HttpResponse> {
    this.calls++;
    if (this.calls <= this.failures) throw this.error;
    return ok();
  }
}

describe("isTransientNetworkError", () => {
  it("matches the Android and common network errors", () => {
    for (const m of [
      "Request Failed. IOException Stream closed",
      'Request Failed. UnknownHostException Unable to resolve host "obsidian.example"',
      "network timeout",
      "ECONNRESET",
      "Failed to fetch",
    ]) {
      expect(isTransientNetworkError(new Error(m))).toBe(true);
    }
  });

  it("does not match programming/auth errors", () => {
    expect(isTransientNetworkError(new Error("SignatureDoesNotMatch"))).toBe(false);
    expect(isTransientNetworkError(new Error("undefined is not a function"))).toBe(false);
  });
});

describe("S3Client transient retry", () => {
  it("retries a transient failure and then succeeds", async () => {
    const http = new FlakyHttp(2); // fail twice, succeed on the 3rd
    const s3 = new S3Client(http, conn, { maxAttempts: 4, baseDelayMs: 0 });
    const body = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await s3.putObject("blobs/x", body); // resolves (no throw)
    expect(http.calls).toBe(3);
  });

  it("gives up after maxAttempts and rethrows the transient error", async () => {
    const http = new FlakyHttp(99);
    const s3 = new S3Client(http, conn, { maxAttempts: 3, baseDelayMs: 0 });
    await expect(s3.getObject("blobs/x")).rejects.toThrow(/Stream closed/);
    expect(http.calls).toBe(3);
  });

  it("does not retry a non-transient transport error", async () => {
    const http = new FlakyHttp(99, new Error("TypeError: bad arg"));
    const s3 = new S3Client(http, conn, { maxAttempts: 4, baseDelayMs: 0 });
    await expect(s3.getObject("blobs/x")).rejects.toThrow(/bad arg/);
    expect(http.calls).toBe(1); // no retry
  });
});
