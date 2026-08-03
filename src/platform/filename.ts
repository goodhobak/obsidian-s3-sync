/**
 * Cross-platform filename handling.
 *
 * Files authored on macOS/Linux can contain characters that are illegal in
 * Windows filenames (`< > : " \ | ? *`). To let such files sync onto Windows,
 * we map those characters to their fullwidth Unicode equivalents when writing
 * locally, and map them back when reading, so the canonical vault path (used in
 * the manifest and on other platforms) is preserved. The substitution is a
 * bijection on this character set, so sanitize/desanitize round-trips exactly.
 *
 * Only the leaf segments are transformed; `/` path separators are untouched.
 */

// ASCII (illegal on Windows) -> fullwidth (legal everywhere). Bijective.
const FORWARD: Record<string, string> = {
  "<": "＜",
  ">": "＞",
  ":": "：",
  '"': "＂",
  "\\": "＼",
  "|": "｜",
  "?": "？",
  "*": "＊",
};
const REVERSE: Record<string, string> = Object.fromEntries(Object.entries(FORWARD).map(([k, v]) => [v, k]));

const ILLEGAL_RE = /[<>:"\\|?*]/g;
const FULLWIDTH_RE = /[＜＞：＂＼｜？＊]/g;

/** True if the path has a segment with a Windows-illegal character. */
export function hasWindowsIllegalChars(path: string): boolean {
  return ILLEGAL_RE.test(path);
}

/** Canonical vault path -> Windows-safe local path (fullwidth substitution). */
export function sanitizeVaultPath(path: string): string {
  return path.replace(ILLEGAL_RE, (c) => FORWARD[c] ?? c);
}

/** Windows-safe local path -> canonical vault path (reverse substitution). */
export function desanitizeVaultPath(path: string): string {
  return path.replace(FULLWIDTH_RE, (c) => REVERSE[c] ?? c);
}
