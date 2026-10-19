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
    path: "/oauth/userinfo",
    reason: "the POST form of userinfo; the OAuth client calls the GET",
  },
  {
    method: "POST",
    path: "/oauth/introspect",
    reason:
      "a resource server calls it with its own client auth; @authtempo/verify calls it from plan 12e Task 10",
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
    path: "/openapi.json",
    reason: "a code generator or an API tool reads the document; no SDK call needs it (plan 11g)",
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
