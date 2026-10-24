import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  type DnsTxtPort,
  systemClock,
} from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { betterAuthPasswordHash } from "../src/hash.js";
import { organization, twoFactor } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import type { BetterAuthPlugin, CompatDatabase } from "../src/types.js";
import { cookieOf } from "./admin-helpers.js";

// The app of the sso and scim tests of plan 12d Task 14, on any compat
// database. Every row comes from a flow of the product.

export const BASE = "https://api.example.com";
const fast = betterAuthPasswordHash({ pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }) });
export const PASSWORD = "correct horse battery";
export const SECRET = "0123456789abcdef0123456789abcdef";

export const memory = (): CompatDatabase => ({
  kind: "authtempo-compat-database",
  dialect: "postgres",
  storage: createMemoryAdapter(),
  limiter: createMemoryLimiter(systemClock),
});

/**
 * A DNS port that answers from a map, which a test changes between calls.
 * A name not in the map answers `[]`. Each asked name goes to `calls`.
 */
export function fakeDns(name: string, answers: Map<string, string[]>) {
  const calls: string[] = [];
  const port: DnsTxtPort = {
    name,
    async txt(asked) {
      calls.push(asked);
      return answers.get(asked) ?? [];
    },
  };
  return { port, calls };
}

/**
 * A shim app with passwords, organizations, and `extra` plugins. `dns`
 * answers each TXT name; two ports ask the same map, as two resolvers that
 * agree.
 */
export function ssoApp(
  database: CompatDatabase,
  extra: BetterAuthPlugin[],
  options: { ssoDns?: boolean } = {},
) {
  const links: string[] = [];
  const dns = new Map<string, string[]>();
  const a = fakeDns("a", dns);
  const b = fakeDns("b", dns);
  const auth = betterAuth({
    baseURL: BASE,
    secret: SECRET,
    database,
    authtempo: {
      passwordHash: fast,
      ...(options.ssoDns === false ? {} : { ssoDns: [a.port, b.port] }),
    },
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async ({ token }) => {
        links.push(token);
      },
    },
    // Core's SSO manager needs a second factor (plan 12d Task 3), so the owner turns one on.
    plugins: [
      organization({ sendInvitationEmail: async () => {} }),
      twoFactor({ accountLockout: { enabled: false } }),
      ...extra,
    ],
  });
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
  /** A verified user with a session, through the sign-up, the verify link, and the sign-in. */
  const person = async (email: string) => {
    await call("/password/sign-up", { email, password: PASSWORD });
    await call("/password/verify", { token: links.at(-1) });
    const signIn = await call("/password/sign-in", { email, password: PASSWORD });
    const row = await database.storage.findOne("user", [
      { field: "email", op: "eq", value: email },
    ]);
    if (!row) throw new Error(`no user ${email}`);
    return { user: row, cookie: cookieOf(signIn) };
  };
  /**
   * A person with TOTP on, through Better Auth's two paths: enable with the
   * password, then verify-totp with the session. Core's SSO manager guard
   * needs it.
   */
  const manager = async (email: string) => {
    const p = await person(email);
    const enable = await call("/two-factor/enable", { password: PASSWORD }, p.cookie);
    const { totpURI } = (await enable.json()) as { totpURI: string };
    const secret = base32Decode(new URL(totpURI).searchParams.get("secret") ?? "");
    const confirm = await call(
      "/two-factor/verify-totp",
      { code: await totpCode(secret, new Date()) },
      p.cookie,
    );
    if (confirm.status !== 200) throw new Error(`verify-totp answered ${confirm.status}`);
    /**
     * A new session through the sign-in and the TOTP challenge, as after a
     * time step past the life of the first session. Call it at a later code step.
     */
    const signInAgain = async () => {
      const first = await call("/password/sign-in", { email, password: PASSWORD });
      const challenge = (
        first.headers.getSetCookie().find((c) => c.startsWith("better-auth.two_factor=")) ?? ""
      ).split(";")[0];
      const done = await call(
        "/two-factor/verify-totp",
        { code: await totpCode(secret, new Date()) },
        challenge ?? "",
      );
      if (done.status !== 200) throw new Error(`verify-totp answered ${done.status}`);
      p.cookie = cookieOf(done);
    };
    return Object.assign(p, { signInAgain });
  };
  /** An organization that `owner` creates through core's api, as a person does on its route. */
  const organizationOf = async (owner: Awaited<ReturnType<typeof person>>, slug: string) => {
    const made = await auth.tempo.api.createOrganization({
      user: owner.user,
      slug,
      name: slug,
    });
    if (!made.ok) throw new Error(made.code);
    return made.value.organization.id;
  };
  return { auth, database, call, read, send, person, manager, organizationOf, dns, a, b };
}
