import { sha256Hex } from "../s3/sigv4";
import {
  emptyIndex,
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
}

export interface EngineCallbacks {
  /** Return false to abort the sync when a suspiciously large deletion is planned. */
  confirmMassDelete(localDeletes: number, remoteDeletes: number, trackedTotal: number): Promise<boolean>;
  onProgress?(message: string): void;
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

  private progress(message: string): void {
    this.callbacks.onProgress?.(message);
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
    };

    this.progress("Scanning vault…");
    const index = (await this.indexStore.load()) ?? emptyIndex();
    const scanned = await this.scanLocal(index);

    this.progress("Loading remote manifest…");
    const { manifest, etag } = await this.remote.loadManifest();

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

    // ---- pulls --------------------------------------------------------------
    for (const { path, entry } of pulls) {
      this.progress(`Downloading ${path}`);
      const body = await this.remote.downloadBlob(entry.blobKey);
      if (!body) {
        summary.errors.push(`Remote blob missing for ${path}`);
        continue;
      }
      await this.files.writeBinary(path, body, entry.mtime);
      index.files[path] = { hash: entry.hash, size: entry.size, mtime: entry.mtime, rev: entry.rev, blobKey: entry.blobKey };
      summary.pulled++;
    }

    // ---- conflicts ----------------------------------------------------------
    for (const conflict of conflicts) {
      const resolved = await this.resolveConflict(conflict.path, conflict.local, conflict.entry, index, pushes, summary);
      if (!resolved) summary.errors.push(`Could not resolve conflict for ${conflict.path}`);
    }

    // ---- pushes -------------------------------------------------------------
    let manifestDirty = false;
    const blobsToDeleteAfterSave: string[] = [];

    for (const push of pushes) {
      this.progress(`Uploading ${push.path}`);
      const content = await this.files.readBinary(push.path);
      // Contents may have changed since scan; hash what we actually upload.
      const hash = await sha256Hex(content);
      const prev = manifest.files[push.path] ?? null;
      const blobKey = this.remote.newBlobKey(push.path);

      if (prev && !prev.deletedAt && prev.hash !== hash && this.options.versionsToKeep > 0) {
        await this.captureHistory(manifest, push.path, prev, blobsToDeleteAfterSave);
      }
      await this.remote.uploadBlob(blobKey, content);
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
        await this.captureHistory(manifest, path, prev, blobsToDeleteAfterSave);
      }
      manifest.files[path] = { ...prev, rev: prev.rev + 1, deletedAt: this.now(), blobKey: "" };
      blobsToDeleteAfterSave.push(prev.blobKey);
      delete index.files[path];
      manifestDirty = true;
      summary.deletedRemote++;
    }

    // ---- apply remote deletions locally ------------------------------------
    for (const path of localDeletes) {
      this.progress(`Deleting ${path}`);
      if (await this.files.exists(path)) await this.files.delete(path);
      delete index.files[path];
      summary.deletedLocal++;
    }

    for (const path of dropFromIndex) delete index.files[path];

    // ---- tombstone GC -------------------------------------------------------
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    for (const [path, entry] of Object.entries(manifest.files)) {
      if (entry.deletedAt && entry.deletedAt < cutoff) {
        for (const version of entry.history ?? []) {
          if (!this.hashReferencedElsewhere(manifest, path, version.hash)) {
            blobsToDeleteAfterSave.push(this.remote.historyBlobKey(version.hash));
          }
        }
        delete manifest.files[path];
        manifestDirty = true;
      }
    }

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
    const remoteContent = await this.remote.downloadBlob(entry.blobKey);
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
            // Accept the remote entry as the new base so the push computes rev on top of it.
            index.files[path] = { hash: entry.hash, size: entry.size, mtime: 0, rev: entry.rev, blobKey: entry.blobKey };
            summary.merged++;
            this.progress(`Merged ${path}`);
            return true;
          }
        }
      }
    }

    // Keep both: remote content takes the canonical path, local edit becomes a copy.
    if (localContent) {
      const copyPath = conflictCopyPath(path, new Date(this.now()));
      await this.files.writeBinary(copyPath, localContent);
      const copyStat = await this.files.stat(copyPath);
      if (copyStat) pushes.push({ path: copyPath, stat: copyStat, hash: await sha256Hex(localContent) });
      this.progress(`Conflict: kept your version as ${copyPath}`);
    }
    await this.files.writeBinary(path, remoteContent, entry.mtime);
    index.files[path] = { hash: entry.hash, size: entry.size, mtime: entry.mtime, rev: entry.rev, blobKey: entry.blobKey };
    return true;
  }

  private async captureHistory(
    manifest: RemoteManifest,
    path: string,
    prev: ManifestEntry,
    blobsToDeleteAfterSave: string[],
  ): Promise<void> {
    try {
      await this.remote.snapshotToHistory(prev.blobKey, prev.hash);
    } catch {
      return; // history is best-effort; sync must not fail because a snapshot did
    }
    const history = [{ hash: prev.hash, size: prev.size, ts: this.now() }, ...(prev.history ?? [])];
    while (history.length > this.options.versionsToKeep) {
      const dropped = history.pop();
      if (dropped && !this.hashReferencedElsewhere(manifest, path, dropped.hash)) {
        blobsToDeleteAfterSave.push(this.remote.historyBlobKey(dropped.hash));
      }
    }
    prev.history = history;
  }

  /** Content-addressed history blobs may be shared; only unreferenced ones may be deleted. */
  private hashReferencedElsewhere(manifest: RemoteManifest, exceptPath: string, hash: string): boolean {
    for (const [path, entry] of Object.entries(manifest.files)) {
      for (const version of entry.history ?? []) {
        if (version.hash === hash && path !== exceptPath) return true;
      }
    }
    return false;
  }

  /** Restore a historical version into the vault; the next sync pushes it as the newest revision. */
  async restoreVersion(path: string, hash: string): Promise<boolean> {
    const content = await this.remote.downloadHistoryBlob(hash);
    if (!content) return false;
    await this.files.writeBinary(path, content);
    return true;
  }
}
