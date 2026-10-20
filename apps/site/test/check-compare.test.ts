import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { CODE_FACTS, checkCompare, denies } from "../scripts/check-compare.ts";
import { configKeyPaths } from "../scripts/lib/config-keys.ts";
import { COMPARE_ROWS } from "../src/data/compare.ts";

/** The real code facts of this tree. */
const code = { routes: ROUTES, keys: configKeyPaths() };

/** Rows of /compare/ at 86c5a94, as plan 11b wrote them, before plan 12e moved them. */
const BEFORE_12E = [
  {
    id: "a8",
    topic: "Introspection (RFC 7662)",
    authtempo: "No introspection route. A resource server checks the JWT offline.",
  },
  {
    id: "a12",
    topic: "Sign-out at the provider (OIDC)",
    authtempo: "No sign-out at the provider. A sign-out does not end an access token.",
  },
  { id: "a13", topic: "Device grant (RFC 8628)", authtempo: "No device grant." },
  { id: "a19", topic: "DPoP (RFC 9449)", authtempo: "Bearer access tokens only." },
  {
    id: "a20",
    topic: "Client keys (RFC 7523)",
    authtempo: "No client authentication by a key, because no client is confidential.",
  },
  {
    id: "a25",
    topic: "MCP authorization, revision 2026-07-28",
    authtempo:
      "Targets the revision, but serves public clients only, and turns dynamic registration on by default.",
  },
  { id: "b13", topic: "Device authorization plugin", authtempo: "Not supported." },
];

// Ruling 55 of plan 12e: a cell that denies a route or a config key fails while the code holds it.
describe("check-compare", () => {
  it("passes the rows of /compare/ on this tree, with every fact held", () => {
    const r = checkCompare({ rows: COMPARE_ROWS, ...code });
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ rows: 74, facts: 6, held: 6 });
    expect(CODE_FACTS.map((f) => f.name)).toEqual([
      "introspection",
      "the device grant",
      "sign-out at the provider",
      "DPoP",
      "confidential clients",
      "dynamic registration",
    ]);
  });

  it("fails each row of 86c5a94 that denies a feature of plan 12e", () => {
    expect(checkCompare({ rows: BEFORE_12E, ...code }).failures).toEqual([
      "cmp-a8 denies introspection, and ROUTES has /oauth/introspect",
      "cmp-a13 denies the device grant, and ROUTES has the feature oauthDevice",
      "cmp-b13 denies the device grant, and ROUTES has the feature oauthDevice",
      "cmp-a12 denies sign-out at the provider, and ROUTES has /oauth/end-session",
      "cmp-a19 denies DPoP, and the config has the key oauth.dpop",
      "cmp-a20 denies confidential clients, and a route of ROUTES takes clientSecretBasic",
      "cmp-a25 denies confidential clients, and a route of ROUTES takes clientSecretBasic",
    ]);
  });

  it("passes a denial while the code lacks the feature", () => {
    const routes = ROUTES.filter((r) => r.path !== "/oauth/introspect");
    const r = checkCompare({ rows: BEFORE_12E.slice(0, 1), routes, keys: code.keys });
    expect(r.failures).toEqual([]);
    expect(r.counts.held).toBe(5);
  });

  it("passes a cell that names a feature and denies another thing", () => {
    expect(
      denies("OAuth grants", "The device grant, which oauth.device turns on.", "device grant"),
    ).toBe(false);
    expect(
      denies(
        "PKCE",
        "A confidential client may omit it only when it asks for openid.",
        "confidential",
      ),
    ).toBe(false);
    expect(denies("Hooks", "No request hook.", "DPoP")).toBe(false);
  });

  it("fails a list with no row, so it never reads nothing", () => {
    expect(checkCompare({ rows: [], ...code }).failures).toEqual(["read 0 rows"]);
  });
});
