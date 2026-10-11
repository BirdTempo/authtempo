import { env, SELF } from "cloudflare:test";
import { createD1Adapter } from "@tempo-auth/adapter-d1";
import { importUsers, supabaseSource } from "@tempo-auth/import";
import { expect, it } from "vitest";
import identities from "../../../packages/import/test/fixtures/supabase-identities.csv?raw";
import users from "../../../packages/import/test/fixtures/supabase-users.csv?raw";
import { LEGACY_FORMATS } from "../src/legacy-formats.js";

const BASE = "https://example.test";
// Ada's row in the fixture: the Go x/crypto/bcrypt test vector for "allmine".
const ADA_BCRYPT = "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga";

// Every row of every ta_ table, so the second import can prove that it wrote nothing.
async function snapshot(): Promise<Record<string, unknown[]>> {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ta\\_%' ESCAPE '\\' ORDER BY name",
  ).all<{ name: string }>();
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables.results)
    out[name] = (await env.DB.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results;
  return out;
}

// Plan 9b end to end: a Supabase export into the example Worker's D1, a sign-in
// with the user's old bcrypt password ("allmine"), and the rehash to PBKDF2 on
// that first sign-in.
it("imports a Supabase export on D1, signs in with the bcrypt password, and rehashes to PBKDF2", async () => {
  const run = () =>
    importUsers(createD1Adapter(env.DB), supabaseSource({ users, identities }), {
      // The formats the Worker chains, so the import refuses a hash it cannot verify.
      formats: LEGACY_FORMATS,
    });
  // The fixture: 12 users. Skipped: anonymous, deleted, two banned (2099 and
  // infinity), one SSO. Written: 7. Passwords: Ada and Bob (bcrypt). The fbscrypt
  // and argon2i rows are refused, so those users have no password. Identities:
  // an email identity for each of the 6 verified users, Ada's google, and
  // twogoogle's two; Bob's github is dropped.
  const report = await run();
  expect(report).toMatchObject({
    created: { user: 7, identity: 9, password: 2, passkey: 0, organization: 0, member: 0 },
    exists: { user: 0, organization: 0 },
    refusals: 0,
    partial: [],
  });
  expect(report.skipped.map((s) => s.reason)).toEqual([
    "anonymous",
    "deleted",
    "banned",
    "banned",
    "sso_user",
  ]);
  expect(report.refusedHashes.map((r) => r.sourceId)).toEqual([
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
  ]);

  const hashOf = async () =>
    env.DB.prepare(
      `SELECT p.hash AS hash FROM ta_password p JOIN ta_user u ON u.id = p.user_id WHERE u.email = 'ada@example.com'`,
    ).first<string>("hash");
  // The import writes the export's bcrypt string as it is.
  expect(await hashOf()).toBe(ADA_BCRYPT);

  const signIn = (password: string) =>
    SELF.fetch(`${BASE}/auth/password/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: "ada@example.com", password }),
    });
  // A wrong password fails on the bcrypt row and writes nothing.
  const wrong = await signIn("allminE");
  expect(wrong.status).toBe(401);
  expect(await hashOf()).toBe(ADA_BCRYPT);

  const right = await signIn("allmine");
  expect(right.status).toBe(200);
  const cookie = right.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/tempo_session=/);
  // The first sign-in writes PBKDF2 (1000 iterations in TEST_MODE) over the bcrypt row.
  const rehashed = await hashOf();
  expect(rehashed).toMatch(/^pbkdf2-sha256\$1000\$/);
  const me = await SELF.fetch(`${BASE}/me`, { headers: { cookie: cookie.split(";")[0] ?? "" } });
  expect(await me.json()).toMatchObject({ email: "ada@example.com" });

  // A wrong password fails on the PBKDF2 row too and writes nothing.
  expect((await signIn("allminE")).status).toBe(401);
  expect(await hashOf()).toBe(rehashed);
  // The second sign-in verifies the PBKDF2 row and does not hash again.
  expect((await signIn("allmine")).status).toBe(200);
  expect(await hashOf()).toBe(rehashed);

  // A second import of the same export finds every user and writes nothing:
  // the PBKDF2 row stays, and the bcrypt string does not come back.
  const before = await snapshot();
  const again = await run();
  expect(again).toMatchObject({
    created: { user: 0, identity: 0, password: 0, passkey: 0, organization: 0, member: 0 },
    exists: { user: 7, organization: 0 },
    refusals: 0,
    partial: [],
  });
  expect(await snapshot()).toEqual(before);
  expect(await hashOf()).toBe(rehashed);
  expect((await signIn("allmine")).status).toBe(200);
});
