import { describe, expect, it } from "vitest";
import readme from "../../client/README.md?raw";
import callsSource from "../../client/src/calls.ts?raw";
import { createSession } from "../src/engine/sessions.js";
import { createConnection } from "../src/engine/sso/connections.js";
import { ROUTES } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { BASE, SOCIAL } from "./every-feature.js";
import { makeAuth, post } from "./helpers.js";
import { SCIM_APP, scimAuth, scimToken } from "./scim/helpers.js";

// The code's fresh rule against the client README's list of the calls that can
// answer session_not_fresh (plan 12a fix wave). The site's fresh-calls test ties
// the README to the account settings guide; this test ties the README to the code.

const DAY = 86_400_000;
const EMAIL = "ada@example.com";
const credential = { id: "x", response: { clientDataJSON: "x" } };

/**
 * A body that passes the route's parse, so the probe reaches the rule behind
 * it. A route not named here takes `{}`; the test fails when one of them
 * answers invalid_body, so a new route cannot hide behind its parse.
 */
const BODIES: Readonly<Record<string, unknown>> = {
  "/handoff/redeem": { code: "x", verifier: "v".repeat(43) },
  "/identities/unlink": { id: "x" },
  // The ID-token sign-in of plan 12i Task 10 needs a token; it reads no session.
  "/social/:provider/id-token": { idToken: "a.b.c", nonce: "A".repeat(43) },
  "/magic-link/request": { email: EMAIL },
  "/oauth/grants/revoke": { clientId: "x" },
  "/organizations/active": { organizationId: null },
  "/organizations/check-slug": { slug: "acme" },
  "/organizations/create": { slug: "acme", name: "Acme" },
  "/organizations/delete": { organizationId: "x" },
  "/organizations/has-permission": { organizationId: "x", permissions: { member: ["read"] } },
  "/organizations/invitations/accept": { token: "x" },
  "/organizations/invitations/decline": { token: "x" },
  "/organizations/invitations/revoke": { organizationId: "x", invitationId: "y" },
  "/organizations/invite": { organizationId: "x", email: "bob@example.com", role: "member" },
  "/organizations/members/add": { organizationId: "x", userId: "y", role: "member" },
  // revokeTokens asks the fresh rule (plan 12k Task 8); a plain removal does not.
  "/organizations/members/remove": { organizationId: "x", userId: "y", revokeTokens: true },
  "/organizations/members/role": { organizationId: "x", userId: "y", role: "member" },
  "/organizations/roles/create": { organizationId: "x", name: "editor", permissions: {} },
  "/organizations/roles/delete": { organizationId: "x", name: "editor" },
  "/organizations/roles/update": { organizationId: "x", name: "editor" },
  "/organizations/teams/active": { teamId: null },
  "/organizations/teams/create": { organizationId: "x", name: "Core" },
  "/organizations/teams/delete": { teamId: "x" },
  "/organizations/teams/members/add": { teamId: "x", userId: "y" },
  "/organizations/teams/members/remove": { teamId: "x", userId: "y" },
  "/organizations/teams/update": { teamId: "x", name: "Core" },
  "/organizations/tokens": { organizationId: "x", name: "CI", permissions: {} },
  "/organizations/tokens/revoke": { organizationId: "x", id: "y" },
  "/organizations/tokens/update": { organizationId: "x", id: "y" },
  "/organizations/update": { organizationId: "x" },
  "/otp/request": { email: EMAIL },
  "/otp/reset": { email: EMAIL, code: "000000", password: "another long password" },
  "/otp/reset/request": { email: EMAIL },
  "/otp/verify": { email: EMAIL, code: "000000" },
  "/passkey/authenticate/verify": { response: credential },
  "/passkey/register/verify": { response: credential },
  "/passkeys/delete": { id: "x" },
  "/phone/request": { phone: "+14155550100" },
  "/phone/verify": { phone: "+14155550100", code: "000000" },
  "/phone/add": { phone: "+14155550101" },
  "/phone/add/verify": { code: "000000" },
  "/passkeys/rename": { id: "x", name: "Phone" },
  "/password/change": { newPassword: "another long password" },
  "/password/reset/request": { email: EMAIL },
  "/password/sign-in": { email: EMAIL, password: "another long password" },
  "/password/sign-up": { email: "new@example.com", password: "another long password" },
  "/password/verify/code": { email: EMAIL, code: "000000" },
  "/password/verify/resend": { email: EMAIL },
  "/reauth": { password: "another long password" },
  "/second-factor/disable": { method: "email", password: "x" },
  "/second-factor/email/enable": { password: "x" },
  "/second-factor/email/send": { challenge: "x" },
  "/second-factor/passkey/enable": { password: "x", response: credential },
  "/second-factor/passkey/options": { challenge: "x" },
  "/sessions/revoke": { id: "x" },
  "/tokens": { name: "CI" },
  "/tokens/revoke": { id: "x" },
  "/totp/backup-codes": { code: "000000" },
  "/totp/disable": { code: "000000" },
  "/totp/enable": { code: "000000" },
  "/totp/setup": { password: "x" },
  "/totp/verify": { challenge: "x" },
  "/user/change-email": { newEmail: "new@example.com" },
  "/user/change-email/verify": { code: "000000" },
  "/user/update": { name: "Ada" },
  "/user/username": { username: "Ada" },
};

