import { describe, expect, it } from "vitest";
import { canonicalQueryString, sha256Hex, signRequest, uriEncode } from "../src/s3/sigv4";

/**
 * Vectors from the official AWS Signature Version 4 test suite
 * (credential scope 20150830/us-east-1/service/aws4_request).
 */
const SUITE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  now: new Date("2015-08-30T12:36:00Z"),
  omitContentSha256Header: true,
};

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function signatureOf(auth: string): string {
  return auth.split("Signature=")[1] ?? "";
}

describe("sigv4", () => {
  it("signs get-vanilla", async () => {
    const { headers } = await signRequest({
      ...SUITE,
      method: "GET",
      canonicalPath: "/",
      query: {},
      headers: { host: "example.amazonaws.com" },
      payloadHashHex: EMPTY_HASH,
    });
    expect(signatureOf(headers["authorization"] ?? "")).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("signs get-vanilla-query-order-key-case (query sorting)", async () => {
    const { headers } = await signRequest({
      ...SUITE,
      method: "GET",
      canonicalPath: "/",
      query: { Param2: "value2", Param1: "value1" },
      headers: { host: "example.amazonaws.com" },
      payloadHashHex: EMPTY_HASH,
    });
    expect(signatureOf(headers["authorization"] ?? "")).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  it("signs post-vanilla", async () => {
    const { headers } = await signRequest({
      ...SUITE,
      method: "POST",
      canonicalPath: "/",
      query: {},
      headers: { host: "example.amazonaws.com" },
      payloadHashHex: EMPTY_HASH,
    });
    expect(signatureOf(headers["authorization"] ?? "")).toBe(
      "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
  });

  it("hashes empty payload to the well-known value", async () => {
    expect(await sha256Hex("")).toBe(EMPTY_HASH);
  });

  it("percent-encodes object keys but keeps slashes", () => {
    expect(uriEncode("files/한글 노트.md", true)).toBe(
      "files/%ED%95%9C%EA%B8%80%20%EB%85%B8%ED%8A%B8.md",
    );
    expect(uriEncode("a+b=c&d", false)).toBe("a%2Bb%3Dc%26d");
  });

  it("sorts canonical query parameters by encoded key", () => {
    expect(canonicalQueryString({ b: "2", a: "1", "a-1": "3" })).toBe("a=1&a-1=3&b=2");
  });
});
