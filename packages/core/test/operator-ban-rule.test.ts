import { describe, expect, it } from "vitest";
import { activeBan } from "../src/engine/operator/ban-rule.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe("the ban rule (plan 12f, ruling 11)", () => {
  it("holds a ban with no end, or with an end after now", () => {
    expect(activeBan({ bannedAt: at(-60_000), banUntil: null }, NOW)).toBe(true);
    expect(activeBan({ bannedAt: at(-60_000), banUntil: at(1) }, NOW)).toBe(true);
  });

  it("reads no ban, and a ban that ended at or before now, as no ban", () => {
    expect(activeBan({ bannedAt: null, banUntil: null }, NOW)).toBe(false);
    // The end is not inside the ban: at banUntil the user signs in again.
    expect(activeBan({ bannedAt: at(-60_000), banUntil: NOW }, NOW)).toBe(false);
    expect(activeBan({ bannedAt: at(-60_000), banUntil: at(-1) }, NOW)).toBe(false);
  });
});
