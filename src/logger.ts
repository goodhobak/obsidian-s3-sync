export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void;
}

/** No-op logger used when developer mode is off. */
export const NOOP_LOGGER: Logger = { log: () => {} };

/** Sample current JS heap usage if the runtime exposes it (Chromium/Android webview). */
export function sampleMemoryMb(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / (1024 * 1024)) : null;
}

/** Format one log entry as a single line: ISO-ish time, level, message, and JSON data. */
export function formatLogLine(level: LogLevel, message: string, data: Record<string, unknown> | undefined, at: number): string {
  const ts = new Date(at).toISOString();
  const suffix = data && Object.keys(data).length > 0 ? " " + JSON.stringify(data) : "";
  return `${ts} [${level.toUpperCase()}] ${message}${suffix}`;
}
