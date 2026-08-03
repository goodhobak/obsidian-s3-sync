import { App, Modal, Notice, Setting } from "obsidian";
import type { MigrationReport } from "../sync/engine";

export interface MigrateActions {
  dryRun(): Promise<MigrationReport>;
  run(): Promise<MigrationReport>;
}

/** Shows a dry-run report of the storage migration, then runs it on confirm. */
export class MigrateModal extends Modal {
  constructor(
    app: App,
    private readonly actions: MigrateActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("S3 Sync: migrate storage to deduplicated layout");
    this.modalEl.addClass("s3-sync-wide-modal");
    this.contentEl.createEl("p", { text: "Analyzing remote storage…", cls: "s3-sync-diff-empty" });
    void this.load();
  }

  private async load(): Promise<void> {
    let report: MigrationReport;
    try {
      report = await this.actions.dryRun();
    } catch (err) {
      this.contentEl.empty();
      this.contentEl.createEl("p", { text: `Could not analyze: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "This rewrites the remote to store identical content once and removes legacy/orphaned objects. It re-uploads content before deleting anything, and is safe to run more than once.",
      cls: "s3-sync-version-meta",
    });
    this.renderReport(report, "Planned");

    if (report.rehomed === 0 && report.deletedLegacy === 0 && report.deletedOrphan === 0 && report.repointed === 0) {
      this.contentEl.createEl("p", { text: "Nothing to migrate — storage is already deduplicated. 🎉" });
      return;
    }

    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Run migration")
        .setCta()
        .onClick(async () => {
          b.setDisabled(true).setButtonText("Migrating…");
          try {
            const result = await this.actions.run();
            new Notice(
              `S3 Sync migration done: re-homed ${result.rehomed}, removed ${result.deletedLegacy + result.deletedOrphan} objects`,
            );
            this.close();
          } catch (err) {
            new Notice(`S3 Sync migration failed: ${err instanceof Error ? err.message : String(err)}`, 8000);
            b.setDisabled(false).setButtonText("Run migration");
          }
        }),
    );
  }

  private renderReport(report: MigrationReport, label: string): void {
    const box = this.contentEl.createDiv({ cls: "s3-sync-stats" });
    const rows: Array<[string, string]> = [
      [`${label}: distinct content versions`, `${report.referenced}`],
      ["Blobs to re-home into the dedup store", `${report.rehomed}`],
      ["Live entries to repoint", `${report.repointed}`],
      ["Legacy objects to remove", `${report.deletedLegacy}`],
      ["Orphaned blobs to remove", `${report.deletedOrphan}`],
    ];
    for (const [k, v] of rows) {
      const row = box.createDiv({ cls: "s3-sync-stats-row" });
      row.createSpan({ cls: "s3-sync-stats-label", text: k });
      row.createSpan({ cls: "s3-sync-stats-value", text: v });
    }
    if (report.missing.length > 0) {
      box.createDiv({
        cls: "s3-sync-folder-empty",
        text: `${report.missing.length} version(s) have no retrievable content and will be skipped.`,
      });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
