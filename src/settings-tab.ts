import { App, Notice, PluginSettingTab, Setting, TFolder, setIcon, setTooltip } from "obsidian";
import type S3SyncPlugin from "./main";
import { toggleFolderExclusion } from "./sync/filters";
import type { SyncStatus } from "./types";

export class S3SyncSettingTab extends PluginSettingTab {
  private statusDisposer: (() => void) | null = null;
  private folderFilter = "";
  /** When on, toggling a folder also toggles every folder beneath it. */
  private includeSubfolders = false;
  /** Staged exclusion set — committed to settings only when Apply is pressed. */
  private pendingExcluded: Set<string> | null = null;
  /** Collapsible exclusion groups — open state survives re-renders of the tab. */
  private exclFoldersOpen = false;
  private exclFilesOpen = false;

  constructor(
    app: App,
    private readonly plugin: S3SyncPlugin,
  ) {
    super(app, plugin);
  }

  override hide(): void {
    this.statusDisposer?.();
    this.statusDisposer = null;
  }

  override display(): void {
    const { containerEl } = this;
    this.statusDisposer?.();
    this.statusDisposer = null;
    containerEl.empty();

    this.renderStatistics(containerEl);
    const s = this.plugin.settings;

    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("Endpoint")
      .setDesc("S3-compatible endpoint URL, e.g. http://localhost:9000 for a local RustFS.")
      .addText((t) =>
        t.setValue(s.connection.endpoint).onChange(async (v) => {
          s.connection.endpoint = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Region")
      .setDesc(
        "Signing region. Cloudflare R2: use auto. AWS S3: your bucket's region (e.g. ap-northeast-2). " +
          "RustFS / MinIO ignore it, so auto works. Leave blank for auto.",
      )
      .addText((t) =>
        t
          .setPlaceholder("auto")
          .setValue(s.connection.region)
          .onChange(async (v) => {
            s.connection.region = v.trim() || "auto";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Bucket").addText((t) =>
      t.setValue(s.connection.bucket).onChange(async (v) => {
        s.connection.bucket = v.trim();
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl)
      .setName("Key prefix")
      .setDesc("Optional folder inside the bucket, e.g. vaults/main. Lets several vaults share one bucket.")
      .addText((t) =>
        t.setValue(s.connection.prefix).onChange(async (v) => {
          s.connection.prefix = v.trim().replace(/^\/+|\/+$/g, "");
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Access key ID").addText((t) =>
      t.setValue(s.connection.accessKeyId).onChange(async (v) => {
        s.connection.accessKeyId = v.trim();
        await this.plugin.saveSettings();
      }),
    );

    new Setting(containerEl).setName("Secret access key").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(s.connection.secretAccessKey).onChange(async (v) => {
        s.connection.secretAccessKey = v.trim();
        await this.plugin.saveSettings();
      });
    });

    new Setting(containerEl)
      .setName("Path-style addressing")
      .setDesc("Required for most self-hosted servers (RustFS, MinIO). Turn off for AWS virtual-hosted style.")
      .addToggle((t) =>
        t.setValue(s.connection.forcePathStyle).onChange(async (v) => {
          s.connection.forcePathStyle = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Test connection").addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        try {
          await this.plugin.testConnection();
          new Notice("S3 Sync: connection OK");
        } catch (err) {
          new Notice(`S3 Sync: connection failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
        }
      }),
    );

    new Setting(containerEl).setName("Encryption").setHeading();

    new Setting(containerEl)
      .setName("End-to-end encryption")
      .setDesc(
        "Encrypt all file contents and metadata client-side (AES-256-GCM). " +
          "Must match the remote vault: decide before the first sync of a vault.",
      )
      .addToggle((t) =>
        t.setValue(s.encryptionEnabled).onChange(async (v) => {
          s.encryptionEnabled = v;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (s.encryptionEnabled) {
      new Setting(containerEl)
        .setName("Passphrase")
        .setDesc("Stored only on this device. Losing it makes the remote vault unrecoverable.")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(s.encryptionPassphrase).onChange(async (v) => {
            s.encryptionPassphrase = v;
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl).setName("What to sync").setHeading();

    new Setting(containerEl)
      .setName("Extensions besides markdown")
      .setDesc("Comma-separated. Markdown always syncs; hidden files never sync.")
      .addTextArea((t) =>
        t.setValue(s.filters.extensions.join(", ")).onChange(async (v) => {
          s.filters.extensions = v
            .split(",")
            .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
            .filter((e) => e.length > 0);
          await this.plugin.saveSettings();
        }),
      );

    this.renderExclusions(containerEl);

    new Setting(containerEl)
      .setName("Maximum file size (MB)")
      .setDesc(
        "Files larger than this are skipped, both when uploading and downloading. 0 = no limit on desktop. " +
          "On phones/tablets the default is 1024 MB (1 GB); edit it to raise or lower the limit, or set 0 " +
          "to fall back to that 1 GB default. Large files still sync on desktop.",
      )
      .addText((t) =>
        t.setValue(String(this.plugin.effectiveFilters().maxFileSize / (1024 * 1024) || 0)).onChange(async (v) => {
          const mb = parseFloat(v);
          s.filters.maxFileSize = Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 0;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("App config (.obsidian)").setHeading();

    const configDesc = document.createDocumentFragment();
    configDesc.append(
      "Sync the .obsidian folder — plugins, themes, snippets and settings — so your setup follows you across devices. ",
    );
    configDesc.createEl("strong", { text: "This plugin's own folder and per-device workspace layout are always excluded" });
    configDesc.append(", so your S3 credentials and passphrase are never uploaded. ");
    configDesc.createEl("strong", { text: "Requires end-to-end encryption" });
    configDesc.append(
      ": because config can include plugin code, it only syncs when encryption is on (so the storage server can't inject code). " +
        "Enable on all devices for two-way config sync.",
    );
    new Setting(containerEl)
      .setName("Sync .obsidian config folder")
      .setDesc(configDesc)
      .addToggle((t) =>
        t.setValue(s.filters.syncObsidianConfig).onChange(async (v) => {
          s.filters.syncObsidianConfig = v;
          await this.plugin.saveSettings();
          void this.refreshStatistics(); // config sync changes the syncable count
        }),
      );

    new Setting(containerEl).setName("When to sync").setHeading();

    new Setting(containerEl)
      .setName("Automatic sync")
      .setDesc("Sync after local changes (debounced) and on a periodic interval.")
      .addToggle((t) =>
        t.setValue(s.autoSync).onChange(async (v) => {
          s.autoSync = v;
          await this.plugin.saveSettings();
          this.plugin.rescheduleAutoSync();
        }),
      );

    new Setting(containerEl)
      .setName("Sync interval (seconds)")
      .addText((t) =>
        t.setValue(String(s.syncIntervalSeconds)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.syncIntervalSeconds = Number.isFinite(n) && n >= 30 ? n : 300;
          await this.plugin.saveSettings();
          this.plugin.rescheduleAutoSync();
        }),
      );

    new Setting(containerEl)
      .setName("Push debounce (seconds)")
      .setDesc("How long to wait after your last edit before uploading.")
      .addText((t) =>
        t.setValue(String(s.pushDebounceSeconds)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.pushDebounceSeconds = Number.isFinite(n) && n >= 1 ? n : 15;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Safety & history").setHeading();

    new Setting(containerEl)
      .setName("Mass-delete confirmation threshold (%)")
      .setDesc("Ask before a single sync deletes more than this share of tracked files.")
      .addText((t) =>
        t.setValue(String(Math.round(s.massDeleteThreshold * 100))).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.massDeleteThreshold = Number.isFinite(n) && n > 0 && n <= 100 ? n / 100 : 0.5;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Backups to keep per file")
      .setDesc(
        "Old versions stay restorable from the version history. Deleted files keep this many backups " +
          "and are retained until permanently deleted (see the Deleted files view). 0 disables backups.",
      )
      .addText((t) =>
        t.setValue(String(s.versionsToKeep)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.versionsToKeep = Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 5;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Reset local sync state")
      .setDesc(
        "Forget what was synced (files are untouched). The next sync re-compares everything against the remote vault.",
      )
      .addButton((b) =>
        b
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetSyncState();
            new Notice("S3 Sync: local sync state was reset");
            void this.refreshStatistics();
          }),
      );

    this.renderDeveloper(containerEl);
  }

  // ---- developer mode -------------------------------------------------------

  private renderDeveloper(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Developer").setHeading();

    new Setting(containerEl)
      .setName("Developer mode (diagnostic log)")
      .setDesc(
        "Write a detailed log of each sync (plan, per-checkpoint progress, memory, large files, errors) " +
          "to a file in the plugin folder. Turn this on, reproduce the problem, then copy the log to share it.",
      )
      .addToggle((t) =>
        t.setValue(s.developerMode).onChange(async (v) => {
          s.developerMode = v;
          await this.plugin.saveSettings();
          this.plugin.devLog("info", "Developer mode enabled", { by: "settings" });
          this.display();
        }),
      );

    if (!s.developerMode) return;

    const logDesc = document.createDocumentFragment();
    logDesc.append(this.plugin.fileLogger.displayPath() + " — ");
    logDesc.createEl("strong", { text: "the log includes your file/folder names" });
    logDesc.append(" (but never credentials or the passphrase); review before sharing publicly.");
    new Setting(containerEl)
      .setName("Log file location")
      .setDesc(logDesc)
      .addButton((b) =>
        b.setButtonText("Copy log to clipboard").onClick(async () => {
          const text = await this.plugin.fileLogger.read();
          if (!text) {
            new Notice("S3 Sync: log is empty — run a sync first");
            return;
          }
          await navigator.clipboard.writeText(text);
          new Notice(`S3 Sync: copied ${text.length} chars — paste it to share`);
        }),
      )
      .addButton((b) =>
        b.setButtonText("Copy path").onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.fileLogger.displayPath());
          new Notice("S3 Sync: log path copied");
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Clear log")
          .setWarning()
          .onClick(async () => {
            await this.plugin.fileLogger.clear();
            new Notice("S3 Sync: log cleared");
          }),
      );
  }

  // ---- statistics -----------------------------------------------------------

  private statsValueEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;

  private renderStatistics(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Status & statistics").setHeading();

    const box = containerEl.createDiv({ cls: "s3-sync-stats" });
    this.progressEl = box.createDiv({ cls: "s3-sync-stats-progress" });
    this.statsValueEl = box.createDiv({ cls: "s3-sync-stats-values" });

    new Setting(containerEl)
      .setName("Refresh statistics")
      .setDesc("Recount syncable objects in the vault and how many are already synced.")
      .addButton((b) => b.setButtonText("Refresh").onClick(() => void this.refreshStatistics()));

    // Live progress: update on every sync-status change while this tab is open.
    this.statusDisposer = this.plugin.onStatusChange((status) => this.renderProgress(status));
    void this.refreshStatistics();
  }

  private renderProgress(status: SyncStatus): void {
    if (!this.progressEl) return;
    const busy = status.phase === "scanning" || status.phase === "pulling" || status.phase === "pushing";
    if (busy && status.plannedOps > 0) {
      const pct = Math.round((status.completedOps / status.plannedOps) * 100);
      this.progressEl.setText(`Syncing… ${status.completedOps} / ${status.plannedOps} objects (${pct}%)`);
    } else if (busy) {
      this.progressEl.setText(`Syncing… ${status.message}`);
    } else if (status.phase === "error") {
      this.progressEl.setText(`Last sync failed: ${status.message}`);
    } else {
      const when = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "never";
      this.progressEl.setText(`Idle — last sync: ${when}${status.message ? ` (${status.message})` : ""}`);
    }
  }

  private async refreshStatistics(): Promise<void> {
    if (!this.statsValueEl) return;
    const stats = await this.plugin.getSyncStats();
    const mb = (stats.vaultBytes / (1024 * 1024)).toFixed(1);
    const remaining = Math.max(0, stats.vaultObjects - stats.syncedObjects);
    this.statsValueEl.empty();
    const rows: Array<[string, string]> = [
      ["Syncable objects in vault", `${stats.vaultObjects} (${mb} MB)`],
      ["Synced (tracked in index)", `${stats.syncedObjects}`],
      ["Not yet synced", `${remaining}`],
    ];
    for (const [label, value] of rows) {
      const row = this.statsValueEl.createDiv({ cls: "s3-sync-stats-row" });
      row.createSpan({ cls: "s3-sync-stats-label", text: label });
      row.createSpan({ cls: "s3-sync-stats-value", text: value });
    }
    this.renderProgress(this.plugin.getStatus());
  }

  // ---- exclusions (grouped: folders + per-device files) ---------------------

  private renderExclusions(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Exclusions")
      .setDesc(
        "Skip folders or individual files. Lists live on this device only — " +
          "other devices keep syncing everything (useful to skip one huge file on a phone).",
      );

    const folders = this.exclusionGroup(containerEl, "Excluded folders", this.exclFoldersOpen, (open) => {
      this.exclFoldersOpen = open;
    });
    this.renderExcludedFolders(folders.body, folders.count);

    const files = this.exclusionGroup(containerEl, "Excluded files", this.exclFilesOpen, (open) => {
      this.exclFilesOpen = open;
    });
    this.renderExcludedFiles(files.body, files.count);
  }

  private exclusionGroup(
    containerEl: HTMLElement,
    name: string,
    open: boolean,
    onToggle: (open: boolean) => void,
  ): { body: HTMLElement; count: HTMLElement } {
    const details = containerEl.createEl("details", { cls: "s3-sync-excl-group" });
    details.open = open;
    details.addEventListener("toggle", () => onToggle(details.open));
    const summary = details.createEl("summary", { cls: "s3-sync-excl-summary" });
    summary.createSpan({ text: name });
    const count = summary.createSpan({ cls: "s3-sync-folder-count" });
    const body = details.createDiv({ cls: "s3-sync-excl-body" });
    return { body, count };
  }

  // ---- excluded files (per-device list, populated from the Overview tab) ----

  private renderExcludedFiles(host: HTMLElement, countEl: HTMLElement): void {
    host.createDiv({
      cls: "setting-item-description",
      text:
        "Files skipped on this device. Add files from the S3 Sync panel → Overview tab " +
        "(the ⊘ button on a row); remove one here to sync it again.",
    });
    const list = host.createDiv({ cls: "s3-sync-folder-list s3-sync-file-list" });

    const render = (): void => {
      list.empty();
      const files = this.plugin.settings.filters.excludedFiles;
      countEl.setText(` — ${files.length}`);
      if (files.length === 0) {
        list.createDiv({
          cls: "s3-sync-folder-empty",
          text: "No files excluded on this device.",
        });
        return;
      }
      for (const path of files) {
        const row = list.createDiv({ cls: "s3-sync-folder-row" });
        row.createSpan({ cls: "s3-sync-file-path", text: path });
        const remove = row.createEl("button", {
          cls: "s3-sync-file-remove",
          attr: { "aria-label": "Include in sync again" },
        });
        setIcon(remove, "x");
        setTooltip(remove, "Include this file in sync again");
        remove.addEventListener("click", () => {
          void (async () => {
            await this.plugin.setFileExcluded(path, false);
            render();
            await this.refreshStatistics(); // exclusions change the syncable count
          })();
        });
      }
    };
    render();
  }

  // ---- excluded folders (searchable checkbox list) --------------------------

  private allFolders(): string[] {
    const out: string[] = [];
    for (const file of this.app.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFolder) || file.isRoot()) continue;
      const path = file.path;
      if (path.split("/").some((seg) => seg.startsWith("."))) continue; // hidden folders never sync
      out.push(path);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  private savedExclusionSet(): Set<string> {
    return new Set(this.plugin.settings.filters.excludedFolders.map((f) => f.replace(/^\/+|\/+$/g, "")));
  }

  private renderExcludedFolders(containerEl: HTMLElement, countEl: HTMLElement): void {
    // Start staging from the currently-saved exclusions.
    this.pendingExcluded = this.savedExclusionSet();

    containerEl.createDiv({
      cls: "setting-item-description",
      text: "Check folders to skip, then press Apply. Use the search box to narrow a large vault.",
    });

    new Setting(containerEl)
      .setName("Include subfolders")
      .setDesc("When on, checking a folder also checks every folder beneath it.")
      .addToggle((t) =>
        t.setValue(this.includeSubfolders).onChange((v) => {
          this.includeSubfolders = v;
        }),
      );

    const search = new Setting(containerEl).setName("Filter folders").addText((t) =>
      t.setPlaceholder("Type to filter…").setValue(this.folderFilter).onChange((v) => {
        this.folderFilter = v;
        renderList();
      }),
    );
    search.settingEl.addClass("s3-sync-folder-search");

    const list = containerEl.createDiv({ cls: "s3-sync-folder-list" });
    const MAX_ROWS = 60;

    const applyRow = new Setting(containerEl);
    let applyBtnRef: import("obsidian").ButtonComponent | null = null;
    applyRow
      .addButton((b) => {
        applyBtnRef = b;
        b.setButtonText("Apply")
          .setCta()
          .onClick(async () => {
            const pending = this.pendingExcluded ?? new Set<string>();
            this.plugin.settings.filters.excludedFolders = [...pending].sort();
            await this.plugin.saveSettings();
            await this.refreshStatistics(); // excluded folders change the syncable count
            updateCount();
          });
      })
      .addExtraButton((b) =>
        b
          .setIcon("rotate-ccw")
          .setTooltip("Revert unsaved changes")
          .onClick(() => {
            this.pendingExcluded = this.savedExclusionSet();
            renderList();
          }),
      );

    const updateCount = (): void => {
      const pending = this.pendingExcluded ?? new Set<string>();
      const saved = this.savedExclusionSet();
      const dirty = pending.size !== saved.size || [...pending].some((p) => !saved.has(p));
      countEl.setText(` — ${saved.size} applied${dirty ? `, ${pending.size} staged` : ""}`);
      applyBtnRef?.setDisabled(!dirty);
      applyRow.setDesc(dirty ? "You have unsaved changes." : "No unsaved changes.");
    };

    const renderList = (): void => {
      list.empty();
      const pending = this.pendingExcluded ?? new Set<string>();
      const filter = this.folderFilter.trim().toLowerCase();
      const folders = this.allFolders();

      if (folders.length === 0) {
        list.createDiv({ cls: "s3-sync-folder-empty", text: "No folders in this vault." });
        updateCount();
        return;
      }

      // Staged-excluded folders always appear (so they can be unchecked), then
      // the search matches, capped for large vaults.
      const excludedFirst = folders.filter((f) => pending.has(f));
      const matches = folders.filter((f) => !pending.has(f) && (filter === "" || f.toLowerCase().includes(filter)));
      const shown = [...excludedFirst, ...matches.slice(0, MAX_ROWS)];

      for (const path of shown) {
        const row = list.createDiv({ cls: "s3-sync-folder-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = pending.has(path);
        row.createSpan({ text: path });
        cb.addEventListener("change", () => {
          this.pendingExcluded = toggleFolderExclusion(
            this.pendingExcluded ?? new Set<string>(),
            path,
            cb.checked,
            this.includeSubfolders,
            folders,
          );
          // Re-render so subtree checkboxes reflect the change immediately.
          renderList();
        });
      }

      const hiddenCount = matches.length - Math.min(matches.length, MAX_ROWS);
      if (hiddenCount > 0) {
        list.createDiv({
          cls: "s3-sync-folder-empty",
          text: `…and ${hiddenCount} more. Refine the filter to see them.`,
        });
      }
      updateCount();
    };

    renderList();
  }
}
