import { App, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import type { LocalIndex, SyncLogEntry } from "./types";
import type { IndexStore, LocalFileStat, VaultFiles } from "./sync/vault-files";
import { desanitizeVaultPath, sanitizeVaultPath } from "./platform/filename";
import { formatLogLine, type Logger, type LogLevel } from "./logger";

/**
 * VaultFiles over the live Obsidian vault.
 *
 * Normal notes/attachments go through the tracked `vault` API. Config files
 * under `.obsidian` are NOT tracked by `vault.getFiles()`, so when config sync
 * is enabled they are enumerated and read/written through the raw `vault.adapter`
 * instead. `includeConfig` is a live getter so toggling the setting takes
 * effect without rebuilding the adapter.
 *
 * The engine always works in canonical vault paths (as stored in the remote
 * manifest). When `sanitizeNames` is on (Windows), a file whose canonical name
 * contains a Windows-illegal character is stored locally under a fullwidth-
 * substituted name; every boundary translates canonical <-> local so this stays
 * invisible to the engine and to other platforms.
 */
export class ObsidianVaultFiles implements VaultFiles {
  private readonly configDir: string;

  constructor(
    private readonly app: App,
    private readonly includeConfig: () => boolean = () => false,
    private readonly sanitizeNames = false,
  ) {
    this.configDir = app.vault.configDir;
  }

  /** Canonical vault path -> on-disk local path. */
  private toLocal(path: string): string {
    return this.sanitizeNames ? sanitizeVaultPath(path) : path;
  }

  /** On-disk local path -> canonical vault path. */
  private toCanonical(path: string): string {
    return this.sanitizeNames ? desanitizeVaultPath(path) : path;
  }

  private isConfigPath(path: string): boolean {
    return path === this.configDir || path.startsWith(this.configDir + "/");
  }

  async listFiles(): Promise<LocalFileStat[]> {
    const tracked = this.app.vault
      .getFiles()
      .map((f) => ({ path: this.toCanonical(f.path), size: f.stat.size, mtime: f.stat.mtime }));
    if (!this.includeConfig()) return tracked;
    const config = await this.walkConfig(this.configDir);
    return [...tracked, ...config];
  }

  /** Recursively enumerate the config dir via the raw adapter. */
  private async walkConfig(dir: string): Promise<LocalFileStat[]> {
    const out: LocalFileStat[] = [];
    const adapter = this.app.vault.adapter;
    let listing: { files: string[]; folders: string[] };
    try {
      listing = await adapter.list(dir);
    } catch {
      return out; // dir may not exist
    }
    for (const filePath of listing.files) {
      const st = await adapter.stat(filePath);
      if (st) out.push({ path: this.toCanonical(filePath), size: st.size, mtime: st.mtime });
    }
    for (const folder of listing.folders) {
      out.push(...(await this.walkConfig(folder)));
    }
    return out;
  }

  private fileAt(path: string): TFile | null {
    const af = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return af instanceof TFile ? af : null;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const local = this.toLocal(path);
    if (this.isConfigPath(local)) return this.app.vault.adapter.readBinary(local);
    const file = this.fileAt(local);
    if (!file) throw new Error(`File not found: ${path}`);
    return this.app.vault.readBinary(file);
  }

  async writeBinary(path: string, data: ArrayBuffer, mtime?: number): Promise<void> {
    const local = this.toLocal(path);
    if (this.isConfigPath(local)) {
      await this.ensureAdapterFolders(local);
      await this.app.vault.adapter.writeBinary(local, data, mtime ? { mtime } : undefined);
      return;
    }
    const normalized = normalizePath(local);
    await this.ensureParentFolders(normalized);
    const existing = this.fileAt(normalized);
    const options = mtime ? { mtime } : undefined;
    if (existing) {
      await this.app.vault.modifyBinary(existing, data, options);
    } else {
      await this.app.vault.createBinary(normalized, data, options);
    }
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (!existing) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // Folder may have been created concurrently; the next iteration will see it.
        }
      }
    }
  }

  private async ensureAdapterFolders(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      try {
        if (!(await this.app.vault.adapter.exists(current))) await this.app.vault.adapter.mkdir(current);
      } catch {
        // Concurrent creation; ignore.
      }
    }
  }

  async delete(path: string): Promise<void> {
    const local = this.toLocal(path);
    if (this.isConfigPath(local)) {
      // Config files aren't tracked; remove directly (remote history keeps a copy).
      if (await this.app.vault.adapter.exists(local)) await this.app.vault.adapter.remove(local);
      return;
    }
    const file = this.fileAt(local);
    // Follow the user's trash preference instead of destroying content outright.
    if (file) await this.app.fileManager.trashFile(file);
  }

  async exists(path: string): Promise<boolean> {
    const local = this.toLocal(path);
    if (this.isConfigPath(local)) return this.app.vault.adapter.exists(local);
    return this.fileAt(local) !== null;
  }

  async stat(path: string): Promise<LocalFileStat | null> {
    const local = this.toLocal(path);
    if (this.isConfigPath(local)) {
      const st = await this.app.vault.adapter.stat(local);
      return st && st.type === "file" ? { path, size: st.size, mtime: st.mtime } : null;
    }
    const file = this.fileAt(local);
    return file ? { path, size: file.stat.size, mtime: file.stat.mtime } : null;
  }
}

