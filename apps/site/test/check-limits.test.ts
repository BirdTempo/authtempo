import { LIMIT_FAMILIES } from "@authtempo/core/observe";
import { describe, expect, it } from "vitest";
import { checkLimits } from "../scripts/check-limits.ts";
import { distPageOrEmpty } from "../scripts/lib/load.ts";

const page = (keys: string[]) =>
  `<table><thead><tr><th>Key</th><th>Window</th></tr></thead><tbody>${keys
    .map((k) => `<tr><td><code dir="auto">${k}</code></td><td>15 minutes</td></tr>`)
    .join(
      "",
    )}</tbody></table><table><thead><tr><th>Count</th></tr></thead><tbody><tr><td><code>otp:x:y</code></td></tr></tbody></table>`;

describe("checkLimits", () => {
  it("passes when the limits page lists exactly the families", () => {
    const r = checkLimits(page(["otp:ip:&lt;ip&gt;", "otp:email:&lt;email&gt;"]), [
      "otp:ip",
      "otp:email",
    ]);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ families: 2, rows: 2 });
  });

  it("passes on the real build", () => {
    const r = checkLimits(distPageOrEmpty("/docs/reference/limits/"), LIMIT_FAMILIES);
    expect(r.failures).toEqual([]);
    expect(r.counts.rows).toBe(r.counts.families);
  });

  it("fails on a missing family and on an extra key", () => {
    const r = checkLimits(page(["otp:ip:&lt;ip&gt;", "otp:day:&lt;email&gt;", "otp"]), [
      "otp:ip",
      "otp:email",
    ]);
    expect(r.failures).toEqual([
      "row otp:day:<email> names no limit family",
      "row otp is no key of a family",
      "family otp:email has no row",
    ]);
  });

  it("fails on a family with two rows", () => {
    const r = checkLimits(page(["otp:ip:&lt;ip&gt;", "otp:ip:&lt;other&gt;"]), ["otp:ip"]);
    expect(r.failures).toEqual(["family otp:ip has two rows"]);
  });

  it("fails at zero rows", () => {
    expect(checkLimits("", []).failures).toEqual(["read 0 families", "read 0 rows"]);
  });
});
