import { App, Modal, Notice } from "obsidian";
import type { ConflictCopyRecord, FailedFileRecord } from "../types";
import { isTextPath, renderDiff } from "./diff-view";

export interface ResolveActions {
  /** Current on-disk text content of a path, or null if missing/binary. */
  readTextFile(path: string): Promise<string | null>;
  /** Discard this device's version: delete the conflict copy. */
  keepCurrent(copyPath: string): Promise<void>;
  /** Adopt this device's version: overwrite the canonical file with the copy, then delete the copy. */
  useCopy(canonicalPath: string, copyPath: string): Promise<void>;
  /** Open both files side by side so the user can merge manually. */
  openBoth(canonicalPath: string, copyPath: string): void;
  /** Re-run a sync (used to retry failed files). */
  retrySync(): Promise<void>;
}

/**
 * Presents unresolved conflicts (both versions kept) and failed files, with
 * one-click actions to resolve each. Conflicts show a diff of the canonical
 * file vs the kept copy.
 */
export class ResolveModal extends Modal {
  constructor(
    app: App,
    private conflicts: ConflictCopyRecord[],
    private failures: FailedFileRecord[],
    private readonly actions: ResolveActions,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("S3 Sync: resolve conflicts & errors");
    this.modalEl.addClass("s3-sync-wide-modal");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (this.conflicts.length === 0 && this.failures.length === 0) {
      contentEl.createEl("p", { text: "Nothing to resolve — no conflicts or errors outstanding. 🎉" });
      return;
    }

    this.renderBulkBar(contentEl);

    if (this.conflicts.length > 0) {
      contentEl.createEl("h3", { text: `Conflicts (${this.conflicts.length})` });
      contentEl.createEl("p", {
        cls: "s3-sync-version-meta",
        text:
          "Both versions were kept. The remote version is at the original path; your version is in the copy. " +
          "Choose which to keep, or open both to merge by hand.",
      });
      for (const c of [...this.conflicts]) this.renderConflict(contentEl, c);
    }

    if (this.failures.length > 0) {
      contentEl.createEl("h3", { text: `Errors (${this.failures.length})` });
      for (const f of [...this.failures]) this.renderFailure(contentEl, f);
    }
  }

  /** Top bar with actions that apply to every outstanding item at once. */
  private renderBulkBar(container: HTMLElement): void {
    const bar = container.createDiv({ cls: "s3-sync-resolve-bulk" });
    bar.createSpan({ cls: "s3-sync-version-meta", text: "Apply to all:" });

    if (this.conflicts.length > 0) {
      const keepAll = bar.createEl("button", { text: `Keep all remote (${this.conflicts.length})` });
      keepAll.addEventListener("click", () => void this.runBulkConflicts("keepRemote"));

      const useAll = bar.createEl("button", { text: `Use all my versions (${this.conflicts.length})`, cls: "mod-cta" });
      useAll.addEventListener("click", () => void this.runBulkConflicts("useMine"));
    }

    if (this.failures.length > 0) {
      const retryAll = bar.createEl("button", { text: `Retry all (${this.failures.length})` });
      retryAll.addEventListener("click", () => void this.runRetryAll());
    }
  }

  private async runBulkConflicts(kind: "keepRemote" | "useMine"): Promise<void> {
    const label = kind === "keepRemote" ? "Keep all remote" : "Use all my versions";
    this.setBulkBusy(true, `${label}…`);
    const targets = [...this.conflicts];
    let done = 0;
    const remaining: ConflictCopyRecord[] = [];
    for (const c of targets) {
      try {
        if (kind === "keepRemote") await this.actions.keepCurrent(c.conflictCopy);
        else await this.actions.useCopy(c.path, c.conflictCopy);
        done++;
      } catch {
        remaining.push(c); // keep the ones that failed so the user can retry
      }
    }
    this.conflicts = remaining;
    new Notice(`S3 Sync: resolved ${done} conflict(s)${remaining.length ? `, ${remaining.length} failed` : ""}`);
    this.render();
  }

