import { describe, expect, it } from "vitest";
import { toStorageError } from "../src/errors.js";

function pgError(code: string, constraint_name?: string): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code,
    constraint_name,
  });
}

describe("toStorageError", () => {
  it("maps 23505 by constraint name to fields (Review Focus 4)", () => {
    expect(toStorageError("user", pgError("23505", "ux_ta_user__email"))).toMatchObject({
      name: "StorageError",
      code: "unique_violation",
      model: "user",
      fields: ["email"],
    });
    expect(toStorageError("user", pgError("23505", "ta_user_pkey"))?.fields).toEqual(["id"]);
    expect(
      toStorageError("identity", pgError("23505", "ux_ta_identity__provider__subject"))?.fields,
    ).toEqual(["provider", "subject"]);
    expect(
      toStorageError("session", pgError("23505", "ux_ta_session__token_hash"))?.fields,
    ).toEqual(["tokenHash"]);
  });
  it("maps an unknown unique constraint to an empty field list and other codes to null", () => {
    expect(toStorageError("user", pgError("23505", "weird"))?.fields).toEqual([]);
    expect(toStorageError("user", pgError("42P01"))).toBeNull();
    expect(toStorageError("user", new Error("x"))).toBeNull();
  });
});
