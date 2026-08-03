import { App, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import type { LocalIndex, SyncLogEntry } from "./types";
import type { IndexStore, LocalFileStat, VaultFiles } from "./sync/vault-files";

/** VaultFiles implementation over the live Obsidian vault. */
export class ObsidianVaultFiles implements VaultFiles {
  constructor(private readonly app: App) {}

  async listFiles(): Promise<LocalFileStat[]> {
    return this.app.vault.getFiles().map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }

  private fileAt(path: string): TFile | null {
    const af = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return af instanceof TFile ? af : null;
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const file = this.fileAt(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return this.app.vault.readBinary(file);
  }

  async writeBinary(path: string, data: ArrayBuffer, mtime?: number): Promise<void> {
    const normalized = normalizePath(path);
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

  async delete(path: string): Promise<void> {
    const file = this.fileAt(path);
    // Follow the user's trash preference instead of destroying content outright.
    if (file) await this.app.fileManager.trashFile(file);
  }

  async exists(path: string): Promise<boolean> {
    return this.fileAt(path) !== null;
  }

  async stat(path: string): Promise<LocalFileStat | null> {
    const file = this.fileAt(path);
    return file ? { path: file.path, size: file.stat.size, mtime: file.stat.mtime } : null;
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
