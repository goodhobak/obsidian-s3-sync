import type { SyncStatus } from "../types";

/** Small status-bar text controller (desktop; mobile has no status bar). */
export class StatusBarController {
  constructor(private readonly el: HTMLElement, onClick: () => void) {
    el.addClass("s3-sync-status-bar");
    el.setAttribute("aria-label", "S3 Sync — click to sync now");
    el.addEventListener("click", onClick);
    this.render({ phase: "idle", message: "", lastSyncAt: null, pendingOps: 0 });
  }

  render(status: SyncStatus): void {
    this.el.toggleClass("s3-sync-status-error", status.phase === "error");
    switch (status.phase) {
      case "idle": {
        const at = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleTimeString() : null;
        this.el.setText(at ? `S3 ✓ ${at}` : "S3 idle");
        break;
      }
      case "scanning":
      case "pulling":
      case "pushing":
        this.el.setText(`S3 ⟳ ${status.message || "syncing"}`);
        break;
      case "error":
        this.el.setText("S3 ✗ error");
        break;
    }
    if (status.message) this.el.setAttribute("title", status.message);
  }
}
