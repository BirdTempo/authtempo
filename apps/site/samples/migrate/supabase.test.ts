import { readFileSync } from "node:fs";
import { importUsers, readSource } from "@authtempo/import";
import { FIXTURE_EXPORTS } from "@authtempo/import/testing";
import { VECTORS } from "@authtempo/legacy-hashes/testing";
import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createSupabaseAuth, SUPABASE_FORMATS } from "./supabase.ts";

// The fixture export of the Supabase reader: Ada with the bcrypt2a vector, Bob with argon2id.
const f = FIXTURE_EXPORTS.supabase;
const GUIDE = new URL("../../src/content/docs/docs/migrate/supabase.mdx", import.meta.url);

describe("move users from Supabase Auth", () => {
  it("signs an imported user in with the old password and rewrites the hash as PBKDF2", async () => {
    const h = harness();
    const report = await importUsers(h.storage, await readSource(f.bundle), {
      formats: SUPABASE_FORMATS,
    });
    expect({ passwords: report.created.password, refused: report.refusedHashes }).toEqual({
      passwords: 2,
      refused: [],
    });
    if (f.signIn === null) throw new Error("the fixture names no user that signs in");
    const { email, password } = f.signIn;

    const auth = createSupabaseAuth(h);
    const signIn = (p: string) =>
      call(auth, "POST", "/auth/password/sign-in", { email, password: p });
    expect((await signIn(VECTORS.bcrypt2a.wrong)).status).toBe(401);
    const first = await signIn(password);
    expect(first.status).toBe(200);
    const { user } = (await first.json()) as { user: { id: string } };
    const row = await h.storage.findOne("password", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(row?.hash.startsWith("pbkdf2-sha256$")).toBe(true);
    expect((await signIn(password)).status).toBe(200);

    // Bob proves the argon2id half of the seam.
    const signInBob = (p: string) =>
      call(auth, "POST", "/auth/password/sign-in", { email: "bob@example.com", password: p });
    expect((await signInBob(VECTORS.argon2id.wrong)).status).toBe(401);
    const bob = await signInBob(VECTORS.argon2id.password);
    expect(bob.status).toBe(200);
    const { user: bobUser } = (await bob.json()) as { user: { id: string } };
    const bobRow = await h.storage.findOne("password", [
      { field: "userId", op: "eq", value: bobUser.id },
    ]);
    expect(bobRow?.hash.startsWith("pbkdf2-sha256$")).toBe(true);
  });

  it("uses the formats of the fixture", () => {
    expect(SUPABASE_FORMATS).toEqual(f.formats);
  });

  it("gives the guide the formats of this sample", () => {
    const guide = readFileSync(GUIDE, "utf8");
    const flags = [...guide.matchAll(/--formats (\S+)/g)].map((m) => m[1]);
    expect(flags.length).toBeGreaterThan(0);
    for (const list of flags) expect(list).toBe(SUPABASE_FORMATS.join(","));
    const arrays = [...guide.matchAll(/`(\["[^`]*\])`/g)].map((m) => m[1]);
    for (const a of arrays) expect(a).toBe(JSON.stringify(SUPABASE_FORMATS).replaceAll(",", ", "));
  });
});
