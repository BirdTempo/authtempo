import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { CLIENT_CALLS } from "../src/calls.js";
import { createClient } from "../src/client.js";
import type { BrowserWebAuthn } from "../src/webauthn.js";

const BASE = "https://api.example.com";

/** A fetch that answers `{}` to every request and keeps the method and the path under basePath. */
function recording() {
  const seen: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(`${req.method} ${new URL(req.url).pathname.replace(/^\/auth/, "")}`);
    return Response.json({});
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}

/** A passkey seam that answers an empty response, so each ceremony reaches its second call. */
const seam: BrowserWebAuthn = {
  create: async () => ({}) as Awaited<ReturnType<BrowserWebAuthn["create"]>>,
  get: async () => ({}) as Awaited<ReturnType<BrowserWebAuthn["get"]>>,
};

describe("the call table of the client (plan 11d)", () => {
  it("names a route of ROUTES with its method in every row, and each operation once", () => {
    const routes = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const c of CLIENT_CALLS) expect(routes).toContain(`${c.method} ${c.path}`);
    const operations = CLIENT_CALLS.map((c) => c.operation);
    expect(new Set(operations).size).toBe(operations.length);
    expect(CLIENT_CALLS).toHaveLength(57);
  });

  it("calls exactly the routes of its table when every operation runs once", async () => {
    const { seen, fetch } = recording();
    const c = createClient({ baseURL: BASE, fetch, webauthn: seam });
    const org = { organizationId: "o1" };
    await c.session();
    await c.signOut();
    await c.magicLink.request({ email: "a@b.c" });
    await c.magicLink.verify({ token: "t" });
    await c.handoff.redeem({ code: "c", verifier: "v" });
    await c.passkey.register();
    await c.passkey.signIn();
    await c.passkeys.list();
    await c.passkeys.delete({ id: "p" });
    await c.password.signUp({ email: "a@b.c", password: "p" });
    await c.password.signIn({ email: "a@b.c", password: "p" });
    await c.password.resendVerification({ email: "a@b.c" });
    await c.password.verifyEmail({ token: "t" });
    await c.password.requestReset({ email: "a@b.c" });
    await c.password.reset({ token: "t", password: "p" });
    await c.password.change({ newPassword: "p" });
    await c.emailOtp.request({ email: "a@b.c" });
    await c.emailOtp.verify({ email: "a@b.c", code: "1" });
    await c.emailOtp.requestReset({ email: "a@b.c" });
    await c.emailOtp.reset({ email: "a@b.c", code: "1", password: "p" });
    await c.organizations.create({ slug: "s", name: "n" });
    await c.organizations.list();
    await c.organizations.update(org);
    await c.organizations.delete(org);
    await c.organizations.members.list(org);
    await c.organizations.members.add({ ...org, userId: "u", role: "member" });
    await c.organizations.members.role({ ...org, userId: "u", role: "admin" });
    await c.organizations.members.remove({ ...org, userId: "u" });
    await c.organizations.invitations.invite({ ...org, email: "a@b.c", role: "member" });
    await c.organizations.invitations.list(org);
    await c.organizations.invitations.revoke({ ...org, invitationId: "i" });
    await c.organizations.invitations.accept({ token: "t" });
    await c.organizations.invitations.decline({ token: "t" });
    await c.organizations.setActive({ organizationId: null });
    await c.tokens.create({ name: "ci" });
    await c.tokens.list();
    await c.tokens.revoke({ id: "t" });
    await c.tokens.current();
    await c.jwt.token();
    await c.oauth.grants();
    await c.oauth.revoke({ clientId: "cl" });
    await c.totp.setup({ password: "p" });
    await c.totp.enable({ code: "1" });
    await c.totp.verify({ challenge: "c", code: "1" });
    await c.totp.disable({ code: "1" });
    await c.totp.regenerateBackupCodes({ code: "1" });
    await c.totp.status();
    await c.totp.revokeTrustedDevices();
    await c.secondFactor.passkey.enable({ password: "p" });
    await c.secondFactor.passkey.verify({ challenge: "c" });
    await c.secondFactor.email.enable({ password: "p" });
    await c.secondFactor.email.send({ challenge: "c" });
    await c.secondFactor.disable({ method: "email", password: "p" });
    expect([...new Set(seen)].sort()).toEqual(
      [...new Set(CLIENT_CALLS.map((r) => `${r.method} ${r.path}`))].sort(),
    );
  });

  it("sends a query apart from the path", async () => {
    const urls: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(new Request(input, init).url);
      return Response.json({ members: [] });
    }) as typeof globalThis.fetch;
    const c = createClient({ baseURL: BASE, fetch });
    await c.organizations.members.list({ organizationId: "a b&c" });
    // encodeURIComponent, as before plan 11d: a space is %20, never "+".
    expect(urls).toEqual([`${BASE}/auth/organizations/members?organizationId=a%20b%26c`]);
  });
});
