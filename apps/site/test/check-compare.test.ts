import { COMMANDS } from "@authtempo/cli/program";
import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { CODE_FACTS, checkCompare, denies } from "../scripts/check-compare.ts";
import { configKeyPaths } from "../scripts/lib/config-keys.ts";
import { REPO } from "../scripts/lib/paths.ts";
import { trackedFiles } from "../scripts/lib/tracked.ts";
import { COMPARE_ROWS } from "../src/data/compare.ts";

/** The real code facts of this tree. */
const code = {
  routes: ROUTES,
  keys: configKeyPaths(),
  commands: Object.keys(COMMANDS),
  tracked: trackedFiles(REPO),
};

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

/**
 * Each row of /compare/ at e232d06ae whose authtempo cell the read of
 * 2026-11-25 changed. Plans 12d to 12k shipped the features, and the rows
 * still denied them.
 */
const BEFORE_2026_11_25 = [
  {
    id: "a27",
    topic: "WebAuthn Level 3",
    authtempo:
      "Passkey autofill. No passkey-first sign-up, no extensions, no related origins, no hints, and no Signal API.",
  },
  {
    id: "a28",
    topic: "SCIM 2.0",
    authtempo: "No directory provisioning.",
  },
  {
    id: "a29",
    topic: "SAML 2.0 and SSO",
    authtempo: "No SSO for each organization.",
  },
  {
    id: "a32",
    topic: "ASVS 5.0 sessions",
    authtempo:
      "A session list, the end of one or of the others, a fresh-session rule, and an absolute lifetime. No operator ends the sessions of a user.",
  },
  {
    id: "b4",
    topic: "Passkeys",
    authtempo: "Passkeys with user verification and autofill. No passkey-first sign-up.",
  },
  {
    id: "b6",
    topic: "Email codes",
    authtempo:
      "A code for sign-in, for a reset, and for a change of address. The address check of a sign-up uses a link.",
  },
  {
    id: "b14",
    topic: "API tokens",
    authtempo:
      "API tokens of one user, with an optional organization. No scopes, no limit for each token, and no metadata.",
  },
  {
    id: "b15",
    topic: "Organizations",
    authtempo:
      "Ranked roles, invitations, limits, and hooks. No teams, no permission statements, and no custom roles.",
  },
  {
    id: "b16",
    topic: "Access control",
    authtempo: "No access control builder.",
  },
  {
    id: "b17",
    topic: "Admin tools",
    authtempo: "The operator routes cover the keys, the secrets, and the info report only.",
  },
  {
    id: "b18",
    topic: "Guest sessions",
    authtempo: "No guest session.",
  },
  {
    id: "b19",
    topic: "User name sign-in",
    authtempo: "No sign-in with a user name.",
  },
  {
    id: "b20",
    topic: "Phone sign-in",
    authtempo: "No phone sign-in.",
  },
  {
    id: "b21",
    topic: "Google One Tap",
    authtempo: "No route that takes an ID token from Google One Tap.",
  },
  {
    id: "b22",
    topic: "Several sessions",
    authtempo: "No account switch in one browser.",
  },
  {
    id: "b23",
    topic: "The last method",
    authtempo: "Not supported.",
  },
  {
    id: "b25",
    topic: "OAuth on preview hosts",
    authtempo: "No proxy, and no redirect override for each provider.",
  },
  {
    id: "b33",
    topic: "SSO plugin",
    authtempo: "Not supported.",
  },
  {
    id: "b34",
    topic: "SCIM plugin",
    authtempo: "Not supported.",
  },
  {
    id: "d1",
    topic: "Schema output",
    authtempo: "No schema output. The adapters ship SQL migration files.",
  },
  {
    id: "d4",
    topic: "A first operator account",
    authtempo: "No command for a first operator account.",
  },
  {
    id: "d6",
    topic: "Upgrade command",
    authtempo: "No upgrade command.",
  },
  {
    id: "f15",
    topic: "Disclosure policy",
    authtempo: "No SECURITY.md yet.",
  },
  {
    id: "g1",
    topic: "Database adapters",
    authtempo: "D1, Postgres, and memory.",
  },
  {
    id: "g2",
    topic: "Migrations and ORM schemas",
    authtempo: "Append-only SQL files and authtempo migrate. No ORM schema output.",
  },
  {
    id: "g7",
    topic: "OpenTelemetry",
    authtempo: "Fixed log lines with event names. No spans and no metrics.",
  },
];

