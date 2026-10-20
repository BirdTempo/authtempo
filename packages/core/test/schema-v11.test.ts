import { describe, expect, it } from "vitest";
import { sweepExpired } from "../src/engine/sweep.js";
import { SCHEMA_VERSION } from "../src/schema.js";
import { USER_CHILD_MODELS } from "../src/storage/sql.js";
import { makeAuth } from "./helpers.js";

// Schema version 11 (plan 12e Task 1). The new models' writes, reads, and
// unique keys are in the conformance suite, so every adapter runs them. The
// defaults of a version 10 row are in the D1 and Postgres schema-v11 tests.

describe("schema version 11 (plan 12e)", () => {
  it("names version 11 or a later version", () => {
    // Plan 12f moves the version to 12: operator-schema.test.ts pins it.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
  });

  it("joins the four new models to USER_CHILD_MODELS by the schema rule", () => {
    // Each has a userId field, so a user delete and a claim remove its rows.
    expect(USER_CHILD_MODELS).toEqual(
      expect.arrayContaining(["oauthDevice", "oauthSubject", "oauthSessionClient", "oauthLogout"]),
    );
  });

  it("names the new sweep keys", async () => {
    const result = await sweepExpired(makeAuth().config);
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(["oauthDevices", "oauthSessionLinks", "oauthLogouts"]),
    );
    expect(result).toMatchObject({ oauthDevices: 0, oauthSessionLinks: 0, oauthLogouts: 0 });
  });
});