  private async runRetryAll(): Promise<void> {
    this.setBulkBusy(true, "Retrying all…");
    try {
      await this.actions.retrySync();
      this.failures = [];
      new Notice("S3 Sync: retried all failed files");
    } catch (err) {
      new Notice(`S3 Sync: retry failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
    this.render();
  }

  /** Disable the bulk bar's buttons while an operation runs. */
  private setBulkBusy(busy: boolean, label: string): void {
    const bar = this.contentEl.querySelector(".s3-sync-resolve-bulk");
    if (!bar) return;
    bar.querySelectorAll("button").forEach((b) => {
      (b as HTMLButtonElement).disabled = busy;
    });
    if (busy) bar.createSpan({ cls: "s3-sync-version-meta", text: ` ${label}` });
  }

  private renderConflict(container: HTMLElement, c: ConflictCopyRecord): void {
    const box = container.createDiv({ cls: "s3-sync-resolve-item" });
    box.createDiv({ cls: "s3-sync-resolve-title", text: c.path });
    box.createDiv({ cls: "s3-sync-version-meta", text: `Your version kept as: ${c.conflictCopy}` });

    const diffHost = box.createDiv();
    const buttons = box.createDiv({ cls: "s3-sync-resolve-buttons" });

    if (isTextPath(c.path)) {
      const compare = buttons.createEl("button", { text: "Compare" });
      compare.addEventListener("click", async () => {
        diffHost.empty();
        diffHost.createEl("p", { text: "Loading…", cls: "s3-sync-diff-empty" });
        const [remote, mine] = await Promise.all([
          this.actions.readTextFile(c.path),
          this.actions.readTextFile(c.conflictCopy),
        ]);
        diffHost.empty();
        diffHost.createEl("p", {
          cls: "s3-sync-version-meta",
          text: "Diff: remote (current path) → your copy (green = only in your copy).",
        });
        renderDiff(diffHost.createDiv(), remote ?? "", mine ?? "");
      });
    }

    const keepRemote = buttons.createEl("button", { text: "Keep remote" });
    keepRemote.addEventListener("click", () =>
      this.runConflictAction(c, () => this.actions.keepCurrent(c.conflictCopy), `Kept remote version of ${c.path}`),
    );

    const useMine = buttons.createEl("button", { text: "Use my version", cls: "mod-cta" });
    useMine.addEventListener("click", () =>
      this.runConflictAction(c, () => this.actions.useCopy(c.path, c.conflictCopy), `Used your version of ${c.path}`),
    );

    const openBoth = buttons.createEl("button", { text: "Open both" });
    openBoth.addEventListener("click", () => this.actions.openBoth(c.path, c.conflictCopy));
  }

  private async runConflictAction(c: ConflictCopyRecord, action: () => Promise<void>, doneMsg: string): Promise<void> {
    try {
      await action();
      this.conflicts = this.conflicts.filter((x) => x.conflictCopy !== c.conflictCopy);
      new Notice(`S3 Sync: ${doneMsg}`);
      this.render();
    } catch (err) {
      new Notice(`S3 Sync: could not resolve — ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  private renderFailure(container: HTMLElement, f: FailedFileRecord): void {
    const box = container.createDiv({ cls: "s3-sync-resolve-item" });
    box.createDiv({ cls: "s3-sync-resolve-title", text: f.path });
    box.createDiv({ cls: "s3-sync-version-meta", text: `${f.kind}: ${f.reason}` });
    const buttons = box.createDiv({ cls: "s3-sync-resolve-buttons" });
    const retry = buttons.createEl("button", { text: "Retry sync", cls: "mod-cta" });
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      retry.setText("Retrying…");
      try {
        await this.actions.retrySync();
        this.failures = this.failures.filter((x) => x.path !== f.path);
        new Notice(`S3 Sync: retried ${f.path}`);
        this.render();
      } catch (err) {
        new Notice(`S3 Sync: retry failed — ${err instanceof Error ? err.message : String(err)}`, 8000);
        retry.disabled = false;
        retry.setText("Retry sync");
      }
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
