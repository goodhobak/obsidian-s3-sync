import { sha256Hex } from "../s3/sigv4";
import {
  emptyIndex,
  type ConflictCopyRecord,
  type FailedFileRecord,
  type IndexEntry,
  type LocalIndex,
  type ManifestEntry,
  type RemoteManifest,
  type SyncFilterSettings,
} from "../types";
import { conflictCopyPath, extensionOf, isSyncablePath } from "./filters";
import { mergeThreeWay } from "./merge";
import { ManifestConflictError, RemoteStore } from "./remote-store";
import type { IndexStore, LocalFileStat, VaultFiles } from "./vault-files";

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MANIFEST_RETRIES = 3;
/** Below this many deletions the mass-delete guard stays quiet. */
const MASS_DELETE_MIN_COUNT = 5;

export interface SyncSummary {
  pushed: number;
  pulled: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  merged: number;
  errors: string[];
  /** Conflicts that kept both versions (a copy was written) — candidates to resolve. */
  conflictCopies: ConflictCopyRecord[];
  /** Files that failed to sync this run — candidates to retry/resolve. */
  failedFiles: FailedFileRecord[];
}

export interface SyncProgress {
  message: string;
  /** File operations completed so far in this sync. */
  completed: number;
  /** File operations planned for this sync (0 until the plan is known). */
  total: number;
}

export interface EngineCallbacks {
  /** Return false to abort the sync when a suspiciously large deletion is planned. */
  confirmMassDelete(localDeletes: number, remoteDeletes: number, trackedTotal: number): Promise<boolean>;
  onProgress?(progress: SyncProgress): void;
}

interface ScannedFile {
  stat: LocalFileStat;
  hash: string;
}

interface PushItem {
  path: string;
  stat: LocalFileStat;
  hash: string;
}

export class ManifestRollbackError extends Error {
  constructor(seen: number, remote: number) {
    super(
      `Remote manifest revision went backwards (last applied ${seen}, remote ${remote}). ` +
        `Refusing to sync to avoid resurrecting deleted notes. If you restored the bucket ` +
        `from backup on purpose, reset local sync state to continue.`,
    );
    this.name = "ManifestRollbackError";
  }
}

export class MassDeleteAbortError extends Error {
  constructor() {
    super("Sync aborted: mass deletion was not confirmed");
    this.name = "MassDeleteAbortError";
  }
}

