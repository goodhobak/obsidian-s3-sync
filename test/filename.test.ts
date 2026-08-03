import { describe, expect, it } from "vitest";
import { desanitizeVaultPath, hasWindowsIllegalChars, sanitizeVaultPath } from "../src/platform/filename";

describe("Windows filename sanitization", () => {
  const illegal = 'notes/meeting: 10<30 "plan" | v2?.md';

  it("detects Windows-illegal characters", () => {
    expect(hasWindowsIllegalChars(illegal)).toBe(true);
    expect(hasWindowsIllegalChars("notes/normal file.md")).toBe(false);
  });

  it("maps illegal characters to legal fullwidth equivalents", () => {
    const safe = sanitizeVaultPath(illegal);
    expect(hasWindowsIllegalChars(safe)).toBe(false);
    expect(safe).not.toContain(":");
    expect(safe).not.toContain("?");
    expect(safe).toContain("："); // fullwidth colon substituted in
  });

  it("round-trips exactly (sanitize -> desanitize is identity)", () => {
    for (const p of [
      illegal,
      'a:b*c?d"e<f>g|h\\i.md',
      "folder/sub/normal.md",
      "한글 노트: 회의 <중요>.md",
    ]) {
      expect(desanitizeVaultPath(sanitizeVaultPath(p))).toBe(p);
    }
  });

  it("preserves path separators", () => {
    expect(sanitizeVaultPath("a/b:c/d.md")).toBe("a/b：c/d.md");
    expect(sanitizeVaultPath("a/b/c.md")).toBe("a/b/c.md");
  });

  it("leaves already-legal names untouched", () => {
    const p = "notes/plain.md";
    expect(sanitizeVaultPath(p)).toBe(p);
    expect(desanitizeVaultPath(p)).toBe(p);
  });
});
