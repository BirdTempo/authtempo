import { type AuthConfig, createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import type { Sql } from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { betterAuthSchemaStorage } from "../src/storage/index.js";
import { issuerFor } from "../src/storage/mapping.js";
import { BETTER_AUTH_PG } from "./fixtures.js";
import { freshBetterAuthSchema } from "./pg.js";

// The last-credential guard of plan 12a on Better Auth's tables. Core's own
// writers give a user with no proved address one way in at most. The passkey
// register needs a verified address, and so does a provider link. The
// importer keeps one credential. Better Auth 1.7 has no such rule: an
// unverified user can hold a password, a passkey, and several providers.
// So these rows, as Better Auth writes them, are the state where a removal
// can take the last way in. Each test inserts them before the migration.

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
const RP = { rpID: "api.example.com", rpName: "Example", origins: [BASE] };
const AT = "2026-09-01T00:00:00.000Z";
// A Better Auth scrypt hash; the guard reads the row, never the hash.
const BA_HASH =
  "8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3";

/** A Better Auth user who never proved the address, with a Google account. */
function eraUser(id: string, extra: { password?: boolean; passkey?: boolean; github?: boolean }) {
  const rows = [
    `INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES ('${id}','Bea','${id}@example.com',false,NULL,'${AT}','${AT}');`,
    `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('${id}-google','${issuerFor("google")}','g-${id}','google','${id}',NULL,'${AT}','${AT}');`,
  ];
  if (extra.password)
    rows.push(
      `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('${id}-cred','${issuerFor("credential")}','${id}','credential','${id}','${BA_HASH}','${AT}','${AT}');`,
    );
  if (extra.github)
    rows.push(
      `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('${id}-github','${issuerFor("github")}','gh-${id}','github','${id}',NULL,'${AT}','${AT}');`,
    );
  if (extra.passkey)
    rows.push(
      `INSERT INTO "passkey" ("id","name","publicKey","userId","credentialID","counter","deviceType","backedUp","transports","createdAt","aaguid") VALUES ('${id}-pk','Laptop','+/+/AQ==','${id}','cred-${id}',0,'singleDevice',false,'',NULL,NULL);`,
    );
  return rows.join("\n");
}

let pg: { sql: Sql; close(): Promise<void> };
afterEach(async () => {
  await pg.close();
});

async function tables(rows: string) {
  pg = await freshBetterAuthSchema(BETTER_AUTH_PG);
  await pg.sql.unsafe(rows);
  const s = betterAuthSchemaStorage({ dialect: "postgres", sql: pg.sql });
  await s.migrate();
  return s.storage;
}

function authOn(
  storage: AuthConfig["storage"],
  extra: Partial<AuthConfig> = {},
  off: ("passkey" | "password")[] = [],
) {
  // The claims of the next Google callback. The seam answers them for any token.
  let claims: Record<string, unknown> = {};
  const auth = createAuth({
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [],
    storage,
    // Every request passes: the guard, not the limit, is under test.
    limiter: { allow: async () => true },
    mail: { send: async () => {} },
    ...(off.includes("passkey") ? {} : { passkey: RP }),
    ...(off.includes("password")
      ? {}
      : { password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) } }),
    social: {
      google: { clientId: "gid", clientSecret: "gsecret" },
      fetch: async () => Response.json({ id_token: "t", access_token: "at", token_type: "Bearer" }),
    },
    jwt: { verifyIdToken: async () => claims, signES256: async () => "unused" },
    ...extra,
  });
  /** A Google sign-in of the era user: the identity branch opens a session of the unverified user. */
  async function signIn(id: string) {
    const started = await auth.api.startSocial({ provider: "google", next: "/home", ip: null });
    if (!started.ok) throw new Error(started.code);
    const url = new URL(started.value.location);
    claims = {
      sub: `g-${id}`,
      email: `${id}@example.com`,
      email_verified: false,
      nonce: url.searchParams.get("nonce"),
    };
    const done = await auth.api.completeSocial({
      provider: "google",
      state: url.searchParams.get("state"),
      code: "c",
      error: null,
      bindToken: started.value.bindToken,
      ip: null,
      userAgent: null,
    });
    if (!done.ok) throw new Error(done.code);
    if (!("token" in done.value)) throw new Error("the sign-in answered a challenge");
    const s = await auth.api.getSession(done.value.token);
    if (!s) throw new Error("no session");
    expect(s.user.emailVerified).toBe(false);
    return s;
  }
  return { auth, signIn };
}

async function googleOf(storage: AuthConfig["storage"], userId: string) {
  const row = await storage.findOne("identity", [
    { field: "userId", op: "eq", value: userId },
    { field: "provider", op: "eq", value: "google" },
  ]);
  if (!row) throw new Error("no google identity");
  return row.id;
}

