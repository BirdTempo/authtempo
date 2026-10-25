import { LIMIT_FAMILIES } from "@authtempo/core/observe";
import { describe, expect, it } from "vitest";
import { checkLimits, DYNAMIC_LIMITS, windowSeconds } from "../scripts/check-limits.ts";
import { coreSources, type LimitWindowFact, limitWindows } from "../scripts/lib/limit-windows.ts";
import { distPageOrEmpty } from "../scripts/lib/load.ts";

type Row = [key: string, window: string, max: string];

const page = (rows: Row[]) =>
  `<table><thead><tr><th>Key</th><th>Window</th><th>Maximum</th><th>Flow</th></tr></thead><tbody>${rows
    .map(
      ([k, w, m]) =>
        `<tr><td><code dir="auto">${k}</code></td><td>${w}</td><td>${m}</td><td>A flow</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table><table><thead><tr><th>Count</th></tr></thead><tbody><tr><td><code>otp:x:y</code></td></tr></tbody></table>`;

const fact = (family: string, seconds: number | null, max: number | null): LimitWindowFact => ({
  family,
  seconds,
  max,
  at: "engine/otp.ts",
});
const code = (...facts: LimitWindowFact[]) => ({ facts, failures: [] });
const OTP = code(fact("otp:ip", 900, 20), fact("otp:email", 900, 3));

describe("checkLimits", () => {
  it("passes when the limits page lists exactly the families with the windows of the code", () => {
    const r = checkLimits(
      page([
        ["otp:ip:&lt;ip&gt;", "15 minutes", "20"],
        ["otp:email:&lt;email&gt;", "15 minutes", "3"],
      ]),
      ["otp:ip", "otp:email"],
      OTP,
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ families: 2, rows: 2, calls: 2, compared: 2 });
  });

  it("passes on the real build and the real code", () => {
    const r = checkLimits(
      distPageOrEmpty("/docs/reference/limits/"),
      LIMIT_FAMILIES,
      limitWindows(coreSources(), DYNAMIC_LIMITS),
    );
    expect(r.failures).toEqual([]);
    expect(r.counts.rows).toBe(r.counts.families);
    expect(r.counts.compared).toBe(LIMIT_FAMILIES.length - DYNAMIC_LIMITS.size);
  });

  it("fails on a missing family and on an extra key", () => {
    const r = checkLimits(
      page([
        ["otp:ip:&lt;ip&gt;", "15 minutes", "20"],
        ["otp:day:&lt;email&gt;", "1 day", "5"],
        ["otp", "1 day", "5"],
      ]),
      ["otp:ip", "otp:email"],
      OTP,
    );
    expect(r.failures).toEqual([
      "row otp:day:<email> names no limit family",
      "row otp is no key of a family",
      "family otp:email has no row",
    ]);
  });

  it("fails on a family with two rows", () => {
    const r = checkLimits(
      page([
        ["otp:ip:&lt;ip&gt;", "15 minutes", "20"],
        ["otp:ip:&lt;other&gt;", "15 minutes", "20"],
      ]),
      ["otp:ip"],
      code(fact("otp:ip", 900, 20)),
    );
    expect(r.failures).toEqual(["family otp:ip has two rows"]);
  });

  it("fails on a window or a maximum that is not the one of the code", () => {
    const r = checkLimits(
      page([
        ["otp:ip:&lt;ip&gt;", "1 hour", "20"],
        ["otp:email:&lt;email&gt;", "15 minutes", "5"],
      ]),
      ["otp:ip", "otp:email"],
      OTP,
    );
    expect(r.failures).toEqual([
      'row otp:ip:<ip>: the window "1 hour" is not the 900 s of engine/otp.ts',
      'row otp:email:<email>: the maximum "5" is not the 3 of engine/otp.ts',
    ]);
  });

  it("takes a setting for a part that the code reads from config, and fails on a number there", () => {
    const facts = code(fact("otp:all-day", 86_400, null));
    const named = checkLimits(
      page([["otp:all-day:deployment", "24 hours", "<code>otp.dailyCap</code>, default 1000"]]),
      ["otp:all-day"],
      facts,
    );
    expect(named.failures).toEqual([]);
    const bare = checkLimits(
      page([["otp:all-day:deployment", "24 hours", "1000"]]),
      ["otp:all-day"],
      facts,
    );
    expect(bare.failures).toEqual([
      "row otp:all-day:deployment: the maximum comes from a setting, and the cell names none",
    ]);
  });

  it("fails on a family whose calls in core have two windows, or no call", () => {
    const r = checkLimits(
      page([
        ["otp:ip:&lt;ip&gt;", "15 minutes", "20"],
        ["otp:email:&lt;email&gt;", "15 minutes", "3"],
      ]),
      ["otp:ip", "otp:email"],
      code(fact("otp:ip", 900, 20), { ...fact("otp:ip", 900, 30), at: "engine/reauth.ts" }),
    );
    expect(r.failures).toEqual([
      "family otp:ip has two windows in core: engine/otp.ts and engine/reauth.ts",
      "family otp:email has no limit call in core",
    ]);
  });

  it("exempts a family whose window the code builds at each call, and names it", () => {
    const r = checkLimits(
      page([["token-use:tk:&lt;tokenId&gt;", "The token's window", "The token's maximum"]]),
      ["token-use:tk"],
      code(fact("token-use:tk", null, null)),
    );
    expect(r.failures).toEqual(["read 0 compared"]);
    expect(r.exempt).toEqual(["token-use:tk: the code builds its window at each call"]);
  });

  it("fails at zero rows", () => {
    expect(checkLimits("", [], code()).failures).toEqual([
      "read 0 families",
      "read 0 rows",
      "read 0 calls",
      "read 0 compared",
    ]);
  });
});

describe("windowSeconds", () => {
  it("reads the units of the page", () => {
    expect(
      ["1 minute", "15 minutes", "1 hour", "24 hours", "2 days", "soon"].map(windowSeconds),
    ).toEqual([60, 900, 3600, 86_400, 172_800, null]);
  });
});

describe("limitWindows", () => {
  const file = (path: string, text: string) => ({ path, text });

  it("reads a const, an inline window, a product, a const of another file, and a setting", () => {
    const r = limitWindows(
      [
        file(
          "engine/a.ts",
          `import { DAY } from "./b.js";
