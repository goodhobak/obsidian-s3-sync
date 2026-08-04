/** Per-file sync status for the overview tab. */
export type FileSyncStatus = "synced" | "modified" | "failed" | "remoteOnly" | "localOnly";

export interface OverviewRow {
  path: string;
  status: FileSyncStatus;
  /** Error message when status is "failed". */
  reason?: string;
}

export interface OverviewData {
  rows: OverviewRow[];
  counts: Record<FileSyncStatus, number>;
}

export interface OverviewInputs {
  /** Syncable local files (filters already applied): path -> mtime+size. */
  local: Map<string, { mtime: number; size: number }>;
  /** Files tracked in the local index (last-synced state). */
  indexed: Map<string, { mtime: number; size: number }>;
  /** Live (non-deleted) remote manifest paths. */
  remoteLive: Set<string>;
  /** Paths that failed in the most recent sync: path -> reason. */
  failures: Map<string, string>;
}

/**
 * Classify every file into one status without hashing (uses mtime+size against
 * the index). Precedence: failed > (both sides: synced/modified) > remote-only
 * > local-only. Pure and deterministic for unit testing.
 */
export function classifyOverview(inp: OverviewInputs): OverviewData {
  const counts: Record<FileSyncStatus, number> = {
    synced: 0,
    modified: 0,
    failed: 0,
    remoteOnly: 0,
    localOnly: 0,
  };
  const rows: OverviewRow[] = [];
  const paths = new Set<string>([...inp.local.keys(), ...inp.remoteLive, ...inp.failures.keys()]);

  for (const path of paths) {
    let status: FileSyncStatus;
    let reason: string | undefined;
    if (inp.failures.has(path)) {
      status = "failed";
      reason = inp.failures.get(path);
    } else {
      const local = inp.local.get(path);
      const inRemote = inp.remoteLive.has(path);
      if (local && inRemote) {
        const idx = inp.indexed.get(path);
        status = idx && idx.mtime === local.mtime && idx.size === local.size ? "synced" : "modified";
      } else if (inRemote) {
        status = "remoteOnly";
      } else {
        status = "localOnly";
      }
    }
    rows.push({ path, status, reason });
    counts[status]++;
  }

  rows.sort((a, b) => a.path.localeCompare(b.path));
  return { rows, counts };
}
