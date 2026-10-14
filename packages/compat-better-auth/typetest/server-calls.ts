import { twoFactor } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import type { BetterAuthInstance } from "../src/types.js";
import { consumere, consumeri } from "./options.js";

const cf = betterAuth(consumere);
export async function consumereCalls(request: Request) {
  const session = await cf.api.getSession({ headers: request.headers });
  const userId: string | undefined = session?.user.id;
  const up = await cf.api.signUpEmail({
    body: { email: "a@example.com", password: "correct horse battery", name: "A" },
  });
  // consumere names requireEmailVerification (a boolean), so the token can be
  // null, as Better Auth 1.7.2 types it (dist/api/routes/sign-up.d.mts line 152).
  const token: string | null = up.token;
  const signedIn = await cf.api.signInEmail({
    body: { email: "a@example.com", password: "correct horse battery" },
  });
  const again: string = signedIn.token;
  const res: Response = await cf.handler(request);
  return { userId, token, again, res };
}

const mr = betterAuth(consumeri);
export type Auth = typeof mr;
export type Session = Auth["$Infer"]["Session"]["session"];
export type User = Auth["$Infer"]["Session"]["user"];
export const tokenOf = (s: Session): string => s.token;
export const activeOf = (s: Session): string | null => s.activeOrganizationId;
export const nameOf = (u: User): string => u.name;
export async function consumeriMiddleware(
  headers: Headers,
): Promise<{ session: Session; user: User } | null> {
  return mr.api.getSession({ headers });
}

export async function consumerdInvites(headers: Headers) {
  const invitation = await mr.api.createInvitation({
    body: { email: "x@example.com", role: "member", organizationId: "o1" },
    headers,
  });
  await mr.api.cancelInvitation({ body: { invitationId: invitation.id }, headers });
}

// Plan 9f: with a literal two-factor plugin the sign-in answer is a union; without it, it is not.
const tf = betterAuth({
  ...consumeri,
  plugins: [twoFactor({ issuer: "Reception", accountLockout: { enabled: false } })],
});
export async function twoFactorCalls() {
  const r = await tf.api.signInEmail({
    body: { email: "a@example.com", password: "correct horse battery" },
  });
  if ("twoFactorRedirect" in r) {
    const methods: string[] = r.twoFactorMethods;
    return methods;
  }
  const token: string = r.token;
  const s = await tf.api.getSession({ headers: new Headers() });
  const on: boolean | undefined = s?.user.twoFactorEnabled;
  return [token, String(on)];
}
export async function noTwoFactorCalls() {
  const r = await cf.api.signInEmail({
    body: { email: "a@example.com", password: "correct horse battery" },
  });
  // @ts-expect-error without the plugin the answer has no twoFactorRedirect
  return r.twoFactorRedirect;
}

// Plan 12b Task 15: with requireEmailVerification the sign-up token can be null; without it, it cannot.
export async function noRequireVerifiedCalls() {
  const up = await mr.api.signUpEmail({
    body: { email: "a@example.com", password: "correct horse battery", name: "A" },
  });
  const token: string = up.token;
  return token;
}
const rv = betterAuth({
  ...consumeri,
  emailAndPassword: { enabled: true, requireEmailVerification: true },
});
export async function requireVerifiedCalls() {
  const up = await rv.api.signUpEmail({
    body: { email: "a@example.com", password: "correct horse battery", name: "A" },
  });
  const maybe: string | null = up.token;
  // @ts-expect-error with requireEmailVerification the sign-up opens no session, so the token is null
  const token: string = up.token;
  return [maybe, token];
}
// Options typed as the wide BetterAuthOptions: the key can be true at run time, so the token can be null.
export async function wideOptionsCalls(wide: BetterAuthInstance) {
  const up = await wide.api.signUpEmail({
    body: { email: "a@example.com", password: "correct horse battery", name: "A" },
  });
  const maybe: string | null = up.token;
  // @ts-expect-error a wide option type may turn requireEmailVerification on, so the token can be null
  const token: string = up.token;
  return [maybe, token];
}
// A literal false keeps the token a string.
const rvOff = betterAuth({
  ...consumeri,
  emailAndPassword: { enabled: true, requireEmailVerification: false as const },
});
export async function requireVerifiedOffCalls() {
  const up = await rvOff.api.signUpEmail({
    body: { email: "a@example.com", password: "correct horse battery", name: "A" },
  });
  const token: string = up.token;
  return token;
}
// The worker example's pattern (examples/worker/src/compat.ts): an instance of
// literal options, stored in and returned as the wide BetterAuthInstance.
let cached: BetterAuthInstance | null = null;
export function wideReturn(): BetterAuthInstance {
  if (cached) return cached;
  cached = betterAuth({
    ...consumeri,
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
  });
  return cached;
}
export const wideFromVerified: BetterAuthInstance = rv;
export const wideFromOff: BetterAuthInstance = rvOff;
