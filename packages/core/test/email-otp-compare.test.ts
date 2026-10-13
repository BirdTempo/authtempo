import { describe, expect, it, vi } from "vitest";
import { requestEmailOtp, verifyEmailOtp } from "../src/engine/email-otp.js";
import { constantTimeEqual } from "../src/primitives/crypto.js";
import { makeAuth } from "./helpers.js";

// The compare is constantTimeEqual by construction (plan 9e). A file of its
// own, because vi.mock replaces the module for the whole file.
vi.mock("../src/primitives/crypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/primitives/crypto.js")>();
  return { ...actual, constantTimeEqual: vi.fn(actual.constantTimeEqual) };
});

describe("the code compare (plan 9e)", () => {
  it("compares through constantTimeEqual once per verify: a wrong code, an address with no code, and a right code", async () => {
    const auth = makeAuth();
    await requestEmailOtp(auth.config, { email: "ada@example.com", ip: null });
    const code = /\b(\d{6})\b/.exec(auth.mail[0]?.text ?? "")?.[1] ?? "";
    const [row] = await auth.storage.findMany("verification", []);
    const compare = vi.mocked(constantTimeEqual);
    compare.mockClear();
    const v = (email: string, c: string) =>
      verifyEmailOtp(auth.config, { email, code: c, ip: null, userAgent: null });
    await v("ada@example.com", code === "000000" ? "111111" : "000000");
    await v("nobody@example.com", "123456");
    expect((await v("ada@example.com", code)).ok).toBe(true);
    const hex = expect.stringMatching(/^[0-9a-f]{64}$/);
    expect(compare.mock.calls).toEqual([
      [hex, row?.valueHash],
      [hex, "0".repeat(64)],
      [hex, row?.valueHash],
    ]);
  });
});