const PER_IP = { seconds: 15 * 60, max: 20 };
export async function a(config, ip, phone) {
  await limit(config, "a:ip", ip, PER_IP);
  await limit(config, "a:day", ip, DAY);
  await limit(config, "a:inline", ip, { seconds: 3_600, max: 5 });
  const cap = { seconds: CAP_SECONDS, max: phone.dailyCap };
  await limit(config, "a:all-day", "deployment", cap);
}
const CAP_SECONDS = 86_400;`,
        ),
        file("engine/b.ts", "export const DAY = { seconds: 86_400, max: 10 };"),
      ],
      new Set(),
    );
    expect(r.failures).toEqual([]);
    expect(r.facts.map((f) => [f.family, f.seconds, f.max])).toEqual([
      ["a:ip", 900, 20],
      ["a:day", 86_400, 10],
      ["a:inline", 3600, 5],
      ["a:all-day", 86_400, null],
    ]);
  });

  it("reads both families of a choice, and skips the declaration of limit", () => {
    const r = limitWindows(
      [
        file(
          "x.ts",
          `export async function limit(config: C, family: F, subject: string, window: W) {}
const W = { seconds: 60, max: 2 };
limit(config, kind === "tk" ? "t:tk" : "t:to", id, W,);`,
        ),
      ],
      new Set(),
    );
    expect(r.failures).toEqual([]);
    expect(r.facts.map((f) => f.family)).toEqual(["t:tk", "t:to"]);
  });

  it("fails on a window it cannot read, unless the family is dynamic", () => {
    const files = [file("x.ts", 'limit(config, "d:code", hash, pollWindow(config, row));')];
    expect(limitWindows(files, new Set()).failures).toEqual([
      "x.ts: the window pollWindow(config, row) of d:code is not a window literal",
    ]);
    const dynamic = limitWindows(files, new Set(["d:code"]));
    expect(dynamic.failures).toEqual([]);
    expect(dynamic.facts).toEqual([{ family: "d:code", seconds: null, max: null, at: "x.ts" }]);
  });
});
