import { diffLines } from "../sync/merge";

const decoder = new TextDecoder();

export function bytesToText(buf: ArrayBuffer): string {
  return decoder.decode(buf);
}

/** Render a unified line diff of before -> after into a container element. */
export function renderDiff(container: HTMLElement, before: string, after: string): void {
  container.empty();
  container.addClass("s3-sync-diff");
  const lines = diffLines(before, after);
  if (lines.every((l) => l.kind === "context")) {
    container.createDiv({ cls: "s3-sync-diff-empty", text: "No differences." });
    return;
  }
  for (const line of lines) {
    const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
    container.createDiv({ cls: `s3-sync-diff-line s3-sync-diff-${line.kind}`, text: `${prefix} ${line.text}` });
  }
}

/** Whether a path looks like a text file we can safely diff/preview. */
export function isTextPath(path: string): boolean {
  return /\.(md|markdown|txt|csv|json|ya?ml|0)$/i.test(path) || !path.includes(".");
}