/** Persists the local sync index next to the plugin (not inside the synced files). */
export class ObsidianIndexStore implements IndexStore<LocalIndex> {
  constructor(private readonly plugin: Plugin) {}

  private get path(): string {
    return normalizePath(`${this.plugin.manifest.dir}/sync-index.json`);
  }

  async load(): Promise<LocalIndex | null> {
    try {
      const adapter = this.plugin.app.vault.adapter;
      if (!(await adapter.exists(this.path))) return null;
      return JSON.parse(await adapter.read(this.path)) as LocalIndex;
    } catch {
      return null; // a corrupt index only costs a full re-scan
    }
  }

  async save(value: LocalIndex): Promise<void> {
    await this.plugin.app.vault.adapter.write(this.path, JSON.stringify(value));
  }

  async reset(): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    if (await adapter.exists(this.path)) await adapter.remove(this.path);
  }
}

/** Persists a capped, newest-first log of sync runs next to the plugin. */
export class SyncLogStore {
  private readonly cap = 100;

  constructor(private readonly plugin: Plugin) {}

  private get path(): string {
    return normalizePath(`${this.plugin.manifest.dir}/sync-log.json`);
  }

  async load(): Promise<SyncLogEntry[]> {
    try {
      const adapter = this.plugin.app.vault.adapter;
      if (!(await adapter.exists(this.path))) return [];
      const parsed = JSON.parse(await adapter.read(this.path));
      return Array.isArray(parsed) ? (parsed as SyncLogEntry[]) : [];
    } catch {
      return [];
    }
  }

  /** Prepend an entry (newest first) and truncate to the cap. Returns the new log. */
  async append(entry: SyncLogEntry): Promise<SyncLogEntry[]> {
    const log = await this.load();
    log.unshift(entry);
    if (log.length > this.cap) log.length = this.cap;
    await this.plugin.app.vault.adapter.write(this.path, JSON.stringify(log));
    return log;
  }

  async clear(): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    if (await adapter.exists(this.path)) await adapter.remove(this.path);
  }
}

/**
 * File-backed diagnostic logger for developer mode. Writes to
 * `<pluginDir>/debug-log.txt`. Lines are buffered briefly and flushed on a
 * short timer, on warn/error, and on demand — so the last lines survive a hard
 * process kill (e.g. Android terminating a large sync). Appends are serialized.
 */
export class FileLogger implements Logger {
  private buffer: string[] = [];
  private flushing: Promise<void> = Promise.resolve();
  private timer: number | null = null;
  private readonly maxBufferChars = 8 * 1024;

  constructor(private readonly plugin: Plugin) {}

  get path(): string {
    return normalizePath(`${this.plugin.manifest.dir}/debug-log.txt`);
  }

  /** Human-readable absolute location shown to the user. */
  displayPath(): string {
    return `<vault>/${this.path}`;
  }

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    this.buffer.push(formatLogLine(level, message, data, Date.now()));
    const urgent = level === "warn" || level === "error";
    if (urgent || this.buffer.join("\n").length >= this.maxBufferChars) {
      void this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, 1000);
    }
  }

  /** Write buffered lines to disk. Serialized so appends never interleave. */
  flush(): Promise<void> {
    if (this.buffer.length === 0) return this.flushing;
    const chunk = this.buffer.join("\n") + "\n";
    this.buffer = [];
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing = this.flushing
      .then(() => this.plugin.app.vault.adapter.append(this.path, chunk))
      .catch(() => {
        // Never let logging failures affect sync.
      });
    return this.flushing;
  }

  async clear(): Promise<void> {
    this.buffer = [];
    const adapter = this.plugin.app.vault.adapter;
    await this.flushing.catch(() => {});
    if (await adapter.exists(this.path)) await adapter.remove(this.path);
  }

  async read(): Promise<string> {
    await this.flush();
    const adapter = this.plugin.app.vault.adapter;
    return (await adapter.exists(this.path)) ? adapter.read(this.path) : "";
  }
}
