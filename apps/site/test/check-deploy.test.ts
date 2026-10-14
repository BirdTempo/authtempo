import { describe, expect, it } from "vitest";
import { checkDeploy } from "../scripts/check-deploy.ts";

describe("checkDeploy", () => {
  it("passes when the dry run exits 0", () => {
    const r = checkDeploy(() => ({ status: 0, output: "--dry-run: exiting now." }));
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ runs: 1 });
  });

  it("fails with the output when the dry run exits with another status", () => {
    const r = checkDeploy(() => ({ status: 1, output: "✘ [ERROR] Missing entry-point" }));
    expect(r.failures).toEqual([
      "wrangler deploy --dry-run exited 1: ✘ [ERROR] Missing entry-point",
    ]);
  });

  it("fails when wrangler did not start", () => {
    expect(checkDeploy(() => ({ status: null, output: "" })).failures).toEqual([
      "wrangler deploy --dry-run exited null: ",
    ]);
  });
});
