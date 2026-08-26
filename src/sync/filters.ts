import type { SyncFilterSettings } from "../types";

/** Marker inserted into conflict copy filenames; those files sync like any other. */
export const CONFLICT_MARKER = " (conflict ";

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** `folder` itself plus every folder nested beneath it, restricted to `all`. */
export function folderWithDescendants(folder: string, all: readonly string[]): string[] {
  const prefix = folder + "/";
  return all.filter((f) => f === folder || f.startsWith(prefix));
}

/**
 * Toggle a folder in an exclusion set. When `includeSubfolders` is true, the
 * folder's whole subtree (as present in `allFolders`) is toggled together;
 * otherwise only the folder itself. Returns a new set.
 */
export function toggleFolderExclusion(
  current: ReadonlySet<string>,
  folder: string,
  select: boolean,
  includeSubfolders: boolean,
  allFolders: readonly string[],
): Set<string> {
  const next = new Set(current);
  const targets = includeSubfolders ? folderWithDescendants(folder, allFolders) : [folder];
  for (const t of targets) {
    if (select) next.add(t);
    else next.delete(t);
  }
  return next;
}

/** The vault's config folder. Obsidian defaults to `.obsidian`. */
export const CONFIG_DIR = ".obsidian";
/** This plugin's own folder — never synced (holds secrets + local sync state). */
export const OWN_PLUGIN_DIR = `${CONFIG_DIR}/plugins/s3-sync`;

/**
 * Which `.obsidian` config paths are safe to sync. Excludes:
 *  - this plugin's own folder (data.json holds the S3 secret + passphrase;
 *    sync-index/sync-log are per-device state),
 *  - per-device workspace layout files (they thrash constantly),
 *  - nested hidden files (.DS_Store, .git, …),
 *  - the Trash.
 */
export function isSyncableConfigPath(path: string): boolean {
  if (path === OWN_PLUGIN_DIR || path.startsWith(OWN_PLUGIN_DIR + "/")) return false;
  const rest = path.slice(CONFIG_DIR.length + 1).split("/");
  if (rest.some((s) => s.startsWith("."))) return false; // nested hidden files
  const deviceLocal = new Set([
    "workspace.json",
    "workspace-mobile.json",
    "workspace",
    // The enabled-plugins lists are per-device AND an auto-enable vector: a
    // synced list can turn on a plugin whose code was also synced. Never sync
    // them, so config sync can't enable code on its own.
    "community-plugins.json",
    "community-plugins-mobile.json",
  ]);
  if (rest.length === 1 && deviceLocal.has(rest[0]!)) return false;
  if (rest[0] === "trash") return false;
  return true;
}

/**
 * Whether a vault-relative path participates in sync.
 * Markdown always syncs; other extensions are opt-in. Hidden files/folders
 * (dot-prefixed) never sync — except the `.obsidian` config folder when
 * `syncObsidianConfig` is on. Size is checked separately by the scanner.
 */
export function isSyncablePath(path: string, filters: SyncFilterSettings): boolean {
  if (path.length === 0) return false;
  // Defense against malicious/corrupt remote manifests: reject anything that
  // is not a clean relative vault path (traversal, absolute, backslash, NUL).
  if (path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  if (segments.some((s) => s.length === 0)) return false; // empty segment (//, leading /)
  if (segments.some((s) => s === "..")) return false; // traversal

  const isConfig = segments[0] === CONFIG_DIR;
  if (isConfig) {
    if (!filters.syncObsidianConfig) return false;
    if (!isSyncableConfigPath(path)) return false;
  } else if (segments.some((s) => s.startsWith("."))) {
    return false; // any other hidden file/folder
  }

  for (const folder of filters.excludedFolders) {
    const normalized = folder.replace(/^\/+|\/+$/g, "");
    if (normalized && (path === normalized || path.startsWith(normalized + "/"))) return false;
  }

  for (const file of filters.excludedFiles) {
    const normalized = file.replace(/^\/+|\/+$/g, "");
    if (normalized && path === normalized) return false;
  }

  if (isConfig) return true; // config files sync regardless of extension
  const ext = extensionOf(path);
  if (ext === "md") return true;
  return filters.extensions.includes(ext);
}

/**
 * "notes/foo.md" -> "notes/foo (conflict 2026-08-03 154233).md".
 * `attempt` > 0 adds a disambiguator so two conflicts of the same file within
 * the same second do not collide (the second would otherwise overwrite the first).
 */
export function conflictCopyPath(path: string, now: Date, attempt = 0): string {
  const stamp =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ` +
    `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const suffix = attempt > 0 ? `${stamp} #${attempt + 1}` : stamp;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot > slash) {
    return `${path.slice(0, dot)}${CONFLICT_MARKER}${suffix})${path.slice(dot)}`;
  }
  return `${path}${CONFLICT_MARKER}${suffix})`;
}
