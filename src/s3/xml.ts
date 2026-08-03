/**
 * Minimal XML value extraction for the handful of well-formed S3 responses we
 * consume. Environment-independent (no DOMParser) so the same code runs in the
 * Obsidian renderer and in node.
 */

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

/** All text contents of <tag>...</tag> in document order (non-nested tags only). */
export function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(decodeXmlEntities(m[1] ?? ""));
  return out;
}

/** First text content of <tag>...</tag>, or null. */
export function xmlFirst(xml: string, tag: string): string | null {
  return xmlAll(xml, tag)[0] ?? null;
}

/** Raw inner blocks of a repeated container tag, e.g. <Contents>...</Contents>. */
export function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? "");
  return out;
}
