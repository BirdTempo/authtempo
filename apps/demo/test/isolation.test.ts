import { base32Decode, SoftAuthenticator, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import {
  call,
  codeFor,
  exchange,
  type Jar,
  lastCode,
  lastLink,
  mailbox,
  newSandbox,
  newVerifier,
  ORIGIN,
  PASSWORD,
  rowsIn,
  SANDBOX_COOKIE,
  SESSION_COOKIE,
  sameSandbox,
  signInByLink,
  verifiedUser,
  whoami,
} from "./helpers.js";

/** The same addresses in both sandboxes, so only the store can keep them apart. */
const PAT = "pat@example.com";
const ADA = "ada@example.com";
const OTP = "otp@example.com";
const LINK = "link@example.com";
const GRACE = "grace@example.com";
const TOTP = "totp@example.com";
const TRUST_COOKIE = "tempo_totp_trust";

/** What one sandbox holds after its flows: each credential, each unspent token, and its mail. */
interface Held {
  session: string;
  apiToken: string;
  passkey: SoftAuthenticator;
  /** An email code that is not spent. */
  code: string;
  /** A magic link token that is not spent. */
  magic: string;
  /** A password reset token that is not spent. */
  reset: string;
  /** A code of the demo provider (its OAuth row) that is not spent, with its verifier. */
  provider: { code: string; verifier: string };
  /** An invitation token of an organization. */
  invitation: string;
  /** The trusted-device cookie of the second factor user. */
  trust: string;
  mail: string[];
}

/** A user with the second factor on, signed in once with "trust this device". Answers the trust cookie. */
async function trustedDevice(jar: Jar): Promise<string> {
  const owner = sameSandbox(jar);
  await verifiedUser(owner, TOTP);
  const setup = await call(owner, "POST", "/auth/totp/setup", { password: PASSWORD });
  const secret = base32Decode(((await setup.json()) as { secret: string }).secret);
  const at = new Date();
  const enable = await call(owner, "POST", "/auth/totp/enable", {
    code: await totpCode(secret, at),
  });
  expect(enable.status).toBe(200);
  const next = await totpCode(secret, new Date((Math.floor(at.getTime() / 30_000) + 1) * 30_000));
  const device = sameSandbox(jar);
  const first = await call(device, "POST", "/auth/password/sign-in", {
    email: TOTP,
    password: PASSWORD,
  });
  const { twoFactor } = (await first.json()) as { twoFactor: { challenge: string } };
  const verify = await call(device, "POST", "/auth/totp/verify", {
    challenge: twoFactor.challenge,
    code: next,
    trustDevice: true,
  });
  expect(verify.status).toBe(200);
  const trust = device.cookies.get(TRUST_COOKIE) ?? "";
  expect(trust).not.toBe("");
  return trust;
}

/** A password sign-in of the second factor user with a trust cookie. True when it gives a session. */
async function trustSignsIn(jar: Jar, trust: string): Promise<boolean> {
  const device = sameSandbox(jar);
  device.cookies.set(TRUST_COOKIE, trust);
  await call(device, "POST", "/auth/password/sign-in", { email: TOTP, password: PASSWORD });
  return device.cookies.has(SESSION_COOKIE);
}

/** Real flows in one sandbox. Each token stays unspent, so the other sandbox can try it. */
async function hold(jar: Jar): Promise<Held> {
  await verifiedUser(sameSandbox(jar), PAT);
  const ada = sameSandbox(jar);
  await signInByLink(ada, ADA);
  const session = ada.cookies.get(SESSION_COOKIE) ?? "";
  const created = await call(ada, "POST", "/auth/tokens", { name: "deploy script" });
  expect(created.status).toBe(200);
  const { token } = (await created.json()) as { token: string };
  const passkey = await SoftAuthenticator.create({ rpID: "demo.authtempo.com", origin: ORIGIN });
  const options = await call(ada, "POST", "/auth/passkey/register/options", {});
  const { challenge } = (await options.json()) as { challenge: string };
  const registered = await call(ada, "POST", "/auth/passkey/register/verify", {
    response: await passkey.register(challenge),
    name: "Demo device",
  });
  expect(registered.status).toBe(200);
  expect((await call(ada, "POST", "/auth/otp/request", { email: OTP })).status).toBe(200);
  const code = await lastCode(ada, OTP);
  expect((await call(ada, "POST", "/auth/magic-link/request", { email: LINK })).status).toBe(200);
  const magic = (await lastLink(ada, LINK)).searchParams.get("token") ?? "";
  const asked = await call(ada, "POST", "/auth/password/reset/request", { email: PAT });
  expect(asked.status).toBe(200);
  const reset = (await lastLink(ada, PAT)).searchParams.get("token") ?? "";
  const verifier = newVerifier();
  const provider = { code: await codeFor(sameSandbox(jar), verifier), verifier };
  const org = await call(ada, "POST", "/auth/organizations/create", { slug: "acme", name: "Acme" });
  const { organization } = (await org.json()) as { organization: { id: string } };
  const invited = await call(ada, "POST", "/auth/organizations/invite", {
    organizationId: organization.id,
    email: GRACE,
    role: "member",
  });
  expect(invited.status).toBe(200);
  const invitation = (await lastLink(ada, GRACE)).searchParams.get("invitation") ?? "";
  // Grace is a user of this sandbox too, so a later sign-in of hers here passes the user cap.
  await signInByLink(sameSandbox(jar), GRACE);
  const trust = await trustedDevice(jar);
  // Each credential works in its own sandbox, so a refusal in the other one means something.
  expect(await whoami(sameSandbox(jar), { authorization: `Bearer ${session}` })).toMatchObject({
    email: ADA,
  });
  expect(await whoami(sameSandbox(jar), { authorization: `Bearer ${token}` })).toMatchObject({
    email: ADA,
  });
  expect(await trustSignsIn(jar, trust)).toBe(true);
  const mail = (await mailbox(ada)).map((m) => m.text);
  for (const t of [magic, reset, invitation]) expect(t).not.toBe("");
  return {
    session,
    apiToken: token,
    passkey,
    code,
    magic,
    reset,
    provider,
    invitation,
    trust,
    mail,
  };
}

/** The users of the sandbox of `jar`, filled up to the cap of 10 by sign-ups of new addresses. */
async function fill(jar: Jar): Promise<void> {
  const count = async () => Number((await rowsIn(jar, "SELECT COUNT(*) AS n FROM ta_user"))[0]?.n);
  for (let i = await count(); i < 10; i++) {
    const up = await call(sameSandbox(jar), "POST", "/auth/password/sign-up", {
      email: `fill-${i}@example.com`,
      password: PASSWORD,
    });
    expect(up.status).toBe(200);
  }
  expect(await count()).toBe(10);
  const over = await call(sameSandbox(jar), "POST", "/auth/password/sign-up", {
    email: "over@example.com",
    password: PASSWORD,
  });
  expect(over.status).toBe(429);
}

/** True when a form post of a token page gave no session: a refusal redirect, not the home. */
function refused(jar: Jar, res: Response): boolean {
  return !jar.cookies.has(SESSION_COOKIE) && res.headers.get("location") !== `${ORIGIN}/`;
}

/**
 * Each item of `held` does nothing in the sandbox of `other`. The checks that
 * only read come first. `fresh` is true when `other` has made no data yet, so
 * a cross of the stores meets a named refusal here, not a step of hold().
 */
async function refusedIn(other: Jar, held: Held, fresh: boolean): Promise<void> {
  // The session token as the session cookie, beside the sandbox cookie of `other`.
  const withCookie = sameSandbox(other);
  withCookie.cookies.set(SESSION_COOKIE, held.session);
  expect(await whoami(withCookie)).toBeNull();
  expect(await whoami(sameSandbox(other), { authorization: `Bearer ${held.session}` })).toBeNull();
  expect(await whoami(sameSandbox(other), { authorization: `Bearer ${held.apiToken}` })).toBeNull();

  const texts = (await mailbox(sameSandbox(other))).map((m) => m.text);
  expect(texts.filter((t) => held.mail.includes(t))).toEqual([]);
  if (fresh) expect(texts).toEqual([]);

  const byCode = sameSandbox(other);
  // 400 for a wrong code, or 429 when `other` is at the user cap and the address is new there.
  const otp = await call(byCode, "POST", "/auth/otp/verify", { email: OTP, code: held.code });
  expect([400, 429]).toContain(otp.status);
  expect(byCode.cookies.has(SESSION_COOKIE)).toBe(false);

  const byLink = sameSandbox(other);
  const magic = await call(
    byLink,
    "POST",
    "/auth/magic-link/verify",
    new URLSearchParams({ token: held.magic }),
  );
  expect(refused(byLink, magic)).toBe(true);

  const byReset = sameSandbox(other);
  const reset = await call(
    byReset,
    "POST",
    "/auth/password/reset",
    new URLSearchParams({ token: held.reset, password: "a password of the other" }),
  );
  expect(refused(byReset, reset)).toBe(true);

  const grant = await exchange(sameSandbox(other), held.provider.code, held.provider.verifier);
  expect(grant.status).toBe(400);

  const device = sameSandbox(other);
  const asked = await call(device, "POST", "/auth/passkey/authenticate/options", {});
  expect(asked.status).toBe(200);
  const { challenge } = (await asked.json()) as { challenge: string };
  const signIn = await call(device, "POST", "/auth/passkey/authenticate/verify", {
    response: await held.passkey.authenticate(challenge),
  });
  expect(signIn.status).not.toBe(200);
  expect(device.cookies.has(SESSION_COOKIE)).toBe(false);

  expect(await trustSignsIn(other, held.trust)).toBe(false);

  // The checks that write: Grace signs in here and tries the invitation of the other sandbox.
  const grace = sameSandbox(other);
  await signInByLink(grace, GRACE);
  const accept = await call(grace, "POST", "/auth/organizations/invitations/accept", {
    token: held.invitation,
  });
  expect(accept.status).not.toBe(200);

  // The other sandbox is at the user cap. A count of its users does not reach this one.
  if (fresh) {
    const up = await call(sameSandbox(other), "POST", "/auth/password/sign-up", {
      email: "limit@example.com",
      password: PASSWORD,
    });
    expect(up.status).toBe(200);
  }
}

/** The id of each passkey row of the sandbox of `jar`. */
async function passkeyIds(jar: Jar): Promise<string[]> {
  return (await rowsIn(jar, "SELECT credential_id FROM ta_passkey")).map((r) =>
    String(r.credential_id),
  );
}

describe("two sandboxes", () => {
  it("keeps each sandbox's credentials and mail to itself", async () => {
    // Both sandboxes come through the gate, each from its own first visit.
    const a = await newSandbox();
    const b = await newSandbox();
    expect(a.cookies.get(SANDBOX_COOKIE)).not.toBe(b.cookies.get(SANDBOX_COOKIE));
    const heldA = await hold(a);
    await fill(a);
    // B tries each item of A before B makes any data of its own.
    await refusedIn(b, heldA, true);
    const heldB = await hold(b);
    await refusedIn(a, heldB, false);
    // No row crosses: each store holds its own passkey only.
    const keysA = await passkeyIds(a);
    const keysB = await passkeyIds(b);
    expect(keysA).toHaveLength(1);
    expect(keysB).toHaveLength(1);
    expect(keysA.filter((k) => keysB.includes(k))).toEqual([]);
  });

  it("names each store by its own id", async () => {
    const a = await newSandbox();
    const b = await newSandbox();
    const secretOf = async (jar: Jar) =>
      String((await rowsIn(jar, "SELECT value FROM demo_meta WHERE key = 'secret'"))[0]?.value);
    const secretA = await secretOf(a);
    const secretB = await secretOf(b);
    expect(secretA).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secretB).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secretA).not.toBe(secretB);
  });
});
