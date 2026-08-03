import { App, Modal, Notice, Setting } from "obsidian";
import type { DeletedFile } from "../sync/engine";

export interface DeletedFilesActions {
  list(): Promise<DeletedFile[]>;
  /** Bring the newest backup back into the vault (next sync clears the tombstone). */
  restore(path: string): Promise<boolean>;
  /** Permanently delete: drop the entry and free unreferenced blobs. */
  purge(paths: string[]): Promise<number>;
}

/**
 * Lists deleted (tombstoned) files with their retained backups. Each can be
 * restored, or permanently deleted (which is the only way blobs are freed).
 */
export class DeletedFilesModal extends Modal {
  private entries: DeletedFile[] = [];

  constructor(
    app: App,
    private readonly actions: DeletedFilesActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("S3 Sync: deleted files");
    this.modalEl.addClass("s3-sync-wide-modal");
    void this.reload();
  }

  private async reload(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Loading…", cls: "s3-sync-diff-empty" });
    try {
      this.entries = await this.actions.list();
    } catch (err) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: `Could not load: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (this.entries.length === 0) {
      contentEl.createEl("p", { text: "No deleted files. Deleted files are kept here (with backups) until permanently deleted." });
      return;
    }

    contentEl.createEl("p", {
      cls: "s3-sync-version-meta",
      text:
        "Deleted files stay recoverable indefinitely with their backups. " +
        "Restore brings the newest version back; Permanently delete frees its storage and cannot be undone.",
    });

    if (this.entries.length > 1) {
      new Setting(contentEl).addButton((b) =>
        b
          .setButtonText(`Permanently delete all (${this.entries.length})`)
          .setWarning()
          .onClick(() => void this.purge(this.entries.map((e) => e.path))),
      );
    }

    for (const entry of this.entries) this.renderEntry(entry);
  }

  private renderEntry(entry: DeletedFile): void {
    const box = this.contentEl.createDiv({ cls: "s3-sync-resolve-item" });
    box.createDiv({ cls: "s3-sync-resolve-title", text: entry.path });
    box.createDiv({
      cls: "s3-sync-version-meta",
      text: `Deleted ${new Date(entry.deletedAt).toLocaleString()} · ${entry.versions.length} backup(s) retained`,
    });
    const buttons = box.createDiv({ cls: "s3-sync-resolve-buttons" });

    const restore = buttons.createEl("button", { text: "Restore", cls: "mod-cta" });
    restore.addEventListener("click", async () => {
      const ok = await this.actions.restore(entry.path);
      new Notice(ok ? `S3 Sync: restored ${entry.path}` : "S3 Sync: no backup available to restore");
      if (ok) await this.reload();
    });

    const purge = buttons.createEl("button", { text: "Permanently delete" });
    purge.addClass("mod-warning");
    purge.addEventListener("click", () => void this.purge([entry.path]));
  }

  private async purge(paths: string[]): Promise<void> {
    try {
      const n = await this.actions.purge(paths);
      new Notice(`S3 Sync: permanently deleted ${n} file(s)`);
      await this.reload();
    } catch (err) {
      new Notice(`S3 Sync: could not permanently delete — ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