describe("the last-credential guard on Better Auth rows (plan 12a Task 9)", () => {
  it("two parallel removals of an unverified user's two ways in, a delay sweep: one passes, and a way in stays", async () => {
    const rounds = 12;
    const ids = Array.from({ length: rounds }, (_, i) => `race${i}`);
    const storage = await tables(ids.map((id) => eraUser(id, { passkey: true })).join("\n"));
    const { auth, signIn } = authOn(storage);
    for (const [delay, id] of ids.entries()) {
      const me = await signIn(id);
      const identity = await googleOf(storage, me.user.id);
      const answers = await Promise.all([
        auth.api.identities.unlink({ session: me, id: identity, ip: null, userAgent: null }),
        new Promise<Awaited<ReturnType<typeof auth.api.deletePasskey>>>((done, failed) => {
          setTimeout(
            () => auth.api.deletePasskey({ user: me.user, id: `${id}-pk` }).then(done, failed),
            delay >> 1,
          );
        }),
      ]);
      // On Postgres the loser waits for the lock, reads the row again, and
      // its recount sees the first removal: always last_credential.
      expect(answers.map((a) => (a.ok ? "ok" : a.code)).sort()).toEqual(["last_credential", "ok"]);
      const identities =
        await pg.sql`SELECT id FROM "account" WHERE "userId" = ${id} AND "providerId" = 'google'`;
      const passkeys = await pg.sql`SELECT id FROM "passkey" WHERE "userId" = ${id}`;
      expect(identities.length + passkeys.length).toBe(1);
    }
  }, 60_000);

  it("counts a passkey: the unlink passes, then the delete of the passkey answers last_credential", async () => {
    const storage = await tables(eraUser("pk", { passkey: true }));
    const { auth, signIn } = authOn(storage);
    const me = await signIn("pk");
    const identity = await googleOf(storage, me.user.id);
    expect(
      await auth.api.identities.unlink({ session: me, id: identity, ip: null, userAgent: null }),
    ).toEqual({ ok: true, value: { ok: true } });
    expect(await auth.api.deletePasskey({ user: me.user, id: "pk-pk" })).toEqual({
      ok: false,
      code: "last_credential",
      status: 409,
    });
    expect(
      await storage.findOne("passkey", [{ field: "id", op: "eq", value: "pk-pk" }]),
    ).not.toBeNull();
  });

  it("counts no passkey with no passkey config", async () => {
    const storage = await tables(eraUser("nopk", { passkey: true }));
    const { auth, signIn } = authOn(storage, {}, ["passkey"]);
    const me = await signIn("nopk");
    const identity = await googleOf(storage, me.user.id);
    const listed = await auth.api.identities.list({ session: me });
    expect(listed.ok && [listed.value.passkeys, listed.value.identities[0]?.canUnlink]).toEqual([
      0,
      false,
    ]);
    expect(
      await auth.api.identities.unlink({ session: me, id: identity, ip: null, userAgent: null }),
    ).toMatchObject({ code: "last_credential" });
  });

  it("counts a Better Auth password with a password config, and none without it", async () => {
    const storage = await tables(
      `${eraUser("pw", { password: true })}\n${eraUser("nopw", { password: true })}`,
    );
    const on = authOn(storage);
    const me = await on.signIn("pw");
    const listed = await on.auth.api.identities.list({ session: me });
    expect(listed.ok && [listed.value.password, listed.value.identities[0]?.canUnlink]).toEqual([
      true,
      true,
    ]);
    expect(
      await on.auth.api.identities.unlink({
        session: me,
        id: await googleOf(storage, me.user.id),
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: true, value: { ok: true } });
    const off = authOn(storage, {}, ["password"]);
    const other = await off.signIn("nopw");
    expect(
      await off.auth.api.identities.unlink({
        session: other,
        id: await googleOf(storage, other.user.id),
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ code: "last_credential" });
  });

  it("counts a provider only while the config names it", async () => {
    const storage = await tables(
      `${eraUser("gh", { github: true })}\n${eraUser("nogh", { github: true })}`,
    );
    const googleOnly = authOn(storage);
    const me = await googleOnly.signIn("nogh");
    expect(
      await googleOnly.auth.api.identities.unlink({
        session: me,
        id: await googleOf(storage, me.user.id),
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ code: "last_credential" });
    const both = authOn(storage, {
      social: {
        google: { clientId: "gid", clientSecret: "gsecret" },
        github: { clientId: "ghid", clientSecret: "ghsecret" },
        fetch: async () =>
          Response.json({ id_token: "t", access_token: "at", token_type: "Bearer" }),
      },
    });
    const other = await both.signIn("gh");
    expect(
      await both.auth.api.identities.unlink({
        session: other,
        id: await googleOf(storage, other.user.id),
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: true, value: { ok: true } });
  });
});

describe("the guard's lock on a Better Auth user with no name (plan 12a Task 9)", () => {
  it("takes the lock on a row whose name Better Auth stores as empty text", async () => {
    const storage = await tables(eraUser("noname", { passkey: true }).replace("'Bea'", "''"));
    const { auth, signIn } = authOn(storage);
    const me = await signIn("noname");
    expect(me.user.name).toBeNull();
    expect(
      await auth.api.identities.unlink({
        session: me,
        id: await googleOf(storage, me.user.id),
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: true, value: { ok: true } });
  });
});
