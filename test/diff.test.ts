import { describe, expect, it } from "vitest";
import { diffLines } from "../src/sync/merge";

describe("diffLines", () => {
  it("marks unchanged lines as context", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d.every((l) => l.kind === "context")).toBe(true);
    expect(d.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("detects an added line", () => {
    const d = diffLines("a\nc", "a\nb\nc");
    expect(d).toContainEqual({ kind: "add", text: "b" });
    expect(d.filter((l) => l.kind === "add")).toHaveLength(1);
    expect(d.filter((l) => l.kind === "remove")).toHaveLength(0);
  });

  it("detects a removed line", () => {
    const d = diffLines("a\nb\nc", "a\nc");
    expect(d).toContainEqual({ kind: "remove", text: "b" });
    expect(d.filter((l) => l.kind === "remove")).toHaveLength(1);
  });

  it("detects a replaced line as remove + add", () => {
    const d = diffLines("a\nold\nc", "a\nnew\nc");
    expect(d).toContainEqual({ kind: "remove", text: "old" });
    expect(d).toContainEqual({ kind: "add", text: "new" });
  });

  it("reconstructs `after` from context + adds", () => {
    const before = "one\ntwo\nthree\nfour";
    const after = "one\nTWO\nthree\nfour\nfive";
    const rebuilt = diffLines(before, after)
      .filter((l) => l.kind !== "remove")
      .map((l) => l.text)
      .join("\n");
    expect(rebuilt).toBe(after);
  });
});
