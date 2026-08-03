import { Notice, Plugin, TFile, requestUrl } from "obsidian";
import { ObsidianHttpClient } from "./http/client";
import { S3Client } from "./s3/client";
import { MassDeleteAbortError, SyncEngine, type SyncSummary } from "./sync/engine";
import { RemoteStore } from "./sync/remote-store";
import { ObsidianIndexStore, ObsidianVaultFiles, SyncLogStore } from "./obsidian-adapters";
import { S3SyncSettingTab } from "./settings-tab";
import { MassDeleteConfirmModal, VersionHistoryModal } from "./ui/modals";
import { ResolveModal } from "./ui/resolve-modal";
import { SyncLogModal } from "./ui/sync-log-modal";
import { DeletedFilesModal } from "./ui/deleted-files-modal";
import { S3SyncView, S3_SYNC_VIEW_TYPE } from "./ui/side-panel";
import { StatusBarController } from "./ui/status-bar";
import { isSyncablePath } from "./sync/filters";
import {
  DEFAULT_SETTINGS,
  type ConflictCopyRecord,
  type FailedFileRecord,
  type PluginSettings,
  type SyncLogEntry,
  type SyncStats,
  type SyncStatus,
} from "./types";

const IDLE_STATUS: SyncStatus = {
  phase: "idle",
  message: "",
  lastSyncAt: null,
  pendingOps: 0,
  completedOps: 0,
  plannedOps: 0,
  inbound: 0,
  outbound: 0,
};

export default class S3SyncPlugin extends Plugin {
  override settings: PluginSettings = DEFAULT_SETTINGS;
  private status: SyncStatus = { ...IDLE_STATUS };
  private statusBar: StatusBarController | null = null;
  private indexStore!: ObsidianIndexStore;
  private logStore!: SyncLogStore;
  /** Conflicts/errors from the most recent sync, for the Resolve command. */
  private lastConflicts: ConflictCopyRecord[] = [];
  private lastFailures: FailedFileRecord[] = [];
  private syncing = false;
  private syncQueued = false;
  private pushDebounceTimer: number | null = null;
  private intervalId: number | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.indexStore = new ObsidianIndexStore(this);
    this.logStore = new SyncLogStore(this);

    this.addSettingTab(new S3SyncSettingTab(this.app, this));

    this.registerView(S3_SYNC_VIEW_TYPE, (leaf) => new S3SyncView(leaf, this));
    this.addRibbonIcon("cloud", "Open S3 Sync panel", () => void this.activateView());

    const statusEl = this.addStatusBarItem();
    this.statusBar = new StatusBarController(statusEl, () => void this.syncNow("manual"));

    this.addCommand({
      id: "open-panel",
      name: "Open S3 Sync panel",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow("manual"),
    });

