import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkGuides, defaultToday, entry, MAX_AGE_DAYS } from "../src/check-guides.ts";
import { summaryLine } from "../src/lib/report.ts";

// The check takes its date by argument, so no test here reads the real clock.
const TODAY = "2027-03-01";

/** The day `days` before TODAY, YYYY-MM-DD. */
const ago = (days: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

const guide = (id: string, days: number) => ({ id, checkedOn: ago(days) });

describe("check-guides: the age of each guide", () => {
  it("passes guides that are 10 days old", () => {
    const r = checkGuides([guide("okta", 10), guide("entra", 10)], TODAY);
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe("check-guides: PASS guides=2 failures=0");
  });

  it("fails a guide that is 181 days old, and names it", () => {
    const r = checkGuides([guide("okta", 10), guide("entra", 181)], TODAY);
    expect(r.failures).toEqual([
      `entra: checkedOn ${ago(181)} is 181 days before ${TODAY}; a guide is checked again within ${MAX_AGE_DAYS} days`,
    ]);
    expect(summaryLine(r)).toBe("check-guides: FAIL guides=2 failures=1");
  });

  it("passes a guide that is exactly 180 days old", () => {
    expect(MAX_AGE_DAYS).toBe(180);
    expect(checkGuides([guide("okta", 180)], TODAY).failures).toEqual([]);
  });

  it("gives the same result for the same date, whatever the real date is", () => {
    const guides = [guide("okta", 181), guide("entra", 10)];
    const results = ["2020-01-01", "2090-06-15"].map((real) => {
      vi.useFakeTimers({ now: new Date(`${real}T00:00:00Z`) });
      try {
        return checkGuides(guides, TODAY);
      } finally {
        vi.useRealTimers();
      }
    });
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.failures).toHaveLength(1);
    // One day later, a guide of 180 days is 181 days old.
    expect(checkGuides([guide("okta", 180)], "2027-03-02").failures).toHaveLength(1);
  });

  it("fails a date that is not a real day, and a check that read no guide", () => {
    expect(checkGuides([{ id: "okta", checkedOn: "2027-02-30" }], TODAY).failures).toEqual([
      "okta: checkedOn 2027-02-30 is not a real date YYYY-MM-DD",
    ]);
    expect(checkGuides([], TODAY).failures).toEqual(["read 0 guides"]);
  });

  it("fails a missing date and a date of another format", () => {
    const bad = [
      { id: "okta", checkedOn: undefined as unknown as string },
      { id: "entra", checkedOn: "2027/02/01" },
      { id: "generic-saml", checkedOn: "2027-2-1" },
    ];
    expect(checkGuides(bad, TODAY).failures).toEqual([
      "okta: checkedOn undefined is not a real date YYYY-MM-DD",
      "entra: checkedOn 2027/02/01 is not a real date YYYY-MM-DD",
      "generic-saml: checkedOn 2027-2-1 is not a real date YYYY-MM-DD",
    ]);
  });

  it("fails a date after the check date, and passes the check date itself", () => {
    expect(checkGuides([{ id: "okta", checkedOn: "2072-01-10" }], TODAY).failures).toEqual([
      `okta: checkedOn 2072-01-10 is after ${TODAY}; a guide is not checked in the future`,
    ]);
    expect(checkGuides([{ id: "okta", checkedOn: "2027-03-02" }], TODAY).failures).toHaveLength(1);
    expect(checkGuides([guide("okta", 0)], TODAY).failures).toEqual([]);
  });

  it("takes the UTC+14 date as the default, so a guide of the owner's morning passes", () => {
    // 2027-03-01 22:00 UTC is already 2027-03-02 at UTC+8 and UTC+14.
    const now = new Date("2027-03-01T22:00:00Z");
    expect(now.toISOString().slice(0, 10)).toBe("2027-03-01");
    const today = defaultToday(now);
    expect(today).toBe("2027-03-02");
    expect(checkGuides([{ id: "okta", checkedOn: "2027-03-02" }], today).failures).toEqual([]);
    // Before 10:00 UTC the UTC+14 date is still the UTC date.
    expect(defaultToday(new Date("2027-03-01T09:59:59Z"))).toBe("2027-03-01");
    expect(defaultToday(new Date("2027-03-01T10:00:00Z"))).toBe("2027-03-02");
  });

  it("names a bad date argument once, not each guide", () => {
    const r = checkGuides([guide("okta", 10), guide("entra", 10)], "2027-3-1");
    expect(r.failures).toEqual(["the date 2027-3-1 is not a real date YYYY-MM-DD"]);
    expect(summaryLine(r)).toBe("check-guides: FAIL guides=2 failures=1");
  });
});

