import { describe, expect, it } from "vitest";
import {
  conflictCopyPath,
  extensionOf,
  folderWithDescendants,
  isSyncablePath,
  toggleFolderExclusion,
} from "../src/sync/filters";
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

  it("applies excluded files as exact matches with slash normalization", () => {
    const f = { ...filters, excludedFiles: ["media/big.mp4", "/slashed.md/"] };
    expect(isSyncablePath("media/big.mp4", f)).toBe(false);
    expect(isSyncablePath("slashed.md", f)).toBe(false);
    expect(isSyncablePath("media/big.mp4.md", f)).toBe(true); // prefix, not the file
    expect(isSyncablePath("media/other.mp4", f)).toBe(true);
    expect(isSyncablePath("big.mp4", f)).toBe(true); // different folder
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

const TREE = ["a", "a/b", "a/b/c", "a/b/d", "a/e", "z", "z/y"];

describe("folderWithDescendants", () => {
  it("returns the folder and everything nested beneath it", () => {
    expect(folderWithDescendants("a/b", TREE).sort()).toEqual(["a/b", "a/b/c", "a/b/d"]);
  });

  it("does not match sibling prefixes (a/b !~> a/be)", () => {
    const t = ["a/b", "a/be", "a/b/c"];
    expect(folderWithDescendants("a/b", t).sort()).toEqual(["a/b", "a/b/c"]);
  });

  it("returns just the leaf when it has no children", () => {
    expect(folderWithDescendants("a/b/c", TREE)).toEqual(["a/b/c"]);
  });
});

describe("toggleFolderExclusion", () => {
  it("adds only the folder itself when includeSubfolders is off", () => {
    const next = toggleFolderExclusion(new Set(), "a/b", true, false, TREE);
    expect([...next]).toEqual(["a/b"]);
  });

  it("adds the whole subtree when includeSubfolders is on", () => {
    const next = toggleFolderExclusion(new Set(), "a/b", true, true, TREE);
    expect([...next].sort()).toEqual(["a/b", "a/b/c", "a/b/d"]);
  });

  it("removes the whole subtree when unchecked with includeSubfolders on", () => {
    const start = new Set(["a", "a/b", "a/b/c", "a/b/d", "a/e"]);
    const next = toggleFolderExclusion(start, "a/b", false, true, TREE);
    expect([...next].sort()).toEqual(["a", "a/e"]);
  });

  it("does not mutate the input set", () => {
    const start = new Set(["x"]);
    toggleFolderExclusion(start, "a/b", true, true, TREE);
    expect([...start]).toEqual(["x"]);
  });
});

describe("isSyncablePath — .obsidian config folder", () => {
  const off = { ...DEFAULT_SETTINGS.filters, syncObsidianConfig: false };
  const on = { ...DEFAULT_SETTINGS.filters, syncObsidianConfig: true };

  it("never syncs .obsidian when the option is off (default)", () => {
    expect(isSyncablePath(".obsidian/appearance.json", off)).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/dataview/main.js", off)).toBe(false);
  });

  it("syncs config files (any extension) when the option is on", () => {
    expect(isSyncablePath(".obsidian/appearance.json", on)).toBe(true);
    expect(isSyncablePath(".obsidian/plugins/dataview/main.js", on)).toBe(true);
    expect(isSyncablePath(".obsidian/themes/Things/theme.css", on)).toBe(true);
    expect(isSyncablePath(".obsidian/snippets/custom.css", on)).toBe(true);
  });

  it("never syncs this plugin's own folder (secrets + local state)", () => {
    expect(isSyncablePath(".obsidian/plugins/s3-sync/data.json", on)).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/s3-sync/sync-index.json", on)).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/s3-sync/main.js", on)).toBe(false);
  });

  it("never syncs per-device workspace layout or trash or nested hidden files", () => {
    expect(isSyncablePath(".obsidian/workspace.json", on)).toBe(false);
    expect(isSyncablePath(".obsidian/workspace-mobile.json", on)).toBe(false);
    expect(isSyncablePath(".obsidian/trash/x.md", on)).toBe(false);
    expect(isSyncablePath(".obsidian/.DS_Store", on)).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/.git/config", on)).toBe(false);
  });

  it("never syncs the enabled-plugins lists (auto-enable RCE vector)", () => {
    expect(isSyncablePath(".obsidian/community-plugins.json", on)).toBe(false);
    expect(isSyncablePath(".obsidian/community-plugins-mobile.json", on)).toBe(false);
  });

  it("still blocks traversal even inside .obsidian", () => {
    expect(isSyncablePath(".obsidian/../secrets.md", on)).toBe(false);
  });

  it("other hidden folders never sync regardless of the option", () => {
    expect(isSyncablePath(".git/config", on)).toBe(false);
    expect(isSyncablePath(".trash/note.md", on)).toBe(false);
  });
});
