import { ROUTES } from "@authtempo/core/routes";
import { base32Decode, SoftAuthenticator, totpCode } from "@authtempo/core/testing";
import { expect } from "vitest";
import { DEMO_FEATURES } from "../src/facts.js";
import { DEMO_PAGES } from "../src/pages/layout.js";
import {
  call,
  codeFor,
  exchange,
  type Jar,
  lastCode,
  lastLink,
  mailbox,
  newSandbox,
  ORIGIN,
  PASSWORD,
  pick,
  sameSandbox,
  signInByLink,
  verifiedUser,
  whoami,
} from "./helpers.js";

/**
 * Every flow of plan 11b Task 9 through the demo Worker, in one sandbox (plan
 * 11b Task 12). Then one request goes to each route of each demo feature, to
 * each page, and to /reset. The outbound test records each request that
 * leaves the Worker. The cookie test reads each Set-Cookie line of the
 * answers. A step that answers wrong throws, so a flow that stops early
 * cannot pass.
 */
export async function everyFlow(): Promise<void> {
  const jar = await newSandbox();

  // Password: sign-up, the proof link, sign-in, and the reset by link.
  await verifiedUser(jar, "pat@example.com");
  const pat = sameSandbox(jar);
  const signIn = await call(pat, "POST", "/auth/password/sign-in", {
    email: "pat@example.com",
    password: PASSWORD,
  });
  expect(signIn.status).toBe(200);
  const resetAsk = await call(pat, "POST", "/auth/password/reset/request", {
    email: "pat@example.com",
  });
  expect(resetAsk.status).toBe(200);
  const resetLink = await lastLink(pat, "pat@example.com");
  expect((await call(pat, "GET", `${resetLink.pathname}${resetLink.search}`)).status).toBe(200);
  const reset = await call(
    pat,
    "POST",
    "/auth/password/reset",
    new URLSearchParams({
      token: resetLink.searchParams.get("token") ?? "",
      password: "new horse battery staple",
    }),
  );
  expect(reset.status).toBe(302);

  // Magic link: the confirm page, then the sign-in.
  const ada = sameSandbox(jar);
  expect(
    (await call(ada, "POST", "/auth/magic-link/request", { email: "ada@example.com" })).status,
  ).toBe(200);
  const magic = await lastLink(ada, "ada@example.com");
  expect((await call(ada, "GET", `${magic.pathname}${magic.search}`)).status).toBe(200);
  await signInByLink(ada, "ada@example.com");

  // Email code: the sign-in, and the password reset by a code.
  const otp = sameSandbox(jar);
  expect((await call(otp, "POST", "/auth/otp/request", { email: "otp@example.com" })).status).toBe(
    200,
  );
  const code = await lastCode(otp, "otp@example.com");
  expect(
    (await call(otp, "POST", "/auth/otp/verify", { email: "otp@example.com", code })).status,
  ).toBe(200);
  expect(
    (await call(otp, "POST", "/auth/otp/reset/request", { email: "pat@example.com" })).status,
  ).toBe(200);
  const resetCode = await lastCode(otp, "pat@example.com");
  const byCode = await call(otp, "POST", "/auth/otp/reset", {
    email: "pat@example.com",
    code: resetCode,
    password: "a new long password",
  });
  expect(byCode.status).toBe(200);

  // Social sign-in: core calls the token and profile URLs of the demo provider.
  const social = sameSandbox(jar);
  const start = await call(social, "GET", "/auth/social/demo/start");
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("location") ?? "");
  const back = await pick(social, `${authorize.pathname}${authorize.search}`, "grace");
  const done = await call(social, "GET", `${back.pathname}${back.search}`);
  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toBe(`${ORIGIN}/`);
  expect(await whoami(social)).toMatchObject({ email: "grace@example.com" });
  // The token step of the provider, as a client app calls it.
  const verifier = "v".repeat(43);
  expect((await exchange(social, await codeFor(social, verifier), verifier)).status).toBe(200);

  // Passkey: the register and a sign-in with the passkey alone.
  const soft = await SoftAuthenticator.create({ rpID: "demo.authtempo.com", origin: ORIGIN });
  const options = await call(ada, "POST", "/auth/passkey/register/options", {});
  const { challenge: created } = (await options.json()) as { challenge: string };
  const registered = await call(ada, "POST", "/auth/passkey/register/verify", {
    response: await soft.register(created),
    name: "Demo device",
  });
  expect(registered.status).toBe(200);
  const device = sameSandbox(jar);
  const asked = await call(device, "POST", "/auth/passkey/authenticate/options", {});
  const { challenge } = (await asked.json()) as { challenge: string };
  const byKey = await call(device, "POST", "/auth/passkey/authenticate/verify", {
    response: await soft.authenticate(challenge),
  });
  expect(byKey.status).toBe(200);

  // The second factor, with the trusted-device cookie of core, then a backup code.
  await secondFactor(jar);

  // API tokens: create, call /whoami with the token, revoke.
  const created2 = await call(ada, "POST", "/auth/tokens", { name: "deploy script" });
  expect(created2.status).toBe(200);
  const { token, apiToken } = (await created2.json()) as {
    token: string;
    apiToken: { id: string };
  };
  const bearer = { authorization: `Bearer ${token}` };
  expect(await whoami(sameSandbox(jar), bearer)).toMatchObject({ kind: "token" });
  expect((await call(ada, "POST", "/auth/tokens/revoke", { id: apiToken.id })).status).toBe(200);

  // Organizations: create, invite, accept from the mailbox, change the role.
  const org = await call(ada, "POST", "/auth/organizations/create", { slug: "acme", name: "Acme" });
  expect(org.status).toBe(200);
  const { organization } = (await org.json()) as { organization: { id: string } };
  const invited = await call(ada, "POST", "/auth/organizations/invite", {
    organizationId: organization.id,
    email: "alan@example.com",
    role: "member",
  });
  expect(invited.status).toBe(200);
  const alan = sameSandbox(jar);
  const invitation =
    (await lastLink(alan, "alan@example.com")).searchParams.get("invitation") ?? "";
  await signInByLink(alan, "alan@example.com");
  const accepted = await call(alan, "POST", "/auth/organizations/invitations/accept", {
    token: invitation,
  });
  expect(accepted.status).toBe(200);
  const role = await call(ada, "POST", "/auth/organizations/members/role", {
    organizationId: organization.id,
    userId: (await whoami(alan))?.id ?? "",
    role: "admin",
  });
  expect(role.status).toBe(200);
  expect((await call(alan, "GET", "/auth/organizations")).status).toBe(200);

  // Account: the sessions, the name, the end of the other sessions, then the delete.
  expect((await call(ada, "GET", "/auth/sessions")).status).toBe(200);
  expect((await call(ada, "POST", "/auth/user/update", { name: "Ada Lovelace" })).status).toBe(200);
  expect((await call(ada, "POST", "/auth/sessions/revoke-others", {})).status).toBe(200);
  expect((await call(alan, "POST", "/auth/user/delete", {})).status).toBe(200);

  // Each page and the mailbox.
  for (const p of DEMO_PAGES)
    expect({ path: p.path, status: (await call(ada, "GET", p.path)).status }).toEqual({
      path: p.path,
      status: 200,
    });
  expect((await mailbox(ada)).length).toBeGreaterThan(0);

  // One request to each route of each demo feature, signed in, as coverage.test.ts sends it.
  const demo = new Set<string>(DEMO_FEATURES);
  let routes = 0;
  for (const route of ROUTES) {
    if (!demo.has(route.feature)) continue;
    const path = `/auth${route.path.replace(":provider", "demo")}`;
    await call(ada, route.method, path, route.method === "POST" ? {} : undefined);
    routes += 1;
  }
  expect(routes).toBeGreaterThan(0);

  // Start again: the answer clears the sandbox cookie.
  const again = await call(jar, "POST", "/reset");
  expect(again.status).toBe(303);
}

