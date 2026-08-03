import { App, Modal, Notice, Setting } from "obsidian";
import type { HistoryVersion, ManifestEntry } from "../types";

/** Blocking confirmation used by the mass-delete guard. */
export class MassDeleteConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly localDeletes: number,
    private readonly remoteDeletes: number,
    private readonly trackedTotal: number,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("S3 Sync: large deletion detected");
    this.contentEl.createEl("p", {
      text:
        `This sync would delete ${this.localDeletes} file(s) in this vault and ` +
        `${this.remoteDeletes} file(s) remotely, out of ${this.trackedTotal} tracked files.`,
    });
    this.contentEl.createEl("p", {
      text: "This can happen after moving or removing many notes — or when the wrong bucket/prefix is configured.",
    });
    new Setting(this.contentEl)
      .addButton((btn) =>
        btn.setButtonText("Cancel sync").onClick(() => {
          this.finish(false);
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Proceed with deletion")
          .setWarning()
          .onClick(() => {
            this.finish(true);
          }),
      );
  }

  private finish(confirmed: boolean): void {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(confirmed);
    }
    this.close();
  }

  override onClose(): void {
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }
}

export interface VersionHistoryActions {
  restore(path: string, hash: string): Promise<boolean>;
}

/** Lists remote versions of one file and restores a selected one. */
export class VersionHistoryModal extends Modal {
  constructor(
    app: App,
    private readonly path: string,
    private readonly entry: ManifestEntry | null,
    private readonly actions: VersionHistoryActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Version history — ${this.path}`);
    if (!this.entry) {
      this.contentEl.createEl("p", { text: "This file has not been synced yet." });
      return;
    }
    const versions: Array<{ label: string; version: HistoryVersion | null }> = [];
    if (!this.entry.deletedAt) {
      versions.push({ label: "Current remote version", version: null });
    }
    for (const v of this.entry.history ?? []) versions.push({ label: new Date(v.ts).toLocaleString(), version: v });

    if (versions.length === 0) {
      this.contentEl.createEl("p", { text: "No stored versions for this file yet." });
      return;
    }

    for (const { label, version } of versions) {
      const row = this.contentEl.createDiv({ cls: "s3-sync-version-item" });
      const meta = row.createDiv();
      meta.createDiv({ text: label });
      meta.createDiv({
        cls: "s3-sync-version-meta",
        text: version ? `${version.size} bytes` : `${this.entry.size} bytes (hash ${this.entry.hash.slice(0, 8)}…)`,
      });
      if (version) {
        const btn = row.createEl("button", { text: "Restore" });
        btn.addEventListener("click", () => {
          void this.actions.restore(this.path, version.hash).then((ok) => {
            new Notice(ok ? `Restored ${this.path}` : "Version blob is no longer available");
            if (ok) this.close();
          });
        });
      }
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
