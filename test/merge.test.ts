import { describe, expect, it } from "vitest";
import { mergeThreeWay } from "../src/sync/merge";

const BASE = ["# Title", "", "line one", "line two", "line three", "", "footer"].join("\n");

describe("mergeThreeWay", () => {
  it("returns either side unchanged cases trivially", () => {
    expect(mergeThreeWay(BASE, BASE, BASE)).toEqual({ clean: true, merged: BASE });
    const changed = BASE.replace("line one", "line 1");
    expect(mergeThreeWay(BASE, changed, BASE).merged).toBe(changed);
    expect(mergeThreeWay(BASE, BASE, changed).merged).toBe(changed);
  });

  it("merges edits to different regions", () => {
    const local = BASE.replace("line one", "line one (local)");
    const remote = BASE.replace("footer", "footer (remote)");
    const result = mergeThreeWay(BASE, local, remote);
    expect(result.clean).toBe(true);
    expect(result.merged).toContain("line one (local)");
    expect(result.merged).toContain("footer (remote)");
  });

  it("merges an insertion and a distant deletion", () => {
    const local = BASE.replace("line two\n", "");
    const remote = BASE.replace("footer", "footer\nnew remote line");
    const result = mergeThreeWay(BASE, local, remote);
    expect(result.clean).toBe(true);
    expect(result.merged).not.toContain("line two");
    expect(result.merged).toContain("new remote line");
  });

  it("reports overlapping edits as unclean", () => {
    const local = BASE.replace("line two", "line two local");
    const remote = BASE.replace("line two", "line two remote");
    expect(mergeThreeWay(BASE, local, remote).clean).toBe(false);
  });

  it("reports same-point insertions as unclean", () => {
    const local = BASE.replace("line two", "line two\ninserted local");
    const remote = BASE.replace("line two", "line two\ninserted remote");
    expect(mergeThreeWay(BASE, local, remote).clean).toBe(false);
  });

  it("keeps identical concurrent edits", () => {
    const both = BASE.replace("line two", "same change");
    expect(mergeThreeWay(BASE, both, both)).toEqual({ clean: true, merged: both });
  });
});
