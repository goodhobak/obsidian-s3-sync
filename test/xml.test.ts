import { describe, expect, it } from "vitest";
import { xmlAll, xmlBlocks, xmlFirst } from "../src/s3/xml";

const LIST_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <Prefix>vault/</Prefix>
  <KeyCount>2</KeyCount>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token&amp;123</NextContinuationToken>
  <Contents>
    <Key>vault/files/a &amp; b.md</Key>
    <Size>42</Size>
    <ETag>&quot;abc123&quot;</ETag>
    <LastModified>2026-08-03T00:00:00.000Z</LastModified>
  </Contents>
  <Contents>
    <Key>vault/meta/manifest.json</Key>
    <Size>1024</Size>
    <ETag>&quot;def456&quot;</ETag>
    <LastModified>2026-08-03T01:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

describe("xml", () => {
  it("extracts repeated blocks and fields", () => {
    const blocks = xmlBlocks(LIST_SAMPLE, "Contents");
    expect(blocks).toHaveLength(2);
    expect(xmlFirst(blocks[0]!, "Key")).toBe("vault/files/a & b.md");
    expect(xmlFirst(blocks[0]!, "Size")).toBe("42");
    expect(xmlFirst(blocks[1]!, "ETag")).toBe('"def456"');
  });

  it("decodes entities in continuation tokens", () => {
    expect(xmlFirst(LIST_SAMPLE, "NextContinuationToken")).toBe("token&123");
    expect(xmlFirst(LIST_SAMPLE, "IsTruncated")).toBe("true");
  });

  it("returns all keys in document order", () => {
    expect(xmlAll(LIST_SAMPLE, "Key")).toEqual(["vault/files/a & b.md", "vault/meta/manifest.json"]);
  });

  it("returns null for missing tags", () => {
    expect(xmlFirst(LIST_SAMPLE, "DoesNotExist")).toBeNull();
  });
});
