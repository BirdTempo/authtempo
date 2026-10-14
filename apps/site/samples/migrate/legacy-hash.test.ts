import { importUsers, supabaseSource } from "@authtempo/import";
import { VECTORS } from "@authtempo/legacy-hashes/testing";
import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createImportedAuth } from "./legacy-hash.ts";

// One Supabase user with a bcrypt hash, as the two selects of the import README write them.
const USERS = [
  "id,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,is_anonymous,deleted_at,banned_until,is_sso_user",
  `11111111-1111-4111-8111-111111111111,ada@example.com,${VECTORS.bcrypt2a.stored},2026-01-02 03:04:05+00,{},2026-01-01 00:00:00+00,f,,,f`,
].join("\n");
const IDENTITIES = "provider,provider_id,user_id\n";

describe("move users with their password hashes", () => {
  it("signs an imported user in with the old password and rewrites the hash as PBKDF2", async () => {
    const h = harness();
    const report = await importUsers(
      h.storage,
      supabaseSource({ users: USERS, identities: IDENTITIES }),
      {
        formats: ["bcrypt"],
      },
    );
    expect({ passwords: report.created.password, refused: report.refusedHashes }).toEqual({
      passwords: 1,
      refused: [],
    });

    const auth = createImportedAuth(h, ["bcrypt"]);
    const signIn = (password: string) =>
      call(auth, "POST", "/auth/password/sign-in", { email: "ada@example.com", password });
    expect((await signIn(VECTORS.bcrypt2a.wrong)).status).toBe(401);
    const first = await signIn(VECTORS.bcrypt2a.password);
    expect(first.status).toBe(200);
    const { user } = (await first.json()) as { user: { id: string } };
    const row = await h.storage.findOne("password", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(row?.hash.startsWith("pbkdf2-sha256$")).toBe(true);
    expect((await signIn(VECTORS.bcrypt2a.password)).status).toBe(200);
  });

  it("refuses a hash in a format that --formats does not name, and imports the user with no password", async () => {
    const h = harness();
    const report = await importUsers(
      h.storage,
      supabaseSource({ users: USERS, identities: IDENTITIES }),
      {
        formats: [],
      },
    );
    expect({ passwords: report.created.password, users: report.created.user }).toEqual({
      passwords: 0,
      users: 1,
    });
    expect(report.refusedHashes.map((r) => r.format)).toEqual(["bcrypt"]);
  });
});
