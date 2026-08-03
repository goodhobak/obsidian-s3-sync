/** Shared types for the S3 Sync plugin. */

export interface S3ConnectionSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket, e.g. "vaults/my-vault". No leading/trailing slash. */
  prefix: string;
  /** Path-style addressing (required for most self-hosted S3 like RustFS/MinIO). */
  forcePathStyle: boolean;
}

export interface SyncFilterSettings {
  /** Extensions synced in addition to markdown, lowercase without dot. */
  extensions: string[];
  /** Folder paths (vault-relative) excluded from sync. */
  excludedFolders: string[];
  /** Maximum file size in bytes; 0 = unlimited. */
  maxFileSize: number;
}

export interface PluginSettings {
  connection: S3ConnectionSettings;
  filters: SyncFilterSettings;
  /** Automatically sync on vault changes and on an interval. */
  autoSync: boolean;
  /** Seconds between periodic pulls. */
  syncIntervalSeconds: number;
  /** Debounce for pushing local changes, in seconds. */
  pushDebounceSeconds: number;
  /** Refuse to delete more than this fraction of the vault in one sync without confirmation (0-1). */
  massDeleteThreshold: number;
  /** End-to-end encryption enabled. */
  encryptionEnabled: boolean;
  /** Encryption passphrase (stored locally only). */
  encryptionPassphrase: string;
  /** Keep this many old versions per file remotely; 0 disables version history. */
  versionsToKeep: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  connection: {
    endpoint: "http://localhost:9000",
    region: "us-east-1",
    bucket: "",
    accessKeyId: "",
    secretAccessKey: "",
    prefix: "",
    forcePathStyle: true,
  },
  filters: {
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "mp3", "wav", "m4a", "ogg", "mp4", "webm", "mov", "pdf"],
    excludedFolders: [],
    maxFileSize: 0,
  },
  autoSync: true,
  syncIntervalSeconds: 300,
  pushDebounceSeconds: 15,
  massDeleteThreshold: 0.5,
  encryptionEnabled: false,
  encryptionPassphrase: "",
  versionsToKeep: 5,
};

/** One entry in the remote manifest. */
export interface ManifestEntry {
  /** SHA-256 hex of plaintext content. */
  hash: string;
  size: number;
  /** Milliseconds since epoch of the writing device's mtime. */
  mtime: number;
  /** Monotonic per-entry revision, bumped on every remote change to the entry. */
  rev: number;
  /** Storage key of the blob relative to the prefix (plaintext mode mirrors path; encrypted mode uses opaque ids). */
  blobKey: string;
  /** Tombstone: file was deleted at this time (ms). Entry kept for deletion propagation. */
  deletedAt?: number;
  /** Prior versions, newest first. Blobs live at history/{hash} (content-addressed). */
  history?: HistoryVersion[];
}

export interface HistoryVersion {
  hash: string;
  size: number;
  /** When this version was superseded (ms). */
  ts: number;
}

export interface RemoteManifest {
  schemaVersion: 1;
  /** Vault-wide revision, bumped on every manifest write. */
  revision: number;
  updatedAt: number;
  files: Record<string, ManifestEntry>;
}

/** Per-file state remembered locally from the last completed sync (the 3-way merge "base"). */
export interface IndexEntry {
  hash: string;
  size: number;
  mtime: number;
  rev: number;
  blobKey: string;
}

export interface LocalIndex {
  schemaVersion: 1;
  /** Remote manifest revision this index is consistent with. */
  manifestRevision: number;
  files: Record<string, IndexEntry>;
}

export type SyncPhase = "idle" | "scanning" | "pulling" | "pushing" | "error";

export interface SyncStatus {
  phase: SyncPhase;
  message: string;
  lastSyncAt: number | null;
  pendingOps: number;
  /** File operations completed in the current (or most recent) sync. */
  completedOps: number;
  /** File operations planned for the current sync (0 when idle). */
  plannedOps: number;
}

/** Snapshot of what is and isn't synced, for the settings statistics panel. */
export interface SyncStats {
  /** Syncable files currently in the vault (filters applied). */
  vaultObjects: number;
  /** Total bytes of those syncable files. */
  vaultBytes: number;
  /** Files tracked in the local sync index (already synced). */
  syncedObjects: number;
  lastSyncAt: number | null;
  lastSummary: string;
}

export function emptyManifest(): RemoteManifest {
  return { schemaVersion: 1, revision: 0, updatedAt: 0, files: {} };
}

export function emptyIndex(): LocalIndex {
  return { schemaVersion: 1, manifestRevision: 0, files: {} };
}
