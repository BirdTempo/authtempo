import { describe, expect, it } from "vitest";
import { SCIM_ERRORS } from "../../src/errors.js";

describe("SCIM_ERRORS (plan 12d Task 9, RFC 7644 section 3.12)", () => {
  it("gives each scimType its status", () => {
    // The literals, not the constant: a change of one status must fail here.
    expect(SCIM_ERRORS).toEqual({
      invalidFilter: 400,
      tooMany: 400,
      uniqueness: 409,
      mutability: 400,
      invalidSyntax: 400,
      invalidPath: 400,
      noTarget: 400,
      invalidValue: 400,
      invalidVers: 400,
      sensitive: 403,
    });
  });
});