describe("check-guides: the built core", () => {
  /** A tree with the guide source and a built module of `guides`, and the times of both. */
  function tree(srcSeconds: number, distSeconds: number, guides: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "authtempo-check-guides-"));
    const src = join(root, "packages/core/src/sso/guides/index.ts");
    const dist = join(root, "packages/core/dist/sso/guides/index.js");
    mkdirSync(join(src, ".."), { recursive: true });
    mkdirSync(join(dist, ".."), { recursive: true });
    writeFileSync(src, "export {};\n");
    writeFileSync(dist, `export const GUIDES = ${JSON.stringify(guides)};\n`);
    utimesSync(src, srcSeconds, srcSeconds);
    utimesSync(dist, distSeconds, distSeconds);
    return root;
  }

  it("reads GUIDES from dist and passes fresh guides", async () => {
    const root = tree(1000, 2000, [guide("okta", 10)]);
    try {
      const { lines, code } = await entry(root, TODAY);
      expect(lines).toEqual(["check-guides: PASS guides=1 failures=0"]);
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 1 for a stale guide of the built core", async () => {
    const root = tree(1000, 2000, [guide("okta", 181)]);
    try {
      const { lines, code } = await entry(root, TODAY);
      expect(lines[0]).toBe("check-guides: FAIL guides=1 failures=1");
      expect(lines[1]).toContain("okta");
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 1 when dist is older than the guide source (the build is older than the change)", async () => {
    const root = tree(2000, 1000, [guide("okta", 10)]);
    try {
      const { lines, code } = await entry(root, TODAY);
      expect(lines).toEqual([
        "check-guides: FAIL guides=0 failures=2",
        "  packages/core/dist/sso/guides/index.js is older than packages/core/src/sso/guides/index.ts; the build is older than the change",
        "  read 0 guides",
      ]);
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 1 when the built module exports no GUIDES list", async () => {
    for (const text of ["export const OTHER = [];\n", "export const GUIDES = 5;\n"]) {
      const root = tree(1000, 2000, []);
      writeFileSync(join(root, "packages/core/dist/sso/guides/index.js"), text);
      try {
        const { lines, code } = await entry(root, TODAY);
        expect(lines[1]).toBe("  packages/core/dist/sso/guides/index.js exports no GUIDES list");
        expect(code).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("exits 1 when the guide source folder is gone (the compare cannot run)", async () => {
    const root = tree(1000, 2000, [guide("okta", 10)]);
    rmSync(join(root, "packages/core/src"), { recursive: true });
    try {
      const { lines, code } = await entry(root, TODAY);
      expect(lines[1]).toBe(
        "  packages/core/src/sso/guides holds no .ts file; the build cannot be compared with the change",
      );
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 1 when dist has no guide module (the build did not run)", async () => {
    const root = tree(1000, 2000, []);
    rmSync(join(root, "packages/core/dist"), { recursive: true });
    try {
      const { lines, code } = await entry(root, TODAY);
      expect(lines[1]).toBe(
        "  packages/core/dist/sso/guides/index.js does not exist; the build did not run",
      );
      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
