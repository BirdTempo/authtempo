import { expect, it } from "vitest";
import { CAPTURE_MAX, rememberCode } from "../src/test-capture.js";

it("keeps at most 100 addresses, drops the oldest write first, and moves a rewritten address to the newest place (plan 9h)", () => {
  expect(CAPTURE_MAX).toBe(100);
  const codes = new Map<string, string>();
  for (let i = 0; i < CAPTURE_MAX; i++)
    rememberCode(codes, `a${i}@example.com`, String(100000 + i));
  expect(codes.size).toBe(100);
  // A new code for the oldest address moves it to the newest place, so the next drop takes a1.
  rememberCode(codes, "a0@example.com", "222222");
  rememberCode(codes, "new@example.com", "333333");
  expect(codes.size).toBe(100);
  expect(codes.get("a0@example.com")).toBe("222222");
  expect(codes.has("a1@example.com")).toBe(false);
  expect([...codes.keys()].at(-1)).toBe("new@example.com");
  // A mail with no code forgets the address, as the capture did before plan 9h.
  rememberCode(codes, "new@example.com", null);
  expect(codes.has("new@example.com")).toBe(false);
  expect(codes.size).toBe(99);
});