// Ruling 55 of plan 12e: a cell that denies a route or a config key fails while the code holds it.
describe("check-compare", () => {
  it("passes the rows of /compare/ on this tree, with every fact held", () => {
    const r = checkCompare({ rows: COMPARE_ROWS, ...code });
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ rows: 74, facts: 31, held: 31 });
    expect(CODE_FACTS.map((f) => f.name)).toEqual([
      "introspection",
      "the device grant",
      "sign-out at the provider",
      "DPoP",
      "confidential clients",
      "dynamic registration",
      "SCIM",
      "SSO",
      "the end of sessions by an operator",
      "the operator user tools",
      "passkey-first sign-up",
      "passkey extensions",
      "related origins",
      "passkey hints",
      "a rate limit for each token",
      "teams",
      "permission statements",
      "custom roles",
      "access control",
      "guest sessions",
      "user name sign-in",
      "phone sign-in",
      "Google One Tap",
      "several sessions",
      "the last method",
      "a redirect override",
      "schema output",
      "a first operator account",
      "the upgrade command",
      "SECURITY.md",
      "spans and metrics",
    ]);
  });

  it("fails each row of e232d06ae that denies a feature of plans 12d to 12k", () => {
    expect(checkCompare({ rows: BEFORE_2026_11_25, ...code }).failures).toEqual([
      "cmp-a28 denies SCIM, and ROUTES has the feature scim",
      "cmp-b34 denies SCIM, and ROUTES has the feature scim",
      "cmp-a29 denies SSO, and ROUTES has the feature sso",
      "cmp-b33 denies SSO, and ROUTES has the feature sso",
      "cmp-a32 denies the end of sessions by an operator, and ROUTES has /operator/sessions/end-user",
      "cmp-b17 denies the operator user tools, and ROUTES has /operator/users",
      "cmp-a27 denies passkey-first sign-up, and ROUTES has the feature passkeySignUp",
      "cmp-b4 denies passkey-first sign-up, and ROUTES has the feature passkeySignUp",
      "cmp-a27 denies passkey extensions, and the config has the key passkey.extensions",
      "cmp-a27 denies related origins, and ROUTES has the feature passkeyRelatedOrigins",
      "cmp-a27 denies passkey hints, and the config has the key passkey.hints",
      "cmp-b14 denies a rate limit for each token, and the config has the key tokens.defaultRateLimit",
      "cmp-b15 denies teams, and ROUTES has the feature teams",
      "cmp-b15 denies permission statements, and the config has the key organizations.statements",
      "cmp-b15 denies custom roles, and the config has the key organizations.roles",
      "cmp-b16 denies access control, and the config has the key organizations.statements",
      "cmp-b18 denies guest sessions, and ROUTES has the feature anonymous",
      "cmp-b19 denies user name sign-in, and ROUTES has the feature username",
      "cmp-b20 denies phone sign-in, and ROUTES has the feature phone",
      "cmp-b21 denies Google One Tap, and ROUTES has the feature socialIdToken",
      "cmp-b22 denies several sessions, and ROUTES has the feature multiSession",
      "cmp-b23 denies the last method, and the config has the key lastMethod",
      "cmp-b25 denies a redirect override, and the config has the key social.google.redirectURI",
      "cmp-d1 denies schema output, and the CLI has the command generate",
      "cmp-g2 denies schema output, and the CLI has the command generate",
      "cmp-d4 denies a first operator account, and the CLI has the command create-admin",
      "cmp-d6 denies the upgrade command, and the CLI has the command upgrade",
      "cmp-f15 denies SECURITY.md, and the repository has SECURITY.md",
      "cmp-g7 denies spans and metrics, and the repository has packages/observe/src/otlp.ts",
    ]);
  });

  // The limit of this check: a cell that names an old thing and denies nothing
  // passes. b6 said that the address check uses a link, and g1 listed three
  // adapters. A person must read such a row when its plan merges.
  it("does not catch a cell of e232d06ae that denies nothing in words", () => {
    const failures = checkCompare({ rows: BEFORE_2026_11_25, ...code }).failures.join("\n");
    expect(failures).not.toMatch(/cmp-b6 |cmp-g1 /);
  });

  it("passes a denial while the CLI lacks the command or the repository lacks the file", () => {
    const rows = BEFORE_2026_11_25.filter((x) => x.id === "d6" || x.id === "f15");
    expect(checkCompare({ rows, ...code }).failures).toHaveLength(2);
    const r = checkCompare({
      rows,
      ...code,
      commands: code.commands.filter((c) => c !== "upgrade"),
      tracked: { files: new Set(["packages/observe/src/otlp.ts"]) },
    });
    expect(r.failures).toEqual([]);
    expect(r.counts.held).toBe(29);
  });

  it("fails with no list of tracked files, so a file fact never passes unread", () => {
    const r = checkCompare({
      rows: COMPARE_ROWS,
      ...code,
      tracked: { error: "git ls-files failed: not a git repository" },
    });
    expect(r.failures).toEqual([
      "the file facts are not checked: git ls-files failed: not a git repository",
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
    const r = checkCompare({ rows: BEFORE_12E.slice(0, 1), ...code, routes });
    expect(r.failures).toEqual([]);
    expect(r.counts.held).toBe(30);
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
