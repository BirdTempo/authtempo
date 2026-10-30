import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BETTER_AUTH_RANGE, inRange } from "../src/version.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../package.json")) as { authtempo?: { betterAuth?: unknown } };
const line = (range: string) => `Supported Better Auth versions: \`${range}\`.`;

describe("the supported Better Auth range (spec 33 item 1.6)", () => {
  it("holds the range in one value", () => {
    expect(manifest.authtempo?.betterAuth).toBe(BETTER_AUTH_RANGE);
    expect(read("../README.md").split("\n")).toContain(line(BETTER_AUTH_RANGE));
    const page = read("../../../apps/site/src/content/docs/docs/reference/compat-better-auth.md");
    expect(page.split("\n")).toContain(line(BETTER_AUTH_RANGE));
  });

  it("holds the fixed version inside the range", () => {
    // The CLI warns below BETTER_AUTH_FIXED. The compat package does not depend
    // on the CLI, so the test reads the source as text.
    const source = read("../../cli/src/better-auth-version.ts");
    const m = /export const BETTER_AUTH_FIXED[^=]*= \[(\d+), (\d+), (\d+)\];/.exec(source);
    expect(m).not.toBeNull();
    const fixed = [m?.[1], m?.[2], m?.[3]].map(Number);
    expect(fixed).toEqual([1, 7, 7]);
    expect(inRange(fixed.join("."), BETTER_AUTH_RANGE)).toBe(true);
  });

  it("starts the range at the fixed version of GHSA-965c-763c-88jm", () => {
    // Each version below 1.7.7 has the advisory (ruling 45 of plan 12j).
    expect(inRange("1.7.7", BETTER_AUTH_RANGE)).toBe(true);
    for (const v of ["1.7.0", "1.7.2", "1.7.5", "1.7.6"])
      expect([v, inRange(v, BETTER_AUTH_RANGE)]).toEqual([v, false]);
  });

  it("names the advisory and the rollback floor where it names the range", () => {
    const page = read("../../../apps/site/src/content/docs/docs/reference/compat-better-auth.md");
    // The affected range of the advisory record, the one source: "Affected
    // versions ">= 1.4.0-beta.18, < 1.7.7"" becomes `>=1.4.0-beta.18 <1.7.7`.
    // "below 1.7.7" named a wider range (ruling 64 of plan 12j, Minor 6).
    const record = read("../../../docs/security/advisories.md");
    const entry = record.slice(record.indexOf("GHSA-965c-763c-88jm"));
    const m = /Affected versions ">= ([^,"]+), < ([^"]+)"/.exec(entry);
    expect(m, "the affected range of GHSA-965c-763c-88jm in the advisory record").not.toBeNull();
    const affected = `>=${m?.[1]} <${m?.[2]}`;
    expect(affected).toBe(">=1.4.0-beta.18 <1.7.7");
    // A line break of the README may fall inside a sentence, so the test reads words.
    for (const text of [read("../README.md"), page]) {
      const words = text.split(/\s+/).join(" ");
      expect(words).toContain("GHSA-965c-763c-88jm");
      expect(words).toContain("the rollback system must run");
      expect(words).toContain("1.7.7 or later");
      expect(words).toContain(`Better Auth \`${affected}\``);
      expect(words).not.toContain("below 1.7.7 has the advisory");
      expect(words).not.toContain("Better Auth below 1.7.7");
    }
    // The pending changeset becomes a record of the compat changelog at the version branch.
    const changeset = new URL("../../../.changeset/compat-better-auth-range.md", import.meta.url);
    const changelog = new URL("../CHANGELOG.md", import.meta.url);
    const source = existsSync(changeset) ? changeset : changelog;
    expect(readFileSync(source, "utf8")).toContain(`Better Auth \`${affected}\``);
  });

  it("reads the range grammar", () => {
    expect(inRange("1.7.0", ">=1.7.0 <1.8.0")).toBe(true);
    expect(inRange("1.7.10", BETTER_AUTH_RANGE)).toBe(true);
    expect(inRange("1.8.0", BETTER_AUTH_RANGE)).toBe(false);
    expect(inRange("1.6.22", BETTER_AUTH_RANGE)).toBe(false);
    expect(inRange("1.7.7-beta.1", BETTER_AUTH_RANGE)).toBe(false);
    expect(inRange("1.7", BETTER_AUTH_RANGE)).toBe(false);
    expect(() => inRange("1.7.7", "^1.7.0")).toThrow();
    expect(() => inRange("1.7.7", ">=1.7.0")).toThrow();
  });

  it("refuses a leading zero, as Semantic Versioning does", () => {
    for (const v of ["01.7.7", "1.07.7", "1.7.07"])
      expect([v, inRange(v, BETTER_AUTH_RANGE)]).toEqual([v, false]);
    expect(inRange("1.7.10", BETTER_AUTH_RANGE)).toBe(true);
    expect(() => inRange("1.7.7", ">=01.7.7 <1.8.0")).toThrow(/not of the form/);
  });

  it("ignores a build part, as Semantic Versioning does", () => {
    expect(inRange("1.7.7+build.1", BETTER_AUTH_RANGE)).toBe(true);
    expect(inRange("1.7.9+sha.5114f85", BETTER_AUTH_RANGE)).toBe(true);
    expect(inRange("1.8.0+build.1", BETTER_AUTH_RANGE)).toBe(false);
    expect(inRange("1.7.6+build.1", BETTER_AUTH_RANGE)).toBe(false);
    // A build part keeps the prerelease rule, and an empty build part is no version.
    expect(inRange("1.7.7-beta.1+build.1", BETTER_AUTH_RANGE)).toBe(false);
    expect(inRange("1.7.7+", BETTER_AUTH_RANGE)).toBe(false);
  });

  it("throws on an empty range", () => {
    expect(() => inRange("1.7.7", ">=1.8.0 <1.7.0")).toThrow(/is empty/);
    expect(() => inRange("1.7.7", ">=1.7.7 <1.7.7")).toThrow(/is empty/);
    expect(inRange("1.7.7", ">=1.7.7 <1.7.8")).toBe(true);
  });
});
