/**
 * Narrow filesystem interface over the Obsidian vault so the engine is
 * unit-testable with an in-memory implementation.
 */

export interface LocalFileStat {
  path: string;
  size: number;
  mtime: number;
}

export interface VaultFiles {
  /** All non-hidden files in the vault (unfiltered; the scanner applies filters). */
  listFiles(): Promise<LocalFileStat[]>;
  readBinary(path: string): Promise<ArrayBuffer>;
  /** Create parent folders as needed. Overwrites existing content. */
  writeBinary(path: string, data: ArrayBuffer, mtime?: number): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<LocalFileStat | null>;
}

export interface IndexStore<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
}
