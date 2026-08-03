import { App, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import type S3SyncPlugin from "./main";
import type { SyncStatus } from "./types";

export class S3SyncSettingTab extends PluginSettingTab {
  private statusDisposer: (() => void) | null = null;
  private folderFilter = "";

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

    new Setting(containerEl).setName("Region").addText((t) =>
      t.setValue(s.connection.region).onChange(async (v) => {
        s.connection.region = v.trim() || "us-east-1";
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

    this.renderExcludedFolders(containerEl);

    new Setting(containerEl)
      .setName("Maximum file size (MB)")
      .setDesc("Files larger than this are skipped. 0 = no limit.")
      .addText((t) =>
        t.setValue(String(s.filters.maxFileSize / (1024 * 1024) || 0)).onChange(async (v) => {
          const mb = parseFloat(v);
          s.filters.maxFileSize = Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 0;
          await this.plugin.saveSettings();
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
      .setName("Versions to keep per file")
      .setDesc("Old versions stay restorable from the version history. 0 disables history.")
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

  private renderExcludedFolders(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Check folders to skip. Use the search box to narrow a large vault.");

    const search = new Setting(containerEl).setName("Filter folders").addText((t) =>
      t.setPlaceholder("Type to filter…").setValue(this.folderFilter).onChange((v) => {
        this.folderFilter = v;
        renderList();
      }),
    );
    search.settingEl.addClass("s3-sync-folder-search");

    const list = containerEl.createDiv({ cls: "s3-sync-folder-list" });
    const MAX_ROWS = 60;

    const renderList = (): void => {
      list.empty();
      const excluded = new Set(s.filters.excludedFolders.map((f) => f.replace(/^\/+|\/+$/g, "")));
      const filter = this.folderFilter.trim().toLowerCase();
      const folders = this.allFolders();

      // Currently-excluded folders always appear (so they can be unchecked),
      // then the search matches, capped for large vaults.
      const excludedFirst = folders.filter((f) => excluded.has(f));
      const matches = folders.filter(
        (f) => !excluded.has(f) && (filter === "" || f.toLowerCase().includes(filter)),
      );
      const shown = [...excludedFirst, ...matches.slice(0, MAX_ROWS)];

      if (folders.length === 0) {
        list.createDiv({ cls: "s3-sync-folder-empty", text: "No folders in this vault." });
        return;
      }

      for (const path of shown) {
        const row = list.createDiv({ cls: "s3-sync-folder-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = excluded.has(path);
        row.createSpan({ text: path });
        cb.addEventListener("change", async () => {
          const set = new Set(s.filters.excludedFolders.map((f) => f.replace(/^\/+|\/+$/g, "")));
          if (cb.checked) set.add(path);
          else set.delete(path);
          s.filters.excludedFolders = [...set].sort();
          await this.plugin.saveSettings();
          void this.refreshStatistics(); // excluded folders change the syncable count
        });
      }

      const hiddenCount = matches.length - Math.min(matches.length, MAX_ROWS);
      if (hiddenCount > 0) {
        list.createDiv({
          cls: "s3-sync-folder-empty",
          text: `…and ${hiddenCount} more. Refine the filter to see them.`,
        });
      }
    };

    renderList();
  }
}
