import { CLIENT_CALLS } from "@authtempo/client";
import { OAUTH_CALLS } from "@authtempo/client/oauth";
import { ROUTES } from "@authtempo/core/routes";
import { HANDOFF_CALLS } from "@authtempo/handoff";
import { VERIFY_CALLS } from "@authtempo/verify";
import { describe, expect, it } from "vitest";

/** Every route that no SDK calls, with the reason. A row that names no route fails the test. */
const EXEMPT: readonly { method: string; path: string; reason: string }[] = [
  {
    method: "GET",
    path: "/magic-link/verify",
    reason: "the page of the mailed link; a browser opens it",
  },
  {
    method: "GET",
    path: "/social/:provider/callback",
    reason: "the provider sends the browser back to it",
  },
  { method: "POST", path: "/social/apple/callback", reason: "Apple posts its form to it" },
  { method: "GET", path: "/password/verify", reason: "the page of the mailed verify link" },
  { method: "GET", path: "/password/reset", reason: "the reset page of the mailed link" },
  { method: "GET", path: "/totp/challenge", reason: "core's second factor page" },
  { method: "POST", path: "/totp/challenge", reason: "the form of core's second factor page" },
  {
    method: "GET",
    path: "/handoff/continue",
    reason: "the confirm page of the handoff in the system browser",
  },
  { method: "POST", path: "/handoff/continue", reason: "the button of the handoff confirm page" },
  {
    method: "POST",
    path: "/oauth/authorize",
    reason: "the consent form posts it from core's own page",
  },
  {
    method: "GET",
    path: "/oauth/sign-in",
    reason: "core's sign-in page as the login step of an authorize request",
  },
  {
    method: "POST",
    path: "/oauth/device_authorization",
    reason:
      "a device with no browser calls it (RFC 8628); no SDK of this repository runs on such a device (plan 12e Task 14)",
  },
  { method: "GET", path: "/oauth/device", reason: "core's device page; a browser opens it" },
  { method: "POST", path: "/oauth/device", reason: "the form of core's device page" },
  {
    method: "POST",
    path: "/oauth/userinfo",
    reason: "the POST form of userinfo; the OAuth client calls the GET",
  },
  {
    method: "GET",
    path: "/oauth/end-session",
    reason: "a relying party sends the browser to it (OIDC RP-Initiated Logout 1.0, plan 12e)",
  },
  {
    method: "POST",
    path: "/oauth/end-session",
    reason: "a relying party's page posts the form, and the confirmation page posts the yes",
  },
  {
    method: "GET",
    path: "/.well-known/openid-configuration",
    reason: "the same document as the authorization server metadata",
  },
  {
    method: "POST",
    path: "/operator/keys/rotate",
    reason: "the keys rotate command of the CLI calls it (plan 11c)",
  },
  {
    method: "GET",
    path: "/operator/secrets/status",
    reason: "the secret status command of the CLI calls it (plan 11c2)",
  },
  {
    method: "POST",
    path: "/operator/secrets/rewrap",
    reason: "the secret rewrap command of the CLI calls it (plan 11c2)",
  },
  {
    method: "GET",
    path: "/operator/info",
    reason: "the info command of the CLI calls it with the operator secret (plan 11c2)",
  },
  {
    method: "POST",
    path: "/operator/impersonate",
    reason:
      "an app's own admin page calls it; spec 26 item 15 adds no client SDK call for it (plan 12f)",
  },
  {
    method: "POST",
    path: "/operator/impersonate/stop",
    reason:
      "an app's own admin page calls it; spec 26 item 15 adds no client SDK call for it (plan 12f)",
  },
  {
    method: "GET",
    path: "/operator/users",
    reason:
      "an operator tool: the users list command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "GET",
    path: "/operator/users/search",
    reason:
      "an operator tool: the users search command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "GET",
    path: "/operator/users/get",
    reason:
      "an operator tool: the users get command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "POST",
    path: "/operator/users/ban",
    reason:
      "an operator tool: the users ban command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "POST",
    path: "/operator/users/unban",
    reason:
      "an operator tool: the users unban command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "POST",
    path: "/operator/users/platform-role",
    reason:
      "an operator tool: the users platform-role command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "POST",
    path: "/operator/users/second-factor/disable",
    reason:
      "an operator tool: the users second-factor-off command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "GET",
    path: "/sso/domains",
    reason:
      "an SSO owner route; client.sso of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "POST",
    path: "/sso/domains/add",
    reason:
      "an SSO owner route; client.sso of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "POST",
    path: "/sso/domains/verify",
    reason:
      "an SSO owner route; client.sso of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "POST",
    path: "/sso/domains/update",
    reason:
      "an SSO owner route; client.sso of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "POST",
    path: "/sso/domains/delete",
    reason:
      "an SSO owner route; client.sso of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "GET",
    path: "/sso/connections",
    reason:
      "an SSO owner route; client.sso of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "POST",
    path: "/sso/connections/create",
    reason:
      "an SSO owner route; client.sso of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "POST",
    path: "/sso/connections/update",
    reason:
      "an SSO owner route; client.sso of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "POST",
    path: "/sso/connections/delete",
    reason:
      "an SSO owner route; client.sso of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "POST",
    path: "/sso/discover",
    reason:
      "an SSO owner route; client.sso of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "GET",
    path: "/sso/:connectionId/start",
    reason:
      "the browser opens it from the sign-in page of core to start an SSO sign-in (plan 12d Task 4b)",
  },
  {
    method: "GET",
    path: "/sso/:connectionId/callback",
    reason: "the identity provider sends the browser back to it (plan 12d Task 4b)",
  },
  {
    method: "POST",
    path: "/sso/:connectionId/acs",
    reason: "the SAML identity provider posts the browser's form to it (plan 12d Task 8)",
  },
  {
    method: "GET",
    path: "/sso/:connectionId/metadata",
    reason:
      "an owner gives its URL to the SAML identity provider, which reads it at setup (plan 12d Task 8)",
  },
  {
    method: "POST",
    path: "/operator/sso/enforce-off",
    reason:
      "an operator override: a platform operator turns off SSO enforce for a domain with the operator secret (plan 12d Task 2b); no SDK calls it",
  },
  {
    method: "POST",
    path: "/operator/users/create-admin",
    reason:
      "an operator tool: the create-admin command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "POST",
    path: "/operator/sessions/end-user",
    reason:
      "an operator tool: the sessions end command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "POST",
    path: "/operator/sessions/end-all",
    reason:
      "an operator tool: the sessions end-all command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "GET",
    path: "/operator/audit",
    reason:
      "an operator tool: the audit list command of the CLI calls it (plan 12f); the client SDK has no operator call",
  },
  {
    method: "GET",
    path: "/user/change-email/confirm",
    reason: "the confirm page of the mailed change-of-address link; a browser opens it (plan 12a)",
  },
  {
    method: "GET",
    path: "/user/delete/confirm",
    reason: "the confirm page of the mailed delete link; a browser opens it (plan 12a Task 20)",
  },
  {
    method: "GET",
    path: "/scim/tokens",
    reason:
      "a SCIM token route of an owner; client.scim.tokens of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "POST",
    path: "/scim/tokens/create",
    reason:
      "a SCIM token route of an owner; client.scim.tokens of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "POST",
    path: "/scim/tokens/revoke",
    reason:
      "a SCIM token route of an owner; client.scim.tokens of plan 12d Task 13 calls it, and that task deletes this row",
  },
  {
    method: "GET",
    path: "/scim/v2/ServiceProviderConfig",
    reason:
      "an IdP provisioning client calls it with a SCIM token; no SDK of an app calls the SCIM server (plan 12d Task 9b)",
  },
  {
    method: "GET",
    path: "/scim/v2/ResourceTypes",
    reason:
      "an IdP provisioning client calls it with a SCIM token; no SDK of an app calls the SCIM server (plan 12d Task 9b)",
  },
  {
    method: "GET",
    path: "/scim/v2/ResourceTypes/:id",
    reason:
      "an IdP provisioning client calls it with a SCIM token; no SDK of an app calls the SCIM server (plan 12d Task 9b)",
  },
  {
    method: "GET",
    path: "/scim/v2/Schemas",
    reason:
      "an IdP provisioning client calls it with a SCIM token; no SDK of an app calls the SCIM server (plan 12d Task 9b)",
  },
  {
    method: "GET",
    path: "/scim/v2/Schemas/:id",
    reason:
      "an IdP provisioning client calls it with a SCIM token; no SDK of an app calls the SCIM server (plan 12d Task 9b)",
  },
  {
    method: "POST",
    path: "/scim/v2/Bulk",
    reason:
      "an IdP provisioning client calls it with a SCIM token; no SDK of an app calls the SCIM server (plan 12d Task 9b)",
  },
  {
    method: "GET",
    path: "/scim/v2/Me",
    reason:
      "an IdP provisioning client calls it with a SCIM token; no SDK of an app calls the SCIM server (plan 12d Task 9b)",
  },
  {
    method: "POST",
    path: "/scim/v2/.search",
    reason:
      "an IdP provisioning client calls it with a SCIM token; no SDK of an app calls the SCIM server (plan 12d Task 9b)",
  },
  {
    method: "POST",
    path: "/scim/v2/Users/.search",
    reason:
      "an IdP provisioning client calls it with a SCIM token; no SDK of an app calls the SCIM server (plan 12d Task 9b)",
  },
  {
    method: "POST",
    path: "/scim/v2/Groups/.search",
    reason:
      "an IdP provisioning client calls it with a SCIM token; no SDK of an app calls the SCIM server (plan 12d Task 9b)",
  },
  {
    method: "GET",
    path: "/openapi.json",
    reason: "a code generator or an API tool reads the document; no SDK call needs it (plan 11g)",
  },
  {
    method: "GET",
    path: "/health",
    reason: "the probe of a host or a load balancer calls it; no SDK call needs it (plan 12h)",
  },
  {
    method: "GET",
    path: "/ready",
    reason: "the probe of a host or a load balancer calls it; no SDK call needs it (plan 12h)",
  },
];