    this.addCommand({
      id: "version-history",
      name: "View version history for current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) void this.openVersionHistory(file);
        return true;
      },
    });

    this.addCommand({
      id: "show-sync-log",
      name: "Show sync log",
      callback: () => void this.openSyncLog(),
    });

    this.addCommand({
      id: "resolve-issues",
      name: "Resolve conflicts and errors",
      callback: () => void this.openResolve(this.lastConflicts, this.lastFailures),
    });

    this.addCommand({
      id: "deleted-files",
      name: "Deleted files (restore or permanently delete)",
      callback: () => void this.openDeletedFiles(),
    });

    this.addCommand({
      id: "reset-sync-state",
      name: "Reset local sync state",
      callback: () => void this.resetSyncState(),
    });

    // Right-click a file → version history.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        menu.addItem((item) =>
          item
            .setTitle("S3 Sync: version history")
            .setIcon("history")
            .onClick(() => void this.openVersionHistory(file)),
        );
      }),
    );

    // Vault change listeners drive the debounced auto-push.
    this.registerEvent(this.app.vault.on("create", () => this.noteLocalChange()));
    this.registerEvent(this.app.vault.on("modify", () => this.noteLocalChange()));
    this.registerEvent(this.app.vault.on("delete", () => this.noteLocalChange()));
    this.registerEvent(this.app.vault.on("rename", () => this.noteLocalChange()));

    this.app.workspace.onLayoutReady(() => {
      this.rescheduleAutoSync();
      if (this.settings.autoSync && this.isConfigured()) void this.syncNow("startup");
    });
  }

  override onunload(): void {
    if (this.pushDebounceTimer !== null) window.clearTimeout(this.pushDebounceTimer);
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      connection: { ...DEFAULT_SETTINGS.connection, ...stored?.connection },
      filters: { ...DEFAULT_SETTINGS.filters, ...stored?.filters },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  isConfigured(): boolean {
    const c = this.settings.connection;
    return Boolean(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
  }

  // ---- wiring ---------------------------------------------------------------

  private buildS3(): S3Client {
    return new S3Client(new ObsidianHttpClient(requestUrl), this.settings.connection);
  }

  private buildEngine(): { engine: SyncEngine; remote: RemoteStore } {
    const remote = new RemoteStore(this.buildS3(), this.settings);
    const engine = new SyncEngine(
      new ObsidianVaultFiles(this.app, () => this.settings.filters.syncObsidianConfig),
      remote,
      this.indexStore,
      this.settings.filters,
      { versionsToKeep: this.settings.versionsToKeep, massDeleteThreshold: this.settings.massDeleteThreshold },
      {
        confirmMassDelete: (localDeletes, remoteDeletes, total) =>
          new Promise<boolean>((resolve) => {
            new MassDeleteConfirmModal(this.app, localDeletes, remoteDeletes, total, resolve).open();
          }),
        onProgress: (p) =>
          this.setStatus({
            ...this.status,
            phase: p.inbound > p.outbound ? "pulling" : "pushing",
            message: p.message,
            completedOps: p.completed,
            plannedOps: p.total,
            inbound: p.inbound,
            outbound: p.outbound,
          }),
      },
    );
    return { engine, remote };
  }

  async testConnection(): Promise<void> {
    await this.buildS3().testConnection();
  }

  async resetSyncState(): Promise<void> {
    await this.indexStore.reset();
  }

  // ---- scheduling -----------------------------------------------------------

  private noteLocalChange(): void {
    if (!this.settings.autoSync || !this.isConfigured()) return;
    if (this.pushDebounceTimer !== null) window.clearTimeout(this.pushDebounceTimer);
    this.pushDebounceTimer = window.setTimeout(() => {
      this.pushDebounceTimer = null;
      void this.syncNow("auto");
    }, this.settings.pushDebounceSeconds * 1000);
  }

  rescheduleAutoSync(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.settings.autoSync) {
      this.intervalId = window.setInterval(() => {
        if (this.isConfigured()) void this.syncNow("interval");
      }, Math.max(30, this.settings.syncIntervalSeconds) * 1000);
      this.registerInterval(this.intervalId);
    }
  }

  // ---- sync -----------------------------------------------------------------

  private readonly statusListeners = new Set<(status: SyncStatus) => void>();

  /** Subscribe to live sync-status updates (used by the settings panel). Returns a disposer. */
  onStatusChange(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  private setStatus(next: SyncStatus): void {
    this.status = next;
    this.statusBar?.render(next);
    for (const listener of this.statusListeners) listener(next);
  }

  /**
   * Count of syncable files currently in the vault (filters applied) and how
   * many are already tracked in the local sync index.
   */
  async getSyncStats(): Promise<SyncStats> {
    let vaultObjects = 0;
    let vaultBytes = 0;
    for (const file of this.app.vault.getFiles()) {
      if (!isSyncablePath(file.path, this.settings.filters)) continue;
      if (this.settings.filters.maxFileSize > 0 && file.stat.size > this.settings.filters.maxFileSize) continue;
      vaultObjects++;
      vaultBytes += file.stat.size;
    }
    const index = await this.indexStore.load();
    const syncedObjects = index ? Object.keys(index.files).length : 0;
    return {
      vaultObjects,
      vaultBytes,
      syncedObjects,
      lastSyncAt: this.status.lastSyncAt,
      lastSummary: this.status.message,
    };
  }

  async syncNow(trigger: "manual" | "auto" | "interval" | "startup"): Promise<void> {
    if (!this.isConfigured()) {
      if (trigger === "manual") new Notice("S3 Sync: configure endpoint, bucket and credentials first");
      return;
    }
    if (this.syncing) {
      this.syncQueued = true;
      return;
    }
    this.syncing = true;
    this.setStatus({
      ...this.status,
      phase: "scanning",
      message: "Starting sync",
      completedOps: 0,
      plannedOps: 0,
      inbound: 0,
      outbound: 0,
    });
    try {
      const { engine, remote } = this.buildEngine();
      await remote.initialize();
      const summary = await engine.syncOnce();
      this.setStatus({
        ...IDLE_STATUS,
        message: this.describe(summary),
        lastSyncAt: Date.now(),
      });
      await this.recordSync(trigger, summary);
      if (trigger === "manual") new Notice(`S3 Sync: ${this.describe(summary)}`);
      if (summary.errors.length > 0) {
        console.warn("[s3-sync] completed with errors", summary.errors);
      }
    } catch (err) {
      if (err instanceof MassDeleteAbortError) {
        this.setStatus({ ...this.status, phase: "idle", message: err.message });
        new Notice("S3 Sync: sync cancelled — nothing was deleted");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[s3-sync] sync failed", err);
        this.setStatus({ ...this.status, phase: "error", message });
        if (trigger === "manual") new Notice(`S3 Sync failed: ${message}`, 8000);
      }
    } finally {
      this.syncing = false;
      if (this.syncQueued) {
        this.syncQueued = false;
        void this.syncNow("auto");
      }
    }
  }

  private describe(summary: SyncSummary): string {
    const parts: string[] = [];
    if (summary.pushed) parts.push(`↑${summary.pushed}`);
    if (summary.pulled) parts.push(`↓${summary.pulled}`);
    if (summary.deletedLocal || summary.deletedRemote) parts.push(`✕${summary.deletedLocal + summary.deletedRemote}`);
    if (summary.merged) parts.push(`⇄${summary.merged} merged`);
    if (summary.conflicts) parts.push(`⚠${summary.conflicts} conflicts`);
    if (summary.errors.length) parts.push(`${summary.errors.length} errors`);
    return parts.length ? parts.join(" ") : "up to date";
  }

  // ---- sync log -------------------------------------------------------------

  /** Append the run to the log and remember its unresolved conflicts/errors. */
  private async recordSync(trigger: string, summary: SyncSummary): Promise<void> {
    this.lastConflicts = summary.conflictCopies;
    this.lastFailures = summary.failedFiles;
    const entry: SyncLogEntry = {
      at: Date.now(),
      trigger,
      pushed: summary.pushed,
      pulled: summary.pulled,
      deletedLocal: summary.deletedLocal,
      deletedRemote: summary.deletedRemote,
      conflicts: summary.conflicts,
      merged: summary.merged,
      errors: summary.errors,
      conflictCopies: summary.conflictCopies,
      failedFiles: summary.failedFiles,
    };
    try {
      await this.logStore.append(entry);
    } catch (err) {
      console.warn("[s3-sync] could not write sync log", err);
    }

    const problems = summary.conflictCopies.length + summary.failedFiles.length;
    if (problems > 0) {
      const notice = new Notice("", 10000);
      notice.noticeEl.setText(`S3 Sync: ${problems} item(s) need attention. `);
      const link = notice.noticeEl.createEl("a", { text: "Resolve", cls: "s3-sync-notice-link" });
      link.addEventListener("click", () => {
        notice.hide();
        void this.openResolve(summary.conflictCopies, summary.failedFiles);
      });
    }
  }

  async openSyncLog(): Promise<void> {
    const entries = await this.logStore.load();
    new SyncLogModal(this.app, entries, {
      resolveEntry: (entry) => void this.openResolve(entry.conflictCopies, entry.failedFiles),
      clearLog: () => this.logStore.clear(),
    }).open();
  }

  // ---- deleted files (restore / permanently delete) -------------------------

  async openDeletedFiles(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("S3 Sync: configure endpoint, bucket and credentials first");
      return;
    }
    const { engine, remote } = this.buildEngine();
    try {
      await remote.initialize();
    } catch (err) {
      new Notice(`S3 Sync: ${err instanceof Error ? err.message : String(err)}`, 8000);
      return;
    }
    new DeletedFilesModal(this.app, {
      list: () => engine.listDeleted(),
      restore: async (path) => {
        if (this.syncing) {
          new Notice("S3 Sync: a sync is in progress — try again in a moment");
          return false;
        }
        const ok = await engine.restoreDeleted(path);
        if (ok) void this.syncNow("auto");
        return ok;
      },
      purge: (paths) => engine.purgeDeleted(paths),
    }).open();
  }

  // ---- resolve conflicts & errors -------------------------------------------

  async openResolve(conflicts: ConflictCopyRecord[], failures: FailedFileRecord[]): Promise<void> {
    if (conflicts.length === 0 && failures.length === 0) {
      new Notice("S3 Sync: nothing to resolve");
      return;
    }
    const files = new ObsidianVaultFiles(this.app, () => this.settings.filters.syncObsidianConfig);
    const decoder = new TextDecoder();
    new ResolveModal(this.app, conflicts, failures, {
      readTextFile: async (path) => {
        try {
          return decoder.decode(await files.readBinary(path));
        } catch {
          return null;
        }
      },
      keepCurrent: async (copyPath) => {
        await files.delete(copyPath);
        this.forgetConflict(copyPath);
        void this.syncNow("auto");
      },
      useCopy: async (canonicalPath, copyPath) => {
        const content = await files.readBinary(copyPath);
        await files.writeBinary(canonicalPath, content);
        await files.delete(copyPath);
        this.forgetConflict(copyPath);
        void this.syncNow("auto");
      },
      openBoth: (canonicalPath, copyPath) => {
        void this.app.workspace.openLinkText(canonicalPath, "", false);
        void this.app.workspace.openLinkText(copyPath, "", true);
      },
      retrySync: async () => {
        await this.syncNow("manual");
      },
    }).open();
  }

  private forgetConflict(copyPath: string): void {
    this.lastConflicts = this.lastConflicts.filter((c) => c.conflictCopy !== copyPath);
  }

  // ---- version history ------------------------------------------------------

  private async openVersionHistory(file: TFile): Promise<void> {
    try {
      const { engine, remote } = this.buildEngine();
      await remote.initialize();
      const { manifest } = await remote.loadManifest();
      const entry = manifest.files[file.path] ?? null;
      new VersionHistoryModal(this.app, file.path, entry, {
        restore: async (path, hash) => {
          if (this.syncing) {
            new Notice("S3 Sync: a sync is in progress — try restoring again in a moment");
            return false;
          }
          const ok = await engine.restoreVersion(path, hash);
          if (ok) void this.syncNow("auto");
          return ok;
        },
        getVersionContent: (hash) =>
          entry && hash === entry.hash && !entry.deletedAt
            ? engine.getLiveContent(entry.blobKey, entry.hash)
            : engine.getHistoryContent(hash),
        getCurrentContent: async (path) => {
          const af = this.app.vault.getAbstractFileByPath(path);
          return af instanceof TFile ? this.app.vault.read(af) : null;
        },
      }).open();
    } catch (err) {
      new Notice(`S3 Sync: ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  // ---- side panel + convenience wrappers ------------------------------------

  /** Reveal (or create) the S3 Sync panel in the right sidebar. */
  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(S3_SYNC_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: S3_SYNC_VIEW_TYPE, active: true });
    }
    if (leaf) void workspace.revealLeaf(leaf);
  }

  /** Open Obsidian settings directly on this plugin's tab. */
  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  openVersionHistoryForActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("S3 Sync: open a file first to see its version history");
      return;
    }
    void this.openVersionHistory(file);
  }

  openResolveLatest(): void {
    void this.openResolve(this.lastConflicts, this.lastFailures);
  }

  getRecentLog(): Promise<SyncLogEntry[]> {
    return this.logStore.load();
  }

  async testConnectionWithNotice(): Promise<void> {
    try {
      await this.testConnection();
      new Notice("S3 Sync: connection OK");
    } catch (err) {
      new Notice(`S3 Sync: connection failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  async resetSyncStateWithNotice(): Promise<void> {
    await this.resetSyncState();
    new Notice("S3 Sync: local sync state was reset");
  }
}
