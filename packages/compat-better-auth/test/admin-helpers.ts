import { createPbkdf2PasswordHash } from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { betterAuthPasswordHash } from "../src/hash.js";
import { admin, organization, twoFactor } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { COOKIE_NAME } from "../src/server/shapes.js";
import type { CompatDatabase } from "../src/types.js";

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
 * through Better Auth's two paths unless `factor` is false.
 */
export function adminShim(database: CompatDatabase, links: string[] = []) {
  return betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database,
    authtempo: { passwordHash: fast, platformOrganization: "platform-co" },
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
    ],
  });
}

export async function adminApp(database: CompatDatabase, opts: { factor?: boolean } = {}) {
  const links: string[] = [];
  const auth = adminShim(database, links);
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
  return { auth, call, read, user, op, opId: opRow.id, audit };
}
