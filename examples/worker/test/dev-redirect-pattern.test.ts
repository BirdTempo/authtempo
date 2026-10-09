import { expect, it } from "vitest";
import { devRedirectPattern } from "../src/dev-redirect.js";

it("keeps an anchored DEV_REDIRECT_PATTERN and logs nothing", () => {
  const lines: string[] = [];
  const pattern = devRedirectPattern("^exp://192\\.168\\.1\\.20:8081/--/auth$", (l) =>
    lines.push(l),
  );
  expect(pattern?.test("exp://192.168.1.20:8081/--/auth")).toBe(true);
  expect(pattern?.test("exp://evil/?x=exp://192.168.1.20:8081/--/auth")).toBe(false);
  expect(lines).toEqual([]);
});

it("refuses an unanchored DEV_REDIRECT_PATTERN with one log line and sets no pattern", () => {
  for (const source of [
    "exp://192\\.168\\.1\\.20:8081/--/auth",
    "^exp://192\\.168\\.1\\.20:8081/--/auth",
    "exp://192\\.168\\.1\\.20:8081/--/auth$",
  ]) {
    const lines: string[] = [];
    expect(devRedirectPattern(source, (l) => lines.push(l))).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("DEV_REDIRECT_PATTERN refused");
  }
});

it("sets no pattern and logs nothing when DEV_REDIRECT_PATTERN is unset", () => {
  const lines: string[] = [];
  expect(devRedirectPattern(undefined, (l) => lines.push(l))).toBeUndefined();
  expect(lines).toEqual([]);
});
