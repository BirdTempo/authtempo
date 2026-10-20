import { describe, expect, it } from "vitest";
import { activeBan, bannedFor } from "../src/engine/operator/ban-rule.js";

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

describe("the ban window of a credential (ruling 28)", () => {
  it("ends a credential issued before the end of the last ban", () => {
    expect(bannedFor({ bannedAt: at(-60_000), banUntil: null }, at(-120_000))).toBe(true);
    expect(bannedFor({ bannedAt: at(-60_000), banUntil: null }, NOW)).toBe(true);
    // An unban or an end: a credential from before the end stays ended.
    expect(bannedFor({ bannedAt: at(-60_000), banUntil: NOW }, at(-1))).toBe(true);
  });

  it("passes a credential issued at or after the end, and each one of a user never banned", () => {
    expect(bannedFor({ bannedAt: at(-60_000), banUntil: NOW }, NOW)).toBe(false);
    expect(bannedFor({ bannedAt: at(-60_000), banUntil: NOW }, at(1))).toBe(false);
    expect(bannedFor({ bannedAt: null, banUntil: null }, at(-120_000))).toBe(false);
  });
});
