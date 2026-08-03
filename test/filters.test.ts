import { describe, expect, it } from "vitest";
import { conflictCopyPath, extensionOf, isSyncablePath } from "../src/sync/filters";
import { DEFAULT_SETTINGS } from "../src/types";

const filters = { ...DEFAULT_SETTINGS.filters, excludedFolders: ["private", "/slashed/"] };

describe("isSyncablePath", () => {
  it("always syncs markdown, opt-in for other extensions", () => {
    expect(isSyncablePath("notes/a.md", filters)).toBe(true);
    expect(isSyncablePath("img/pic.png", filters)).toBe(true); // default extension list
    expect(isSyncablePath("bin/tool.exe", filters)).toBe(false);
    expect(isSyncablePath("noext", filters)).toBe(false);
  });

  it("never syncs hidden files or folders", () => {
    expect(isSyncablePath(".obsidian/app.json", filters)).toBe(false);
    expect(isSyncablePath("notes/.hidden.md", filters)).toBe(false);
    expect(isSyncablePath("a/.git/x.md", filters)).toBe(false);
  });

  it("rejects traversal, absolute, and malformed paths from a hostile manifest", () => {
    expect(isSyncablePath("../outside.md", filters)).toBe(false);
    expect(isSyncablePath("a/../../b.md", filters)).toBe(false);
    expect(isSyncablePath("/etc/passwd.md", filters)).toBe(false); // empty first segment
    expect(isSyncablePath("a//b.md", filters)).toBe(false); // empty middle segment
    expect(isSyncablePath("a\\b.md", filters)).toBe(false);
    expect(isSyncablePath("a/b\0c.md", filters)).toBe(false);
    expect(isSyncablePath("", filters)).toBe(false);
  });

  it("applies excluded folders with slash normalization", () => {
    expect(isSyncablePath("private/x.md", filters)).toBe(false);
    expect(isSyncablePath("private.md", filters)).toBe(true); // prefix, not folder
    expect(isSyncablePath("slashed/y.md", filters)).toBe(false);
    expect(isSyncablePath("public/x.md", filters)).toBe(true);
  });

  it("respects max size in the scanner, not here (path-only check)", () => {
    expect(isSyncablePath("big/file.md", { ...filters, maxFileSize: 1 })).toBe(true);
  });
});

describe("extensionOf", () => {
  it("extracts lowercase extensions", () => {
    expect(extensionOf("a/B.MD")).toBe("md");
    expect(extensionOf("a/noext")).toBe("");
    expect(extensionOf("a/.hidden")).toBe("");
    expect(extensionOf("a/x.tar.gz")).toBe("gz");
  });
});

describe("conflictCopyPath", () => {
  const at = new Date(2026, 7, 3, 15, 42, 33);

  it("inserts the marker before the extension", () => {
    expect(conflictCopyPath("notes/foo.md", at)).toBe("notes/foo (conflict 2026-08-03 154233).md");
  });

  it("appends for extension-less files", () => {
    expect(conflictCopyPath("notes/foo", at)).toBe("notes/foo (conflict 2026-08-03 154233)");
  });
});
