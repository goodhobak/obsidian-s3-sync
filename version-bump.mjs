// Sync manifest.json + versions.json to a target version so Obsidian and BRAT
// can detect updates. Version comes from `npm_package_version` (set by
// `pnpm version`) or the first CLI arg.
import { readFileSync, writeFileSync } from "fs";

const target = process.env.npm_package_version ?? process.argv[2];
if (!target || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(target)) {
  console.error(`Usage: node version-bump.mjs <version>  (got: ${target ?? "nothing"})`);
  process.exit(1);
}

// manifest.json: bump the plugin version.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const minAppVersion = manifest.minAppVersion;
manifest.version = target;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

// versions.json: record which minAppVersion this plugin version needs. Obsidian
// uses this to decide whether an update is compatible with the running app.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[target] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Bumped to ${target} (minAppVersion ${minAppVersion}) in manifest.json + versions.json`);
