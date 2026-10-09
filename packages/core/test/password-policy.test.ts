import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_LENGTH, passwordPolicyError } from "../src/engine/password-policy.js";
import { ERRORS } from "../src/errors.js";

const EMAIL = "ada@example.com";

describe("passwordPolicyError", () => {
  it("bounds the length in code points, from minLength to 128, with no trimming", () => {
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    expect(passwordPolicyError("a".repeat(7), EMAIL, 8)).toBe("password_policy");
    expect(passwordPolicyError("a".repeat(8), EMAIL, 8)).toBeNull();
    expect(passwordPolicyError(" abcdefg", EMAIL, 8)).toBeNull();
    expect(passwordPolicyError("a".repeat(11), EMAIL, 12)).toBe("password_policy");
    expect(passwordPolicyError("a".repeat(128), EMAIL, 8)).toBeNull();
    expect(passwordPolicyError("a".repeat(129), EMAIL, 8)).toBe("password_policy");
    // 128 code points are 256 UTF-16 units; the count is in code points.
    expect(passwordPolicyError("\u{1F600}".repeat(128), EMAIL, 8)).toBeNull();
    expect(passwordPolicyError("\u{1F600}".repeat(129), EMAIL, 8)).toBe("password_policy");
  });

  it("refuses a control character", () => {
    expect(passwordPolicyError("abcdefgh\u0000", EMAIL, 8)).toBe("password_policy");
    expect(passwordPolicyError("abcdefgh\n", EMAIL, 8)).toBe("password_policy");
    expect(passwordPolicyError("abcdefgh\u007f", EMAIL, 8)).toBe("password_policy");
  });

  it("refuses the email in any case, and accepts a longer text that holds it", () => {
    expect(passwordPolicyError("ada@example.com", EMAIL, 8)).toBe("password_policy");
    expect(passwordPolicyError("ADA@EXAMPLE.COM", EMAIL, 8)).toBe("password_policy");
    expect(passwordPolicyError("ada@example.com1", EMAIL, 8)).toBeNull();
  });
});

describe("plan 8 error codes", () => {
  it("adds four codes with their statuses", () => {
    expect(ERRORS).toMatchObject({
      invalid_credentials: 401,
      password_policy: 400,
      password_breached: 400,
      email_taken: 409,
      email_taken_unverified: 409,
    });
  });
});
