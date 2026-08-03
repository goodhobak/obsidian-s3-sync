import { App, Modal } from "obsidian";
import type { SyncLogEntry } from "../types";

export interface SyncLogActions {
  /** Open the resolve modal for a specific log entry's conflicts/errors. */
  resolveEntry(entry: SyncLogEntry): void;
  clearLog(): Promise<void>;
}

/** Read-only history of sync runs, with a Resolve shortcut for problem runs. */
export class SyncLogModal extends Modal {
  constructor(
    app: App,
    private entries: SyncLogEntry[],
    private readonly actions: SyncLogActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("S3 Sync: sync log");
    this.modalEl.addClass("s3-sync-wide-modal");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (this.entries.length === 0) {
      contentEl.createEl("p", { text: "No syncs recorded yet." });
      return;
    }

    const clear = contentEl.createEl("button", { text: "Clear log", cls: "s3-sync-log-clear" });
    clear.addEventListener("click", async () => {
      await this.actions.clearLog();
      this.entries = [];
      this.render();
    });

    for (const entry of this.entries) this.renderEntry(contentEl, entry);
  }

  private renderEntry(container: HTMLElement, entry: SyncLogEntry): void {
    const box = container.createDiv({ cls: "s3-sync-log-entry" });
    const problems = entry.conflictCopies.length + entry.failedFiles.length;
    if (problems > 0) box.addClass("s3-sync-log-problem");

    const head = box.createDiv({ cls: "s3-sync-log-head" });
    head.createSpan({ cls: "s3-sync-log-time", text: new Date(entry.at).toLocaleString() });
    head.createSpan({ cls: "s3-sync-version-meta", text: `via ${entry.trigger}` });

    const counts: string[] = [];
    if (entry.pushed) counts.push(`↑ ${entry.pushed}`);
    if (entry.pulled) counts.push(`↓ ${entry.pulled}`);
    if (entry.deletedLocal || entry.deletedRemote) counts.push(`✕ ${entry.deletedLocal + entry.deletedRemote}`);
    if (entry.merged) counts.push(`⇄ ${entry.merged} merged`);
    if (entry.conflicts) counts.push(`⚠ ${entry.conflicts} conflicts`);
    if (entry.errors.length) counts.push(`✗ ${entry.errors.length} errors`);
    box.createDiv({ cls: "s3-sync-log-counts", text: counts.length ? counts.join("   ") : "up to date" });

    if (entry.errors.length > 0) {
      const errs = box.createEl("details");
      errs.createEl("summary", { text: `${entry.errors.length} error(s)` });
      const ul = errs.createEl("ul");
      for (const e of entry.errors) ul.createEl("li", { text: e });
    }

    if (problems > 0) {
      const resolve = box.createEl("button", { text: `Resolve ${problems} issue(s)`, cls: "mod-cta" });
      resolve.addEventListener("click", () => this.actions.resolveEntry(entry));
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
