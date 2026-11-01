import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it, vi } from "vitest";
import { CLIENT_CALLS } from "../src/calls.js";
import { createClient } from "../src/client.js";
// The text of client.ts, read by Vite (test/raw.d.ts types it). The client has no Node types.
import clientSource from "../src/client.ts?raw";
import type { BrowserWebAuthn } from "../src/webauthn.js";
import {
  BODY_AS_INPUT,
  COMPARED,
  NOT_COMPARED,
  QUERY_AND_BODY_AS_INPUT,
} from "./contract.test-d.js";

/** The operations that the client looks up in the table, in call order. */
const looked = vi.hoisted(() => [] as string[]);

// Two routes serve two operations each, so the routes alone cannot show that
// each operation reads its own row. The spy keeps the name of each lookup.
vi.mock("../src/calls.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/calls.js")>();
  return {
    ...real,
    callOf: ((operation) => {
      looked.push(operation);
      return real.callOf(operation);
    }) as typeof real.callOf,
  };
});

const BASE = "https://api.example.com";

/** A fetch that answers `{}` to every request and keeps the method and the path under basePath. */
function recording() {
  const seen: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    // A link start and the ID-token calls name the provider in the path; the table writes the template.
    const path = new URL(req.url).pathname
      .replace(/^\/auth/, "")
      .replace(/^\/social\/[^/]+\/(link|id-token|id-token\/nonce)$/, "/social/:provider/$1");
    seen.push(`${req.method} ${path}`);
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
    // Plan 12k Task 8 adds the five organization token calls.
    // Plan 12d Task 13 adds the eleven SSO calls and the three SCIM token calls.
    // Plan 12i Task 2 adds the two username calls, and Task 5 the five phone calls.
    // Task 6 adds the two anonymous calls. Task 20 adds the sign-up code.
    // Task 15 adds the two ID-token calls, the passkey-first sign-up, the two
    // Signal API reads, and the three multi-session calls.
    expect(CLIENT_CALLS).toHaveLength(131);
  });

  it("calls exactly the routes of its table when every operation runs once", async () => {
    const { seen, fetch } = recording();
    looked.length = 0;
    // A navigation is a GET of the start route, written in the table's template form.
    const c = createClient({
      baseURL: BASE,
      fetch,
      webauthn: seam,
      navigate: (url) =>
        seen.push(
          `GET ${new URL(url).pathname
            .replace(/^\/auth/, "")
            .replace(/^\/social\/[^/]+\//, "/social/:provider/")
            .replace(/^\/sso\/[^/]+\/start$/, "/sso/:connectionId/start")}`,
        ),
    });
    const org = { organizationId: "o1" };
    await c.session();
    await c.session.refresh();
    await c.signOut();
    await c.magicLink.request({ email: "a@b.c" });
    await c.magicLink.verify({ token: "t" });
    c.social.signIn({ provider: "google" });
    await c.social.idTokenNonce({ provider: "google" });
    await c.social.idToken({ provider: "google", idToken: "a.b.c" });
    await c.handoff.redeem({ code: "c", verifier: "v" });
    await c.passkey.register();
    await c.passkey.signIn();
    await c.passkey.signUp({ name: "Ada" });
    await c.passkeys.list();
    await c.passkeys.sync();
    await c.passkeys.signalDetails();
    await c.passkeys.delete({ id: "p" });
    await c.passkeys.rename({ id: "p", name: "Phone" });
    await c.password.signUp({ email: "a@b.c", password: "p" });
    await c.password.signIn({ email: "a@b.c", password: "p" });
    await c.password.resendVerification({ email: "a@b.c" });
    await c.password.verifyEmail({ token: "t" });
    await c.password.verifyCode({ email: "a@b.c", code: "1" });
    await c.password.requestReset({ email: "a@b.c" });
    await c.password.reset({ token: "t", password: "p" });
    await c.password.change({ newPassword: "p" });
    await c.emailOtp.request({ email: "a@b.c" });
    await c.emailOtp.verify({ email: "a@b.c", code: "1" });
    await c.emailOtp.requestReset({ email: "a@b.c" });
    await c.emailOtp.reset({ email: "a@b.c", code: "1", password: "p" });
    await c.phone.request({ phone: "+14155550100" });
    await c.phone.verify({ phone: "+14155550100", code: "1" });
    await c.phone.add({ phone: "+14155550100" });
    await c.phone.verifyAdd({ code: "1" });
    await c.phone.remove();
    await c.anonymous.signIn();
    await c.anonymous.delete();
    await c.multiSession.list();
    await c.multiSession.switch({ sessionId: "s" });
    await c.multiSession.signOut({ sessionId: "s" });
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
    await c.organizations.hasPermission({ ...org, permissions: { member: ["read"] } });
    await c.organizations.permissions(org);
    await c.organizations.checkSlug({ slug: "acme" });
    await c.organizations.roles.list(org);
    await c.organizations.roles.get({ ...org, name: "editor" });
    await c.organizations.roles.create({
      ...org,
      name: "editor",
      permissions: { member: ["read"] },
    });
    await c.organizations.roles.update({ ...org, name: "editor", rank: 1 });
    await c.organizations.roles.delete({ ...org, name: "editor" });
    await c.organizations.teams.list(org);
    await c.organizations.teams.create({ ...org, name: "Core" });
    await c.organizations.teams.update({ teamId: "t", name: "Web" });
    await c.organizations.teams.delete({ teamId: "t" });
    await c.organizations.teams.members.list({ teamId: "t" });
    await c.organizations.teams.members.add({ teamId: "t", userId: "u" });
    await c.organizations.teams.members.remove({ teamId: "t", userId: "u" });
    await c.organizations.teams.setActive({ teamId: null });
    await c.organizations.teams.mine();
    await c.organizations.tokens.create({ ...org, name: "ci", permissions: {} });
    await c.organizations.tokens.list(org);
    await c.organizations.tokens.update({ ...org, id: "t", name: "cd" });
    await c.organizations.tokens.revoke({ ...org, id: "t" });
    await c.organizations.tokens.current();
    await c.tokens.create({ name: "ci" });
    await c.tokens.list();
    await c.tokens.revoke({ id: "t" });
    await c.tokens.update({ id: "t", name: "cd" });
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
    await c.sessions.list();
    await c.sessions.revoke({ id: "s" });
    await c.sessions.revokeOthers();
    await c.reauth.password({ password: "p" });
    await c.reauth.requestEmailCode();
    await c.reauth.passkey();
    await c.user.update({ name: "n" });
    await c.user.changeEmail({ newEmail: "a@b.c" });
    await c.user.confirmEmailChange({ token: "t" });
    await c.user.verifyEmailChange({ code: "1" });
    await c.user.delete();
    await c.user.confirmDelete({ token: "t" });
    await c.username.available({ username: "ada" });
    await c.username.set({ username: "ada" });
    await c.identities.list();
    await c.identities.unlink({ id: "i" });
    await c.identities.link({ provider: "google" });
    await c.secondFactor.passkey.enable({ password: "p" });
    await c.secondFactor.passkey.verify({ challenge: "c" });
    await c.secondFactor.email.enable({ password: "p" });
    await c.secondFactor.email.send({ challenge: "c" });
    await c.secondFactor.disable({ method: "email", password: "p" });
    await c.sso.discover({ email: "a@b.c" });
    c.sso.signIn({ connectionId: "c1" });
    await c.sso.domains.list(org);
    await c.sso.domains.add({ ...org, domain: "b.c" });
    await c.sso.domains.verify({ id: "d" });
    await c.sso.domains.update({ id: "d", enforce: true });
    await c.sso.domains.delete({ id: "d" });
    await c.sso.connections.list(org);
    await c.sso.connections.create({ ...org, kind: "oidc", label: "Staff" });
    await c.sso.connections.update({ id: "c1", label: "Staff" });
    await c.sso.connections.delete({ id: "c1" });
    await c.scim.tokens.list(org);
    await c.scim.tokens.create({ ...org, name: "Entra" });
    await c.scim.tokens.revoke({ id: "s" });
    expect([...new Set(seen)].sort()).toEqual(
      [...new Set(CLIENT_CALLS.map((r) => `${r.method} ${r.path}`))].sort(),
    );
    // Each operation of the table, and no other name, is looked up.
    expect([...new Set(looked)].sort()).toEqual(CLIENT_CALLS.map((r) => r.operation).sort());
    // Each request comes from a lookup: no call goes around the table.
    expect(seen).toHaveLength(looked.length);
  });

  it("has one raw call in client.ts, the one inside send", () => {
    expect(clientSource.match(/\bcall</g)).toHaveLength(1);
    expect(clientSource).toContain(
      "return call<T>(c.method, c.path, body, query, headers, token);",
    );
  });

  it("compares the answer of each compared row and the body of each body row with the contract, and names the rows it does not (plan 11g)", () => {
    const operations = CLIENT_CALLS.map((r) => r.operation).sort();
    const notCompared = NOT_COMPARED.map((r) => r.operation);
    // Every row is in one of the two lists, and no row is in both.
    expect([...COMPARED, ...notCompared].sort()).toEqual(operations);
    // Plan 12d Task 13: thirteen compared rows, and the start link, which is not.
    // Plan 12i Task 2 adds the two username calls, and Task 5 the five phone calls.
    // Task 6 adds the two anonymous calls. Task 20 adds the sign-up code.
    // Task 15 adds six compared rows and three that are not.
    expect(COMPARED).toHaveLength(121);
    expect(NOT_COMPARED).toHaveLength(10);
    for (const row of NOT_COMPARED) expect(row.reason.length, row.operation).toBeGreaterThan(0);
    // A body row is a compared row.
    // Plan 12i Task 2 adds username.set. Task 5 adds phone.verify, phone.add, and phone.verifyAdd.
    // Task 20 adds password.verifyCode. Task 15 adds the multi-session switch and sign-out.
    // Plan 12l moves the two SSO connection writes to QUERY_AND_BODY_AS_INPUT.
    expect(BODY_AS_INPUT).toHaveLength(67);
    for (const op of BODY_AS_INPUT) expect(COMPARED, op).toContain(op);
    // A row that sends its id in the query is a compared row and no body row (plan 12l).
    // The two SSO connection writes are these rows.
    expect(QUERY_AND_BODY_AS_INPUT).toHaveLength(2);
    for (const op of QUERY_AND_BODY_AS_INPUT) {
      expect(COMPARED, op).toContain(op);
      expect(BODY_AS_INPUT, op).not.toContain(op);
    }
    // Every row with `select` is compared: the type test reads the key.
    for (const r of CLIENT_CALLS)
      if ("select" in r) expect(COMPARED, r.operation).toContain(r.operation);
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
