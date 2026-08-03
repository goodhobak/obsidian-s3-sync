/**
 * Line-based three-way merge (diff3 style) for markdown conflict resolution.
 * Returns the merged text only when every hunk merges cleanly; any overlapping
 * change yields { clean: false } and the caller falls back to a conflict copy.
 */

export interface MergeResult {
  clean: boolean;
  merged?: string;
}

/** Longest-common-subsequence table walk producing matched index pairs. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

interface Chunk {
  baseStart: number;
  baseEnd: number;
  sideStart: number;
  sideEnd: number;
}

/** Non-matching regions between base and a side, in base order. */
function diffChunks(base: string[], side: string[]): Chunk[] {
  const pairs = lcsPairs(base, side);
  const chunks: Chunk[] = [];
  let bi = 0;
  let si = 0;
  for (const [b, s] of pairs) {
    if (b > bi || s > si) chunks.push({ baseStart: bi, baseEnd: b, sideStart: si, sideEnd: s });
    bi = b + 1;
    si = s + 1;
  }
  if (bi < base.length || si < side.length) {
    chunks.push({ baseStart: bi, baseEnd: base.length, sideStart: si, sideEnd: side.length });
  }
  return chunks;
}

export function mergeThreeWay(baseText: string, localText: string, remoteText: string): MergeResult {
  if (localText === remoteText) return { clean: true, merged: localText };
  if (baseText === localText) return { clean: true, merged: remoteText };
  if (baseText === remoteText) return { clean: true, merged: localText };

  const base = baseText.split("\n");
  const local = localText.split("\n");
  const remote = remoteText.split("\n");

  const localChunks = diffChunks(base, local);
  const remoteChunks = diffChunks(base, remote);

  // Any overlap in base line ranges means both sides touched the same region.
  for (const lc of localChunks) {
    for (const rc of remoteChunks) {
      const overlaps = lc.baseStart < rc.baseEnd && rc.baseStart < lc.baseEnd;
      // Insertions at the same base position (zero-length ranges) also collide.
      const sameInsertPoint =
        lc.baseStart === lc.baseEnd && rc.baseStart === rc.baseEnd && lc.baseStart === rc.baseStart;
      if (overlaps || sameInsertPoint) return { clean: false };
    }
  }

  // Apply both chunk sets over the base, walking base positions in order.
  type Edit = { at: number; end: number; lines: string[] };
  const edits: Edit[] = [
    ...localChunks.map((c) => ({ at: c.baseStart, end: c.baseEnd, lines: local.slice(c.sideStart, c.sideEnd) })),
    ...remoteChunks.map((c) => ({ at: c.baseStart, end: c.baseEnd, lines: remote.slice(c.sideStart, c.sideEnd) })),
  ].sort((a, b) => a.at - b.at || a.end - b.end);

  const out: string[] = [];
  let pos = 0;
  for (const edit of edits) {
    out.push(...base.slice(pos, edit.at));
    out.push(...edit.lines);
    pos = edit.end;
  }
  out.push(...base.slice(pos));
  return { clean: true, merged: out.join("\n") };
}
