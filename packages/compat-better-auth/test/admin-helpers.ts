import { createPbkdf2PasswordHash } from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { betterAuthPasswordHash } from "../src/hash.js";
import { admin, organization, twoFactor } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { COOKIE_NAME } from "../src/server/shapes.js";
import { issuerFor } from "../src/storage/mapping.js";
import type { BetterAuthPlugin, CompatDatabase } from "../src/types.js";

// The app of the admin plugin tests of plan 12f Task 13, on any compat
// database: the memory adapter, Postgres, and D1.

const BASE = "https://api.example.com";
const fast = betterAuthPasswordHash({ pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }) });
export const PASSWORD = "correct horse battery";
export const OPERATOR = "op@example.com";
export const APP = { kind: "app", name: "setup" } as const;
/** The session cookie pair that a response sets, or an empty text. */
export const cookieOf = (res: Response) =>
  (res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`)) ?? "").split(";")[0] ??
  "";

/**
 * An app with the admin plugin on `database`, built through the flows of
 * the product. The operator signs up and verifies the address. The app
 * makes the first operator in process (createAdmin, spec 26 item 11). The
 * operator then signs in, after the grant (ruling 50), and turns TOTP on
 * through Better Auth's two paths unless `factor` is false. `slug` is
 * the platform organization as the app writes it. `extra` adds plugins.
 * `sessionMaxPerUser` sets core's cap of the sessions of one user (plan 12q):
 * a worst page needs more than the default of 100.
 */
export function adminShim(
  database: CompatDatabase,
  links: string[] = [],
  slug = "platform-co",
  extra: readonly BetterAuthPlugin[] = [],
  sessionMaxPerUser?: number,
) {
  return betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database,
    authtempo: {
      passwordHash: fast,
      platformOrganization: slug,
      ...(sessionMaxPerUser === undefined ? {} : { sessionMaxPerUser }),
    },
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async ({ token }) => {
        links.push(token);
      },
    },
    plugins: [
      organization({ sendInvitationEmail: async () => {} }),
      twoFactor({ accountLockout: { enabled: false } }),
      admin({}),
      ...extra,
    ],
  });
}

/** An app with no admin plugin on `database`: the password sign-in only. */
export function plainShim(database: CompatDatabase) {
  return betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database,
    authtempo: { passwordHash: fast },
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: { sendVerificationEmail: async () => {} },
  });
}

export async function adminApp(
  database: CompatDatabase,
  opts: {
    factor?: boolean;
    slug?: string;
    plugins?: readonly BetterAuthPlugin[];
    sessionMaxPerUser?: number;
  } = {},
) {
  const links: string[] = [];
  const auth = adminShim(database, links, opts.slug, opts.plugins, opts.sessionMaxPerUser);
  const send = (method: string, path: string, body: unknown, cookie: string) =>
    auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method,
        headers: {
          origin: BASE,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const call = (path: string, body: unknown, cookie = "") => send("POST", path, body, cookie);
  const read = (path: string, cookie = "") => send("GET", path, undefined, cookie);
  /** A verified user with a session. Answers the user id and the session cookie. */
  const user = async (email: string) => {
    await call("/password/sign-up", { email, password: PASSWORD });
    await call("/password/verify", { token: links.at(-1) });
    const signIn = await call("/password/sign-in", { email, password: PASSWORD });
    const row = await database.storage.findOne("user", [
      { field: "email", op: "eq", value: email },
    ]);
    if (!row) throw new Error(`no user ${email}`);
    return { id: row.id, cookie: cookieOf(signIn) };
  };
  await call("/password/sign-up", { email: OPERATOR, password: PASSWORD });
  await call("/password/verify", { token: links.at(-1) });
  const made = await auth.tempo.api.operator.createAdmin({
    actor: APP,
    email: OPERATOR,
    reason: "First operator",
    ip: null,
    userAgent: null,
  });
  if (!made.ok) throw new Error(made.code);
  const signIn = await call("/password/sign-in", { email: OPERATOR, password: PASSWORD });
  const op = cookieOf(signIn);
  if (opts.factor !== false) {
    const enable = await call("/two-factor/enable", { password: PASSWORD }, op);
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const secret = base32Decode(new URL(totpURI).searchParams.get("secret") ?? "");
    const confirm = await call(
      "/two-factor/verify-totp",
      { code: await totpCode(secret, new Date()) },
      op,
    );
    if (confirm.status !== 200) throw new Error(`verify-totp answered ${confirm.status}`);
  }
  const opRow = await database.storage.findOne("user", [
    { field: "email", op: "eq", value: OPERATOR },
  ]);
  if (!opRow) throw new Error("no operator");
  /** The audit rows of one target, read by the app. */
  const audit = async (targetUserId: string) => {
    const rows = await auth.tempo.api.operator.audit.list({ actor: APP, targetUserId });
    if (!rows.ok) throw new Error(rows.code);
    return rows.value.rows.map((r) => ({
      action: r.action,
      actorKind: r.actorKind,
      actorId: r.actorId,
      reason: r.reason,
    }));
  };
  return { auth, call, read, user, op, opId: opRow.id, audit, links };
}

// A Better Auth scrypt hash of PASSWORD (the vector of hash.test.ts).
const BA_HASH =
  "8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3";
const ERA = "2026-09-01T00:00:00.000Z";

/**
 * The SQL of a Better Auth database with the admin plugin, before the
 * compat migrations (ruling 62 M1). The columns are those of Better Auth
 * 1.7.2's admin schema (dist/plugins/admin/schema.mjs, read 2026-10-21):
 * user role, banned, banReason, banExpires, and session impersonatedBy.
 * Three users with a password, as Better Auth writes them. The user ann is
 * banned with no end, bob's ban ended on 2026-09-02, and cy was never banned.
 */
export function betterAuthBans(dialect: "postgres" | "sqlite"): string {
  const pg = dialect === "postgres";
  const bool = (b: boolean) => (pg ? String(b) : b ? "1" : "0");
  const user = (id: string, banned: boolean, reason: string | null, expires: string | null) =>
    `INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt","role","banned","banReason","banExpires") VALUES ('${id}','${id}','${id}@example.com',${bool(true)},NULL,'${ERA}','${ERA}','user',${bool(banned)},${reason === null ? "NULL" : `'${reason}'`},${expires === null ? "NULL" : `'${expires}'`});
INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('${id}-cred','${issuerFor("credential")}','${id}','credential','${id}','${BA_HASH}','${ERA}','${ERA}');`;
  return [
    `ALTER TABLE "user" ADD COLUMN "role" text;`,
    `ALTER TABLE "user" ADD COLUMN "banned" ${pg ? "boolean" : "integer"};`,
    `ALTER TABLE "user" ADD COLUMN "banReason" text;`,
    `ALTER TABLE "user" ADD COLUMN "banExpires" ${pg ? "timestamptz" : "date"};`,
    `ALTER TABLE "session" ADD COLUMN "impersonatedBy" text;`,
    user("ann", true, "Spam", null),
    user("bob", true, "Spam", "2026-09-02T00:00:00.000Z"),
    user("cy", false, null, null),
  ].join("\n");
}

/**
 * The users of a Better Auth database with no admin plugin, as SQLite
 * statements: "ann" and "cy" with a password. The user table has no ban
 * column (ruling 65 of plan 12f, X3).
 */
export function betterAuthPlainUsers(): string {
  const user = (id: string) =>
    `INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES ('${id}','${id}','${id}@example.com',1,NULL,'${ERA}','${ERA}');
INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('${id}-cred','${issuerFor("credential")}','${id}','credential','${id}','${BA_HASH}','${ERA}','${ERA}');`;
  return [user("ann"), user("cy")].join("\n");
}