const TABLES = {
  client: CLIENT_CALLS,
  oauth: OAUTH_CALLS,
  verify: VERIFY_CALLS,
  handoff: HANDOFF_CALLS,
} as const;

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe("the SDK call tables and ROUTES (plan 11d)", () => {
  it("names a route of ROUTES in every row of every table", () => {
    const routes = new Set(ROUTES.map(key));
    for (const [name, table] of Object.entries(TABLES))
      for (const row of table) expect(routes, `${name}: ${key(row)}`).toContain(key(row));
  });

  it("calls every route of ROUTES, or names it in the exemption list with a reason", () => {
    const called = new Set(Object.values(TABLES).flatMap((t) => t.map(key)));
    const exempt = new Set(EXEMPT.map(key));
    const routes = ROUTES.map(key);
    for (const r of routes) expect(called.has(r) || exempt.has(r), r).toBe(true);
    for (const e of EXEMPT) {
      // An exemption that names no route, or a route that an SDK calls, has rotted.
      expect(routes, key(e)).toContain(key(e));
      expect(called.has(key(e)), `${key(e)} is called and exempt`).toBe(false);
      expect(e.reason.trim(), `${key(e)} has no reason`).not.toBe("");
    }
    const covered = routes.filter((r) => called.has(r)).length;
    console.log(
      `sdk routes: ${covered} called, ${EXEMPT.length} exempt, ${routes.length} of ROUTES`,
    );
    expect(covered + EXEMPT.length).toBe(routes.length);
  });
});
