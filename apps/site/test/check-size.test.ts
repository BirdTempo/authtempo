import { describe, expect, it } from "vitest";
import { checkSize, MAX_BYTES, MAX_FILES } from "../scripts/check-size.ts";

describe("checkSize", () => {
  it("passes a small build and counts its files", () => {
    const r = checkSize([
      { path: "index.html", bytes: 900 },
      { path: "docs/index.html", bytes: 4_000 },
    ]);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ files: 2, largestBytes: 4_000 });
  });

  it("refuses a file above 20 MiB and names it", () => {
    const r = checkSize([{ path: "pagefind/big.pf_index", bytes: MAX_BYTES + 1 }]);
    expect(r.failures).toEqual([
      `pagefind/big.pf_index is ${MAX_BYTES + 1} bytes; the limit is ${MAX_BYTES}`,
    ]);
  });

  it("refuses more than 15,000 files", () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `f${i}`, bytes: 1 }));
    expect(checkSize(files).failures).toEqual([
      `dist holds ${MAX_FILES + 1} files; the limit is ${MAX_FILES}`,
    ]);
  });

  it("fails on an empty build", () => {
    expect(checkSize([]).failures).toEqual(["read 0 files"]);
  });
});
