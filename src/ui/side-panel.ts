import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type S3SyncPlugin from "../main";
import type { SyncLogEntry, SyncStatus } from "../types";

export const S3_SYNC_VIEW_TYPE = "s3-sync-panel";

type TabId = "actions" | "status" | "log";

interface ActionButton {
  label: string;
  icon: string;
  description: string;
  cta?: boolean;
  warning?: boolean;
  run: () => void | Promise<void>;
}

/** Right-sidebar panel: tabbed buttons for every S3 Sync command + live status. */
export class S3SyncView extends ItemView {
  private tab: TabId = "actions";
  private bodyEl!: HTMLElement;
  private statusDisposer: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: S3SyncPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return S3_SYNC_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "S3 Sync";
  }

  override getIcon(): string {
    return "cloud";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("s3-sync-panel");

    const header = root.createDiv({ cls: "s3-sync-panel-header" });
    const title = header.createDiv({ cls: "s3-sync-panel-title" });
    setIcon(title.createSpan({ cls: "s3-sync-panel-title-icon" }), "cloud");
    title.createSpan({ text: "S3 Sync" });
    const settingsBtn = header.createEl("button", { cls: "s3-sync-panel-icon-btn", attr: { "aria-label": "Open settings" } });
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", () => this.plugin.openSettings());

    const tabs = root.createDiv({ cls: "s3-sync-panel-tabs" });
    const tabDefs: Array<{ id: TabId; label: string; icon: string }> = [
      { id: "actions", label: "Actions", icon: "zap" },
      { id: "status", label: "Status", icon: "activity" },
      { id: "log", label: "Log", icon: "scroll-text" },
    ];
    for (const def of tabDefs) {
      const btn = tabs.createEl("button", { cls: "s3-sync-panel-tab" });
      setIcon(btn.createSpan({ cls: "s3-sync-panel-tab-icon" }), def.icon);
      btn.createSpan({ text: def.label });
      btn.toggleClass("is-active", this.tab === def.id);
      btn.addEventListener("click", () => {
        this.tab = def.id;
        for (const el of Array.from(tabs.children)) el.toggleClass("is-active", false);
        btn.toggleClass("is-active", true);
        void this.renderBody();
      });
    }

    this.bodyEl = root.createDiv({ cls: "s3-sync-panel-body" });

    // Keep the Status tab live even when another tab is showing the status bar summary.
    this.statusDisposer = this.plugin.onStatusChange((status) => {
      if (this.tab === "status") this.renderStatusHeadline(status);
    });

    await this.renderBody();
  }

  override async onClose(): Promise<void> {
    this.statusDisposer?.();
    this.statusDisposer = null;
  }

  private async renderBody(): Promise<void> {
    this.bodyEl.empty();
    if (this.tab === "actions") this.renderActions();
    else if (this.tab === "status") await this.renderStatus();
    else await this.renderLog();
  }

  // ---- Actions --------------------------------------------------------------

  private renderActions(): void {
    const configured = this.plugin.isConfigured();
    if (!configured) {
      const warn = this.bodyEl.createDiv({ cls: "s3-sync-panel-warning" });
      setIcon(warn.createSpan(), "alert-triangle");
      warn.createSpan({ text: " Not configured yet — open settings to add your endpoint, bucket and keys." });
    }

    const buttons: ActionButton[] = [
      {
        label: "Sync now",
        icon: "refresh-cw",
        description: "Push local changes and pull remote changes.",
        cta: true,
        run: () => this.plugin.syncNow("manual"),
      },
      {
        label: "Version history",
        icon: "history",
        description: "Versions of the active file — compare and restore.",
        run: () => this.plugin.openVersionHistoryForActiveFile(),
      },
      {
        label: "Resolve conflicts & errors",
        icon: "git-merge",
        description: "Fix conflicts and retry failed files from the last sync.",
        run: () => this.plugin.openResolveLatest(),
      },
      {
        label: "Show sync log",
        icon: "scroll-text",
        description: "History of every sync run.",
        run: () => this.plugin.openSyncLog(),
      },
      {
        label: "Test connection",
        icon: "plug",
        description: "Check the endpoint and credentials.",
        run: () => this.plugin.testConnectionWithNotice(),
      },
      {
        label: "Reset sync state",
        icon: "rotate-ccw",
        description: "Forget the local index (files untouched); next sync re-compares everything.",
        warning: true,
        run: () => this.plugin.resetSyncStateWithNotice(),
      },
      {
        label: "Open settings",
        icon: "settings",
        description: "Connection, encryption, filters, safety and history options.",
        run: () => this.plugin.openSettings(),
      },
    ];

    for (const b of buttons) {
      const row = this.bodyEl.createDiv({ cls: "s3-sync-panel-action" });
      const btn = row.createEl("button", { cls: "s3-sync-panel-action-btn" });
      if (b.cta) btn.addClass("mod-cta");
      if (b.warning) btn.addClass("mod-warning");
      setIcon(btn.createSpan({ cls: "s3-sync-panel-action-icon" }), b.icon);
      btn.createSpan({ text: b.label });
      btn.addEventListener("click", () => void b.run());
      row.createDiv({ cls: "s3-sync-panel-action-desc", text: b.description });
    }
  }

  // ---- Status ---------------------------------------------------------------

  private headlineEl: HTMLElement | null = null;

  private async renderStatus(): Promise<void> {
    this.headlineEl = this.bodyEl.createDiv({ cls: "s3-sync-panel-headline" });
    this.renderStatusHeadline(this.plugin.getStatus());

    const statsBox = this.bodyEl.createDiv({ cls: "s3-sync-stats" });
    statsBox.createDiv({ cls: "s3-sync-diff-empty", text: "Loading statistics…" });

    const refresh = this.bodyEl.createEl("button", { text: "Refresh", cls: "s3-sync-panel-refresh" });
    const load = async (): Promise<void> => {
      const stats = await this.plugin.getSyncStats();
      const mb = (stats.vaultBytes / (1024 * 1024)).toFixed(1);
      const remaining = Math.max(0, stats.vaultObjects - stats.syncedObjects);
      statsBox.empty();
      const rows: Array<[string, string]> = [
        ["Syncable objects in vault", `${stats.vaultObjects} (${mb} MB)`],
        ["Synced (tracked in index)", `${stats.syncedObjects}`],
        ["Not yet synced", `${remaining}`],
      ];
      for (const [label, value] of rows) {
        const row = statsBox.createDiv({ cls: "s3-sync-stats-row" });
        row.createSpan({ cls: "s3-sync-stats-label", text: label });
        row.createSpan({ cls: "s3-sync-stats-value", text: value });
      }
    };
    refresh.addEventListener("click", () => void load());
    await load();
  }

  private renderStatusHeadline(status: SyncStatus): void {
    if (!this.headlineEl) return;
    this.headlineEl.empty();
    const busy = status.phase === "scanning" || status.phase === "pulling" || status.phase === "pushing";
    const icon = busy ? "loader" : status.phase === "error" ? "alert-circle" : "check-circle";
    setIcon(this.headlineEl.createSpan({ cls: "s3-sync-panel-headline-icon" }), icon);
    let text: string;
    if (busy && status.plannedOps > 0) {
      text = `Syncing ${status.completedOps} / ${status.plannedOps} objects`;
    } else if (busy) {
      text = status.message || "Syncing…";
    } else if (status.phase === "error") {
      text = `Error: ${status.message}`;
    } else {
      const when = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "never";
      text = `Idle — last sync: ${when}`;
    }
    this.headlineEl.createSpan({ text });
  }

  // ---- Log ------------------------------------------------------------------

  private async renderLog(): Promise<void> {
    const entries = await this.plugin.getRecentLog();
    if (entries.length === 0) {
      this.bodyEl.createDiv({ cls: "s3-sync-diff-empty", text: "No syncs recorded yet." });
      return;
    }
    const openFull = this.bodyEl.createEl("button", { text: "Open full log", cls: "s3-sync-panel-refresh" });
    openFull.addEventListener("click", () => void this.plugin.openSyncLog());

    for (const entry of entries.slice(0, 15)) this.renderLogEntry(entry);
  }

  private renderLogEntry(entry: SyncLogEntry): void {
    const box = this.bodyEl.createDiv({ cls: "s3-sync-log-entry" });
    const problems = entry.conflictCopies.length + entry.failedFiles.length;
    if (problems > 0) box.addClass("s3-sync-log-problem");
    box.createDiv({ cls: "s3-sync-log-time", text: new Date(entry.at).toLocaleString() });

    const counts: string[] = [];
    if (entry.pushed) counts.push(`↑${entry.pushed}`);
    if (entry.pulled) counts.push(`↓${entry.pulled}`);
    if (entry.deletedLocal || entry.deletedRemote) counts.push(`✕${entry.deletedLocal + entry.deletedRemote}`);
    if (entry.merged) counts.push(`⇄${entry.merged}`);
    if (entry.conflicts) counts.push(`⚠${entry.conflicts}`);
    if (entry.errors.length) counts.push(`✗${entry.errors.length}`);
    box.createDiv({ cls: "s3-sync-log-counts", text: counts.length ? counts.join("  ") : "up to date" });

    if (problems > 0) {
      const btn = box.createEl("button", { text: `Resolve ${problems}`, cls: "mod-cta" });
      btn.addEventListener("click", () => void this.plugin.openResolve(entry.conflictCopies, entry.failedFiles));
    }
  }
}