/** Each POST route's answer to a stale session of a verified user with no password and no factor. */
async function probe(): Promise<Map<string, { status: number; error: string | undefined }>> {
  const auth = makeAuth({
    social: SOCIAL,
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE] },
    handoff: { schemes: ["example://"] },
    organizations: { dynamicRoles: {}, teams: {} },
    password: {},
    oauth: { resources: [`${BASE}/mcp`], registration: { cimd: false, dynamic: true } },
    operator: { secretHash: "0".repeat(64) },
    username: {},
    phone: { sms: createRecordingSms(), regions: ["+1"], isolateLimiter: "allow" },
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const user = await auth.seedUser(EMAIL);
  const out = new Map<string, { status: number; error: string | undefined }>();
  for (const route of ROUTES.filter((r) => r.method === "POST")) {
    // A new session per route, two days old: past freshMinutes (1440), inside the ttl.
    const { token } = await createSession(auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    auth.clock.advance(2 * DAY);
    const res = await handle(
      post(`/auth${route.path.replace(":provider", "google")}`, BODIES[route.path] ?? {}, {
        cookie: `__Host-tempo_session=${token}`,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    out.set(route.path, { status: res.status, error: body.error });
  }
  return out;
}

/**
 * Each SSO and SCIM owner POST route's answer to a stale session (plan 12d
 * Task 13). The manager guard checks the owner and the second factor before
 * the fresh rule, so the caller is an owner with a factor, as `scimAuth`
 * makes one. Each id names a row that exists, so the guard finds its
 * organization. A stale session changes nothing.
 */
async function ownerProbe(): Promise<Map<string, { status: number; error: string | undefined }>> {
  const w = await scimAuth({ sso: { oidc: true } });
  const owner = await w.storage.findOne("user", [
    { field: "email", op: "eq", value: "owner@acme.example" },
  ]);
  if (!owner) throw new Error("no owner");
  const connection = await createConnection(w.config, SCIM_APP, {
    organizationId: w.org,
    kind: "oidc",
    label: "Acme",
    issuer: "https://login.acme.example",
    clientId: "client",
    clientSecret: "secret",
  });
  if (!connection.ok) throw new Error("no connection");
  const token = await scimToken(w);
  const bodies: Readonly<Record<string, unknown>> = {
    "/sso/domains/add": { organizationId: w.org, domain: "two.example" },
    "/sso/domains/verify": { id: w.domainId },
    "/sso/domains/update": { id: w.domainId },
    "/sso/domains/delete": { id: w.domainId },
    "/sso/connections/create": { kind: "oidc", label: "Two" },
    "/sso/connections/update": {},
    "/sso/connections/delete": { id: connection.value.id },
    "/scim/tokens/create": { organizationId: w.org, name: "next" },
    "/scim/tokens/revoke": { id: token.id },
  };
  // The two connection writes name their row in the query (plan 12l).
  const queries: Readonly<Record<string, string>> = {
    "/sso/connections/create": `?organizationId=${encodeURIComponent(w.org)}`,
    "/sso/connections/update": `?id=${encodeURIComponent(connection.value.id)}`,
  };
  const out = new Map<string, { status: number; error: string | undefined }>();
  for (const route of ROUTES.filter(
    (r) =>
      r.method === "POST" &&
      (r.feature === "sso" || r.feature === "scim") &&
      (r.auth as readonly string[]).includes("session"),
  )) {
    const { token: session } = await createSession(w.config, {
      userId: owner.id,
      ip: null,
      userAgent: null,
    });
    w.clock.advance(2 * DAY);
    const res = await w.handle(
      post(`/auth${route.path}${queries[route.path] ?? ""}`, bodies[route.path] ?? {}, {
        cookie: `__Host-tempo_session=${session}`,
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    out.set(route.path, { status: res.status, error: body.error });
  }
  return out;
}

/** The client's call table: each operation's POST path. */
function clientCalls(): { operation: string; path: string }[] {
  return [
    ...callsSource.matchAll(/operation: "([^"]+)",\s*method: "POST",\s*path: "([^"]+)"/g),
  ].map((m) => ({ operation: m[1] ?? "", path: m[2] ?? "" }));
}

/** The calls of the README's "A fresh session." list. */
function readmeList(): string[] {
  const lines = readme.split("\n");
  const at = lines.findIndex((l) => l.startsWith("**A fresh session.**"));
  const end = lines.findIndex((l, i) => i > at && l.startsWith("`withFresh` gives"));
  if (at < 0 || end < 0) throw new Error("no fresh list in the client README");
  return lines
    .slice(at + 1, end)
    .filter((l) => /^(- | {2}`)/.test(l))
    .flatMap((l) => [...l.matchAll(/`([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)`/g)].map((m) => m[1] ?? ""))
    .sort();
}

describe("the routes that answer session_not_fresh and the client README list", () => {
  it("probes every POST route past its body parse", async () => {
    const answers = await probe();
    const parsed = [...answers].filter(([, a]) => a.error === "invalid_body").map(([p]) => p);
    expect(parsed).toEqual([]);
  });

  it("probes each SSO and SCIM owner POST route of plan 12d up to its fresh rule", async () => {
    const answers = await ownerProbe();
    expect([...answers.keys()].sort()).toEqual([
      "/scim/tokens/create",
      "/scim/tokens/revoke",
      "/sso/connections/create",
      "/sso/connections/delete",
      "/sso/connections/update",
      "/sso/domains/add",
      "/sso/domains/delete",
      "/sso/domains/update",
      "/sso/domains/verify",
    ]);
    for (const [path, a] of answers)
      expect({ path, ...a }).toEqual({ path, status: 403, error: "session_not_fresh" });
  });

  it("are the same: each listed call reaches a fresh route, and each fresh route is a listed call's", async () => {
    const answers = new Map([...(await probe()), ...(await ownerProbe())]);
    const fresh = [...answers]
      .filter(([, a]) => a.status === 403 && a.error === "session_not_fresh")
      .map(([p]) => p)
      .sort();
    const calls = clientCalls();
    const listed = readmeList();
    // Plan 12k Task 7 adds tokens.update; Task 8 adds the two organization token
    // calls and organizations.members.remove. Plan 12d Task 13 adds sso.domains,
    // sso.connections, and scim.tokens. Plan 12i Task 2 adds username.set,
    // and Task 5 phone.add, phone.verifyAdd, and phone.remove.
    expect(listed).toHaveLength(30);
    const ops = (name: string) =>
      calls.filter((c) => c.operation === name || c.operation.startsWith(`${name}.`));
    // A listed call with no fresh route: the README promises a rule that the code lacks.
    expect(listed.filter((name) => !ops(name).some((c) => fresh.includes(c.path)))).toEqual([]);
    // A fresh route that no listed call reaches: the code has a rule that the README omits.
    const reached = new Set(listed.flatMap((name) => ops(name).map((c) => c.path)));
    expect(fresh.filter((p) => !reached.has(p))).toEqual([]);
  });
});