/** The second factor on for a new user, a sign-in that trusts the device, then a backup code. */
async function secondFactor(jar: Jar): Promise<void> {
  const owner = sameSandbox(jar);
  const email = "totp@example.com";
  await verifiedUser(owner, email);
  const setup = await call(owner, "POST", "/auth/totp/setup", { password: PASSWORD });
  expect(setup.status).toBe(200);
  const body = (await setup.json()) as { secret: string; backupCodes: string[] };
  const secret = base32Decode(body.secret);
  const at = new Date();
  const enable = await call(owner, "POST", "/auth/totp/enable", {
    code: await totpCode(secret, at),
  });
  expect(enable.status).toBe(200);
  // The code of the next step, so the step that the enable spent does not refuse it.
  const next = await totpCode(secret, new Date((Math.floor(at.getTime() / 30_000) + 1) * 30_000));
  const trusted = sameSandbox(jar);
  const first = await call(trusted, "POST", "/auth/password/sign-in", {
    email,
    password: PASSWORD,
  });
  const { twoFactor } = (await first.json()) as { twoFactor: { challenge: string } };
  const verify = await call(trusted, "POST", "/auth/totp/verify", {
    challenge: twoFactor.challenge,
    code: next,
    trustDevice: true,
  });
  expect(verify.status).toBe(200);
  expect(trusted.cookies.has("tempo_totp_trust")).toBe(true);
  // Forget the trusted devices: core clears the trust cookie on this answer.
  const forget = await call(trusted, "POST", "/auth/totp/devices/revoke", {});
  expect(forget.status).toBe(200);
  expect(trusted.cookies.has("tempo_totp_trust")).toBe(false);
  const backup = sameSandbox(jar);
  const second = await call(backup, "POST", "/auth/password/sign-in", {
    email,
    password: PASSWORD,
  });
  const { twoFactor: again } = (await second.json()) as { twoFactor: { challenge: string } };
  const byBackup = await call(backup, "POST", "/auth/totp/verify", {
    challenge: again.challenge,
    backupCode: body.backupCodes[0],
  });
  expect(byBackup.status).toBe(200);
}
