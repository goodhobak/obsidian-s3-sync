import { Notice, Plugin, TFile, requestUrl } from "obsidian";
import { ObsidianHttpClient } from "./http/client";
import { S3Client } from "./s3/client";
import { MassDeleteAbortError, SyncEngine, type SyncSummary } from "./sync/engine";
import { RemoteStore } from "./sync/remote-store";
import { ObsidianIndexStore, ObsidianVaultFiles } from "./obsidian-adapters";
import { S3SyncSettingTab } from "./settings-tab";
import { MassDeleteConfirmModal, VersionHistoryModal } from "./ui/modals";
import { StatusBarController } from "./ui/status-bar";
import { DEFAULT_SETTINGS, type PluginSettings, type SyncStatus } from "./types";

export default class S3SyncPlugin extends Plugin {
  override settings: PluginSettings = DEFAULT_SETTINGS;
  private status: SyncStatus = { phase: "idle", message: "", lastSyncAt: null, pendingOps: 0 };
  private statusBar: StatusBarController | null = null;
  private indexStore!: ObsidianIndexStore;
  private syncing = false;
  private syncQueued = false;
  private pushDebounceTimer: number | null = null;
  private intervalId: number | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.indexStore = new ObsidianIndexStore(this);

    this.addSettingTab(new S3SyncSettingTab(this.app, this));

    const statusEl = this.addStatusBarItem();
    this.statusBar = new StatusBarController(statusEl, () => void this.syncNow("manual"));

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
      id: "reset-sync-state",
      name: "Reset local sync state",
      callback: () => void this.resetSyncState(),
    });

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
      new ObsidianVaultFiles(this.app),
      remote,
      this.indexStore,
      this.settings.filters,
      { versionsToKeep: this.settings.versionsToKeep, massDeleteThreshold: this.settings.massDeleteThreshold },
      {
        confirmMassDelete: (localDeletes, remoteDeletes, total) =>
          new Promise<boolean>((resolve) => {
            new MassDeleteConfirmModal(this.app, localDeletes, remoteDeletes, total, resolve).open();
          }),
        onProgress: (message) => this.setStatus({ ...this.status, phase: "pushing", message }),
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

  private setStatus(next: SyncStatus): void {
    this.status = next;
    this.statusBar?.render(next);
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
    this.setStatus({ ...this.status, phase: "scanning", message: "Starting sync" });
    try {
      const { engine, remote } = this.buildEngine();
      await remote.initialize();
      const summary = await engine.syncOnce();
      this.setStatus({ phase: "idle", message: this.describe(summary), lastSyncAt: Date.now(), pendingOps: 0 });
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

  // ---- version history ------------------------------------------------------

  private async openVersionHistory(file: TFile): Promise<void> {
    try {
      const { engine, remote } = this.buildEngine();
      await remote.initialize();
      const { manifest } = await remote.loadManifest();
      new VersionHistoryModal(this.app, file.path, manifest.files[file.path] ?? null, {
        restore: async (path, hash) => {
          if (this.syncing) {
            new Notice("S3 Sync: a sync is in progress — try restoring again in a moment");
            return false;
          }
          const ok = await engine.restoreVersion(path, hash);
          if (ok) void this.syncNow("auto");
          return ok;
        },
      }).open();
    } catch (err) {
      new Notice(`S3 Sync: ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }
}
