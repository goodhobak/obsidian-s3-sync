/** Minimal obsidian module stub so engine-level tests can be imported in node. */
export class Plugin {}
export class Modal {}
export class Notice {}
export class Setting {}
export class PluginSettingTab {}
export class App {}
export class TFile {}
export class TFolder {
  path = "";
  isRoot(): boolean {
    return this.path === "" || this.path === "/";
  }
}
export function normalizePath(p: string): string {
  return p;
}
export function requestUrl(): never {
  throw new Error("requestUrl is not available in tests");
}
