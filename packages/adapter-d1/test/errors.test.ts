import { describe, expect, it } from "vitest";
import { toStorageError } from "../src/errors.js";

describe("toStorageError", () => {
  it("maps a UNIQUE constraint message to fields, with or without the D1 prefix", () => {
    const e = toStorageError(
      "user",
      new Error("D1_ERROR: UNIQUE constraint failed: ta_user.email: SQLITE_CONSTRAINT"),
    );
    expect(e).toMatchObject({
      name: "StorageError",
      code: "unique_violation",
      model: "user",
      fields: ["email"],
    });
    const pk = toStorageError("user", new Error("UNIQUE constraint failed: ta_user.id"));
    expect(pk?.fields).toEqual(["id"]);
    const composite = toStorageError(
      "identity",
      new Error(
        "D1_ERROR: UNIQUE constraint failed: ta_identity.provider, ta_identity.subject: SQLITE_CONSTRAINT",
      ),
    );
    expect(composite?.fields).toEqual(["provider", "subject"]);
  });
  it("returns null for any other error", () => {
    expect(toStorageError("user", new Error("D1_ERROR: no such table: ta_user"))).toBeNull();
    expect(toStorageError("user", "boom")).toBeNull();
  });
});
