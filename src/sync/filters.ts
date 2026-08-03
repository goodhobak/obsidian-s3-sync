import type { SyncFilterSettings } from "../types";

/** Marker inserted into conflict copy filenames; those files sync like any other. */
export const CONFLICT_MARKER = " (conflict ";

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Whether a vault-relative path participates in sync.
 * Markdown always syncs; other extensions are opt-in. Hidden files/folders
 * (dot-prefixed) never sync. Size is checked separately by the scanner.
 */
export function isSyncablePath(path: string, filters: SyncFilterSettings): boolean {
  if (path.length === 0) return false;
  // Defense against malicious/corrupt remote manifests: reject anything that
  // is not a clean relative vault path (traversal, absolute, backslash, NUL).
  if (path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  if (segments.some((s) => s.length === 0 || s.startsWith("."))) return false;
  for (const folder of filters.excludedFolders) {
    const normalized = folder.replace(/^\/+|\/+$/g, "");
    if (normalized && (path === normalized || path.startsWith(normalized + "/"))) return false;
  }
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
