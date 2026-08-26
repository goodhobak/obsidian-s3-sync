import { describe, expect, it } from "vitest";
import { classifyOverview } from "../src/sync/overview";

function inputs(over: Partial<Parameters<typeof classifyOverview>[0]> = {}) {
  return {
    local: new Map<string, { mtime: number; size: number }>(),
    indexed: new Map<string, { mtime: number; size: number }>(),
    remoteLive: new Set<string>(),
    failures: new Map<string, string>(),
    ...over,
  };
}

describe("classifyOverview", () => {
  it("classifies synced vs modified using the index (mtime+size)", () => {
    const { rows, counts } = classifyOverview(
      inputs({
        local: new Map([
          ["a.md", { mtime: 100, size: 5 }],
          ["b.md", { mtime: 200, size: 9 }], // changed since index
        ]),
        indexed: new Map([
          ["a.md", { mtime: 100, size: 5 }], // matches → synced
          ["b.md", { mtime: 150, size: 9 }], // mtime differs → modified
        ]),
        remoteLive: new Set(["a.md", "b.md"]),
      }),
    );
    expect(counts.synced).toBe(1);
    expect(counts.modified).toBe(1);
    expect(rows.find((r) => r.path === "a.md")!.status).toBe("synced");
    expect(rows.find((r) => r.path === "b.md")!.status).toBe("modified");
  });

  it("classifies remote-only and local-only", () => {
    const { counts, rows } = classifyOverview(
      inputs({
        local: new Map([["local.md", { mtime: 1, size: 1 }]]),
        remoteLive: new Set(["server.md"]),
      }),
    );
    expect(counts.localOnly).toBe(1);
    expect(counts.remoteOnly).toBe(1);
    expect(rows.find((r) => r.path === "server.md")!.status).toBe("remoteOnly");
    expect(rows.find((r) => r.path === "local.md")!.status).toBe("localOnly");
  });

  it("failed takes precedence and carries the reason", () => {
    const { rows, counts } = classifyOverview(
      inputs({
        local: new Map([["x.md", { mtime: 1, size: 1 }]]),
        remoteLive: new Set(["x.md"]),
        indexed: new Map([["x.md", { mtime: 1, size: 1 }]]), // would be synced…
        failures: new Map([["x.md", "Stream closed"]]), // …but it failed
      }),
    );
    expect(counts.failed).toBe(1);
    expect(counts.synced).toBe(0);
    const r = rows.find((r) => r.path === "x.md")!;
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("Stream closed");
  });

  it("a file both-sides but not in the index is modified (not synced)", () => {
    const { rows } = classifyOverview(
      inputs({
        local: new Map([["n.md", { mtime: 1, size: 1 }]]),
        remoteLive: new Set(["n.md"]),
      }),
    );
    expect(rows[0]!.status).toBe("modified");
  });

  it("excluded takes precedence over everything, including failures", () => {
    const { rows, counts } = classifyOverview(
      inputs({
        local: new Map([
          ["big.mp4", { mtime: 1, size: 1 }],
          ["ok.md", { mtime: 1, size: 1 }],
        ]),
        remoteLive: new Set(["big.mp4", "server.mp4", "ok.md"]),
        failures: new Map([["big.mp4", "too large"]]), // stale failure is silenced
        excluded: new Set(["big.mp4", "server.mp4"]),
      }),
    );
    expect(counts.excluded).toBe(2);
    expect(counts.failed).toBe(0);
    expect(rows.find((r) => r.path === "big.mp4")!.status).toBe("excluded");
    expect(rows.find((r) => r.path === "server.mp4")!.status).toBe("excluded"); // remote-only excluded
    expect(rows.find((r) => r.path === "ok.md")!.status).toBe("modified");
  });

  it("sorts rows by path and counts the union", () => {
    const { rows } = classifyOverview(
      inputs({
        local: new Map([["z.md", { mtime: 1, size: 1 }]]),
        remoteLive: new Set(["a.md"]),
      }),
    );
    expect(rows.map((r) => r.path)).toEqual(["a.md", "z.md"]);
  });
});