export class SyncEngine {
  constructor(
    private readonly files: VaultFiles,
    private readonly remote: RemoteStore,
    private readonly indexStore: IndexStore<LocalIndex>,
    private readonly filters: SyncFilterSettings,
    private readonly options: { versionsToKeep: number; massDeleteThreshold: number },
    private readonly callbacks: EngineCallbacks,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private opsDone = 0;
  private opsTotal = 0;

  private progress(message: string): void {
    this.callbacks.onProgress?.({ message, completed: this.opsDone, total: this.opsTotal });
  }

  /** Mark one planned file operation complete and report progress. */
  private step(message: string): void {
    this.opsDone++;
    this.progress(message);
  }

  /** Full reconcile cycle; retries when another device wins the manifest race. */
  async syncOnce(): Promise<SyncSummary> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_MANIFEST_RETRIES; attempt++) {
      try {
        return await this.syncAttempt();
      } catch (err) {
        if (err instanceof ManifestConflictError) {
          lastError = err;
          this.progress("Another device updated the vault; retrying…");
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new Error("Sync failed after retries");
  }

  private async syncAttempt(): Promise<SyncSummary> {
    const summary: SyncSummary = {
      pushed: 0,
      pulled: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: 0,
      merged: 0,
      errors: [],
      conflictCopies: [],
      failedFiles: [],
    };

    this.progress("Scanning vault…");
    const index = (await this.indexStore.load()) ?? emptyIndex();
    const scanned = await this.scanLocal(index);

    this.progress("Loading remote manifest…");
    const { manifest, etag } = await this.remote.loadManifest();

    // Rollback/replay guard: a trusted local checkpoint should never see the
    // remote manifest revision go backwards. A lower revision means either a
    // malicious/replayed manifest or a restored-from-backup bucket; refuse to
    // reconcile against it rather than resurrect deleted notes or revert edits.
    if (manifest.revision < index.manifestRevision) {
      throw new ManifestRollbackError(index.manifestRevision, manifest.revision);
    }

    // Blobs uploaded during THIS attempt. If the attempt throws before the
    // manifest commits, nothing references them, so we delete them to avoid
    // orphaned-blob storage leaks (encrypted mode uses random keys).
    const uploadedThisAttempt: string[] = [];
    try {
      return await this.reconcile(index, scanned, manifest, etag, summary, uploadedThisAttempt);
    } catch (err) {
      if (!(err instanceof ManifestConflictError)) {
        for (const blobKey of uploadedThisAttempt) {
          try {
            await this.remote.deleteBlob(blobKey);
          } catch {
            // Best-effort; a leaked blob is better than masking the real error.
          }
        }
      }
      throw err;
    }
  }

  private async reconcile(
    index: LocalIndex,
    scanned: Map<string, ScannedFile>,
    manifest: RemoteManifest,
    etag: string | null,
    summary: SyncSummary,
    uploadedThisAttempt: string[],
  ): Promise<SyncSummary> {

    // ---- classify -----------------------------------------------------------
    const paths = new Set<string>([
      ...Object.keys(index.files),
      ...scanned.keys(),
      ...Object.keys(manifest.files),
    ]);

    const pulls: Array<{ path: string; entry: ManifestEntry }> = [];
    const pushes: PushItem[] = [];
    const localDeletes: string[] = [];
    const tombstonePushes: string[] = [];
    const conflicts: Array<{ path: string; local: ScannedFile | null; entry: ManifestEntry }> = [];
    const dropFromIndex: string[] = [];

    for (const path of paths) {
      const base = index.files[path] ?? null;
      const local = scanned.get(path) ?? null;
      const entry = manifest.files[path] ?? null;
      const remoteLive = entry && !entry.deletedAt ? entry : null;
      const remoteTombstone = entry && entry.deletedAt ? entry : null;

      // Filter changes must never read as deletions: forget, don't delete.
      if (!isSyncablePath(path, this.filters)) {
        if (base) dropFromIndex.push(path);
        continue;
      }

      if (!base) {
        if (local && !remoteLive) {
          pushes.push({ path, stat: local.stat, hash: local.hash }); // new local file (tombstone resurrect included)
        } else if (local && remoteLive) {
          if (local.hash === remoteLive.hash) {
            // Same content appeared on both sides independently.
            index.files[path] = this.indexEntryFrom(local, remoteLive);
          } else {
            conflicts.push({ path, local, entry: remoteLive });
          }
        } else if (!local && remoteLive) {
          pulls.push({ path, entry: remoteLive });
        }
        continue;
      }

      const localChanged = !local || local.hash !== base.hash;
      const remoteChanged = remoteTombstone !== null || !remoteLive || remoteLive.hash !== base.hash || remoteLive.rev !== base.rev;

      if (!localChanged && !remoteChanged) continue;

      if (localChanged && !remoteChanged) {
        if (local) pushes.push({ path, stat: local.stat, hash: local.hash });
        else tombstonePushes.push(path);
        continue;
      }

      if (!localChanged && remoteChanged) {
        if (remoteLive) pulls.push({ path, entry: remoteLive });
        else {
          localDeletes.push(path); // remote tombstone or entry vanished
        }
        continue;
      }

      // Both sides changed.
      if (local && remoteLive) {
        if (local.hash === remoteLive.hash) {
          index.files[path] = this.indexEntryFrom(local, remoteLive);
        } else {
          conflicts.push({ path, local, entry: remoteLive });
        }
      } else if (local && !remoteLive) {
        // Local edit vs remote delete: the edit wins, resurrect remotely.
        pushes.push({ path, stat: local.stat, hash: local.hash });
      } else if (!local && remoteLive) {
        // Local delete vs remote edit: the edit wins, restore locally.
        pulls.push({ path, entry: remoteLive });
      } else {
        dropFromIndex.push(path); // deleted on both sides
      }
    }

    // ---- mass delete guard --------------------------------------------------
    const tracked = Math.max(Object.keys(index.files).length, 1);
    const totalDeletes = localDeletes.length + tombstonePushes.length;
    if (
      totalDeletes >= MASS_DELETE_MIN_COUNT &&
      totalDeletes / tracked >= this.options.massDeleteThreshold
    ) {
      const ok = await this.callbacks.confirmMassDelete(localDeletes.length, tombstonePushes.length, tracked);
      if (!ok) throw new MassDeleteAbortError();
    }

    // Total planned file operations, for progress reporting. Conflicts that
    // generate an extra push bump opsTotal in resolveConflict.
    this.opsTotal = pulls.length + conflicts.length + pushes.length + tombstonePushes.length + localDeletes.length;
    this.opsDone = 0;
    this.progress(this.opsTotal > 0 ? `Syncing ${this.opsTotal} object(s)` : "Up to date");

    // ---- pulls --------------------------------------------------------------
    for (const { path, entry } of pulls) {
      this.progress(`Downloading ${path}`);
      let body: ArrayBuffer | null;
      try {
        body = await this.remote.downloadBlob(entry.blobKey, entry.hash);
      } catch (err) {
        // Integrity failure: skip this file rather than write corrupt/tampered
        // bytes. The checkpoint is not advanced for it, so a later sync retries.
        const reason = err instanceof Error ? err.message : String(err);
        summary.errors.push(`Integrity check failed for ${path}: ${reason}`);
        summary.failedFiles.push({ path, reason, kind: "integrity" });
        continue;
      }
      if (!body) {
        summary.errors.push(`Remote blob missing for ${path}`);
        summary.failedFiles.push({ path, reason: "Remote blob is missing", kind: "missing" });
        continue;
      }
      await this.files.writeBinary(path, body, entry.mtime);
      index.files[path] = { hash: entry.hash, size: entry.size, mtime: entry.mtime, rev: entry.rev, blobKey: entry.blobKey };
      summary.pulled++;
      this.opsDone++;
    }

    // ---- conflicts ----------------------------------------------------------
    for (const conflict of conflicts) {
      const resolved = await this.resolveConflict(conflict.path, conflict.local, conflict.entry, index, pushes, summary);
      if (!resolved) {
        summary.errors.push(`Could not resolve conflict for ${conflict.path}`);
        summary.failedFiles.push({
          path: conflict.path,
          reason: "Conflict could not be resolved (remote content unavailable)",
          kind: "other",
        });
      }
    }

    // ---- pushes -------------------------------------------------------------
    let manifestDirty = false;
    const blobsToDeleteAfterSave: string[] = [];
    const historyDeleteCandidates = new Set<string>();

    for (const push of pushes) {
      this.progress(`Uploading ${push.path}`);
      const content = await this.files.readBinary(push.path);
      // Contents may have changed since scan; hash what we actually upload.
      const hash = await sha256Hex(content);
      const prev = manifest.files[push.path] ?? null;
      const blobKey = this.remote.newBlobKey(push.path);

      if (prev && !prev.deletedAt && prev.hash !== hash && this.options.versionsToKeep > 0) {
        await this.captureHistory(push.path, prev, historyDeleteCandidates);
      }
      await this.remote.uploadBlob(blobKey, content, hash);
      uploadedThisAttempt.push(blobKey);
      if (prev && prev.blobKey !== blobKey) blobsToDeleteAfterSave.push(prev.blobKey);

      const entry: ManifestEntry = {
        hash,
        size: content.byteLength,
        mtime: push.stat.mtime,
        rev: (prev?.rev ?? 0) + 1,
        blobKey,
        history: prev?.history,
      };
      manifest.files[push.path] = entry;
      index.files[push.path] = { hash, size: content.byteLength, mtime: push.stat.mtime, rev: entry.rev, blobKey };
      manifestDirty = true;
      summary.pushed++;
      this.opsDone++;
    }

    // ---- deletion propagation (local -> remote tombstones) ------------------
    for (const path of tombstonePushes) {
      const prev = manifest.files[path];
      if (!prev || prev.deletedAt) {
        delete index.files[path];
        continue;
      }
      this.progress(`Propagating deletion of ${path}`);
      if (this.options.versionsToKeep > 0) {
        await this.captureHistory(path, prev, historyDeleteCandidates);
      }
      manifest.files[path] = { ...prev, rev: prev.rev + 1, deletedAt: this.now(), blobKey: "" };
      blobsToDeleteAfterSave.push(prev.blobKey);
      delete index.files[path];
      manifestDirty = true;
      summary.deletedRemote++;
      this.opsDone++;
    }

    // ---- apply remote deletions locally ------------------------------------
    // On case-insensitive filesystems (macOS/iOS) a remote delete of "Note.md"
    // and a pull of "note.md" resolve to the same on-disk file. Never delete a
    // path a pull in this same cycle just wrote (compared case-insensitively),
    // or the freshly-synced content would vanish.
    const pulledLower = new Set(pulls.map((p) => p.path.toLowerCase()));
    for (const push of pushes) pulledLower.add(push.path.toLowerCase());
    for (const path of localDeletes) {
      if (pulledLower.has(path.toLowerCase())) {
        delete index.files[path]; // forget the old-case entry; keep the file on disk
        continue;
      }
      this.progress(`Deleting ${path}`);
      if (await this.files.exists(path)) await this.files.delete(path);
      delete index.files[path];
      summary.deletedLocal++;
      this.opsDone++;
    }

    for (const path of dropFromIndex) delete index.files[path];

    // ---- tombstone GC -------------------------------------------------------
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    for (const [path, entry] of Object.entries(manifest.files)) {
      if (entry.deletedAt && entry.deletedAt < cutoff) {
        for (const version of entry.history ?? []) historyDeleteCandidates.add(version.hash);
        delete manifest.files[path];
        manifestDirty = true;
      }
    }

    // Decide history-blob deletions in one pass over the finalized manifest.
    this.resolveHistoryDeletions(manifest, historyDeleteCandidates, blobsToDeleteAfterSave);

    // ---- persist ------------------------------------------------------------
    if (manifestDirty) {
      manifest.revision += 1;
      manifest.updatedAt = this.now();
      this.progress("Saving manifest…");
      await this.remote.saveManifest(manifest, etag); // throws ManifestConflictError on race
      for (const blobKey of blobsToDeleteAfterSave) {
        if (!blobKey) continue;
        try {
          await this.remote.deleteBlob(blobKey);
        } catch {
          summary.errors.push(`Failed to delete stale blob ${blobKey}`);
        }
      }
    }

    index.manifestRevision = manifest.revision;
    await this.indexStore.save(index);
    this.progress("Sync complete");
    return summary;
  }

  // ---------------------------------------------------------------------------

  private indexEntryFrom(local: ScannedFile, entry: ManifestEntry): IndexEntry {
    return { hash: entry.hash, size: entry.size, mtime: local.stat.mtime, rev: entry.rev, blobKey: entry.blobKey };
  }

  /** mtime+size fast path; hash only files that look changed since the last sync. */
  private async scanLocal(index: LocalIndex): Promise<Map<string, ScannedFile>> {
    const out = new Map<string, ScannedFile>();
    for (const stat of await this.files.listFiles()) {
      if (!isSyncablePath(stat.path, this.filters)) continue;
      if (this.filters.maxFileSize > 0 && stat.size > this.filters.maxFileSize) continue;
      const known = index.files[stat.path];
      if (known && known.mtime === stat.mtime && known.size === stat.size) {
        out.set(stat.path, { stat, hash: known.hash });
        continue;
      }
      const content = await this.files.readBinary(stat.path);
      out.set(stat.path, { stat, hash: await sha256Hex(content) });
    }
    return out;
  }

  /**
   * Both sides changed the same path differently. Markdown attempts a 3-way
   * merge using the base version from content-addressed history; anything else
   * keeps both versions via a conflict copy (never silently discards content).
   */
  private async resolveConflict(
    path: string,
    local: ScannedFile | null,
    entry: ManifestEntry,
    index: LocalIndex,
    pushes: PushItem[],
    summary: SyncSummary,
  ): Promise<boolean> {
    summary.conflicts++;
    const localContent = local ? await this.files.readBinary(path) : null;
    let remoteContent: ArrayBuffer | null;
    try {
      remoteContent = await this.remote.downloadBlob(entry.blobKey, entry.hash);
    } catch {
      return false; // integrity failure: leave both sides untouched, retry later
    }
    if (!remoteContent) return false;

    const base = index.files[path] ?? null;
    if (localContent && base && extensionOf(path) === "md") {
      const baseContent = await this.remote.downloadHistoryBlob(base.hash);
      if (baseContent) {
        const decoder = new TextDecoder();
        const result = mergeThreeWay(
          decoder.decode(baseContent),
          decoder.decode(localContent),
          decoder.decode(remoteContent),
        );
        if (result.clean && result.merged !== undefined) {
          const merged = new TextEncoder().encode(result.merged);
          const mergedBuf = merged.buffer.slice(0, merged.byteLength) as ArrayBuffer;
          await this.files.writeBinary(path, mergedBuf);
          const stat = await this.files.stat(path);
          if (stat) {
            pushes.push({ path, stat, hash: await sha256Hex(mergedBuf) });
            this.opsTotal++; // the merged result becomes an extra push
            // Accept the remote entry as the new base so the push computes rev on top of it.
            index.files[path] = { hash: entry.hash, size: entry.size, mtime: 0, rev: entry.rev, blobKey: entry.blobKey };
            summary.merged++;
            this.opsDone++;
            this.progress(`Merged ${path}`);
            return true;
          }
        }
      }
    }

    // Keep both: remote content takes the canonical path, local edit becomes a copy.
    if (localContent) {
      let copyPath = conflictCopyPath(path, new Date(this.now()));
      for (let attempt = 1; (await this.files.exists(copyPath)) && attempt < 100; attempt++) {
        copyPath = conflictCopyPath(path, new Date(this.now()), attempt);
      }
      await this.files.writeBinary(copyPath, localContent);
      const copyStat = await this.files.stat(copyPath);
      if (copyStat) {
        pushes.push({ path: copyPath, stat: copyStat, hash: await sha256Hex(localContent) });
        this.opsTotal++; // the conflict copy becomes an extra push
      }
      summary.conflictCopies.push({ path, conflictCopy: copyPath, at: this.now() });
      this.progress(`Conflict: kept your version as ${copyPath}`);
    }
    await this.files.writeBinary(path, remoteContent, entry.mtime);
    index.files[path] = { hash: entry.hash, size: entry.size, mtime: entry.mtime, rev: entry.rev, blobKey: entry.blobKey };
    this.opsDone++;
    return true;
  }

  /**
   * Snapshot the previous version into content-addressed history and prune to
   * versionsToKeep. Pruned hashes are recorded as deletion *candidates*; whether
   * their blobs can actually be deleted is decided in one final pass over the
   * finalized manifest (see resolveHistoryDeletions) so shared content-addressed
   * blobs are never removed while still referenced. This keeps the whole sync
   * O(N) instead of O(N^2).
   */
  private async captureHistory(
    path: string,
    prev: ManifestEntry,
    historyDeleteCandidates: Set<string>,
  ): Promise<void> {
    try {
      await this.remote.snapshotToHistory(prev.blobKey, prev.hash);
    } catch {
      return; // history is best-effort; sync must not fail because a snapshot did
    }
    const history = [{ hash: prev.hash, size: prev.size, ts: this.now() }, ...(prev.history ?? [])];
    while (history.length > this.options.versionsToKeep) {
      const dropped = history.pop();
      if (dropped) historyDeleteCandidates.add(dropped.hash);
    }
    prev.history = history;
  }

  /**
   * Given the finalized manifest, decide which candidate history hashes are now
   * unreferenced and queue their blobs for deletion. Single O(N) scan.
   */
  private resolveHistoryDeletions(
    manifest: RemoteManifest,
    candidates: Set<string>,
    blobsToDeleteAfterSave: string[],
  ): void {
    if (candidates.size === 0) return;
    const referenced = new Set<string>();
    for (const entry of Object.values(manifest.files)) {
      for (const version of entry.history ?? []) referenced.add(version.hash);
    }
    for (const hash of candidates) {
      if (!referenced.has(hash)) blobsToDeleteAfterSave.push(this.remote.historyBlobKey(hash));
    }
  }

  /** Restore a historical version into the vault; the next sync pushes it as the newest revision. */
  async restoreVersion(path: string, hash: string): Promise<boolean> {
    const content = await this.remote.downloadHistoryBlob(hash);
    if (!content) return false;
    await this.files.writeBinary(path, content);
    return true;
  }

  /** Fetch (decrypt + verify) a historical version's content for preview/diff. */
  async getHistoryContent(hash: string): Promise<ArrayBuffer | null> {
    return this.remote.downloadHistoryBlob(hash);
  }

  /** Fetch (decrypt + verify) the current remote version's content for preview/diff. */
  async getLiveContent(blobKey: string, hash: string): Promise<ArrayBuffer | null> {
    return this.remote.downloadBlob(blobKey, hash);
  }
}
