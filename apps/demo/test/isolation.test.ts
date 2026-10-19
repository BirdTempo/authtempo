import { SoftAuthenticator } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import {
  call,
  type Jar,
  lastCode,
  mailbox,
  newSandbox,
  ORIGIN,
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

/** What one sandbox holds after its flows: each credential, its mail, and a live email code. */
interface Held {
  session: string;
  apiToken: string;
  passkey: SoftAuthenticator;
  mail: string[];
  code: string;
}

/**
 * Real flows in one sandbox. They make a password user with its proof mail, a
 * magic link sign-in, and an API token. They also make a passkey of a soft
 * authenticator and an email code that is not spent.
 */
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
  const mail = (await mailbox(ada)).map((m) => m.text);
  // Each credential works in its own sandbox, so a refusal in the other one means something.
  expect(await whoami(sameSandbox(jar), { authorization: `Bearer ${session}` })).toMatchObject({
    email: ADA,
  });
  expect(await whoami(sameSandbox(jar), { authorization: `Bearer ${token}` })).toMatchObject({
    email: ADA,
  });
  return { session, apiToken: token, passkey, mail, code };
}

/** The credentials, the mail, the rows, and the code of `held` do nothing in the sandbox of `other`. */
async function refusedIn(other: Jar, held: Held): Promise<void> {
  // The session token as the session cookie, beside the sandbox cookie of `other`.
  const withCookie = sameSandbox(other);
  withCookie.cookies.set(SESSION_COOKIE, held.session);
  expect(await whoami(withCookie)).toBeNull();
  expect(await whoami(sameSandbox(other), { authorization: `Bearer ${held.session}` })).toBeNull();
  expect(await whoami(sameSandbox(other), { authorization: `Bearer ${held.apiToken}` })).toBeNull();

  const texts = (await mailbox(sameSandbox(other))).map((m) => m.text);
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.filter((t) => held.mail.includes(t))).toEqual([]);

  // The code of the other sandbox: `other` holds a code of its own for this address.
  const byCode = await call(sameSandbox(other), "POST", "/auth/otp/verify", {
    email: OTP,
    code: held.code,
  });
  expect(byCode.status).toBe(400);

  const device = sameSandbox(other);
  const asked = await call(device, "POST", "/auth/passkey/authenticate/options", {});
  expect(asked.status).toBe(200);
  const { challenge } = (await asked.json()) as { challenge: string };
  const signIn = await call(device, "POST", "/auth/passkey/authenticate/verify", {
    response: await held.passkey.authenticate(challenge),
  });
  expect(signIn.status).not.toBe(200);
  expect(device.cookies.has(SESSION_COOKIE)).toBe(false);
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
    const heldB = await hold(b);
    await refusedIn(b, heldA);
    await refusedIn(a, heldB);
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
