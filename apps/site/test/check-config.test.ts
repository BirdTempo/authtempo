import { describe, expect, it } from "vitest";
import { checkConfig } from "../scripts/check-config.ts";
import { configKeyPaths } from "../scripts/lib/config-keys.ts";

const table = (keys: string[]) =>
  `<table><thead><tr><th>Key</th></tr></thead><tbody>${keys.map((k) => `<tr><td><code>${k}</code></td><td>x</td></tr>`).join("")}</tbody></table>`;

describe("checkConfig", () => {
  it("lists 187 keys, the nested ones by their path", () => {
    const keys = configKeyPaths();
    // Plan 12e adds oauth.registration.initialAccessTokenHash, oauth.introspection,
    // oauth.dpop, oauth.dpop.algs, oauth.dpop.windowSeconds, oauth.signInURL,
    // oauth.refreshReuseSeconds, oauth.device, oauth.device.codeTtlMinutes,
    // oauth.device.interval, oauth.devicePage, and oauth.defaultResource (ruling 52).
    // Plan 12f adds operator.secrets, operator.users, operator.impersonation, the three
    // keys of operator.secrets[], and the two keys of operator.impersonation.
    // Plan 12f Task 4 adds hooks.operator.
    // Plan 12k Task 2 adds organizations.roles and organizations.statements.
    // Plan 12k Task 4 adds organizations.dynamicRoles and its maxPerOrganization.
    // Plan 12k Task 5 adds organizations.teams, its defaultTeam and keepLastTeam,
    // and the limits teamsPerOrganization and membersPerTeam.
    // Plan 12k Task 7 adds tokens, tokens.defaultRateLimit, and tokens.movedPrefixes.
    expect(keys.length).toBe(187);
    expect(keys).toContain("hooks.operator");
    expect(keys).toContain("operator.secrets[].scopes");
    expect(keys).toContain("operator.impersonation.ttlMinutes");
    expect(keys).toContain("organizations.dynamicRoles.maxPerOrganization");
    expect(keys).toContain("organizations.teams.keepLastTeam");
    expect(keys).toContain("organizations.limits.membersPerTeam");
    expect(keys).toContain("tokens.movedPrefixes");
    expect(keys).toContain("organizations.roles");
    expect(keys).toContain("organizations.statements");
    expect(keys).toContain("organizations.dynamicRoles");
    expect(keys).toContain("organizations.teams");
    expect(keys).toContain("organizations.limits.teamsPerOrganization");
    expect(keys).toContain("tokens.defaultRateLimit");
    expect(keys).toContain("oauth.defaultResource");
    expect(keys).toContain("oauth.device.interval");
    expect(keys).toContain("oauth.signInURL");
    expect(keys).toContain("oauth.refreshReuseSeconds");
    expect(keys).toContain("oauth.dpop.windowSeconds");
    expect(keys).toContain("oauth.registration.initialAccessTokenHash");
    expect(keys).toContain("oauth.introspection");
    expect(keys).toContain("account.deleteConfirm.ttlMinutes");
    expect(keys).toContain("account.notices.mail");
    expect(keys).toContain("password.minLength");
    expect(keys).toContain("social.oidc[].endpoints.jwksUrl");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("passes a page with one row per key", () => {
    const r = checkConfig(table(["basePath", "password.minLength"]), [
      "basePath",
      "password.minLength",
    ]);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ keys: 2, rows: 2 });
  });

  it("refuses a key with no row and a row that names no key", () => {
    const r = checkConfig(table(["basePath", "password.maxLength"]), [
      "basePath",
      "password.minLength",
    ]);
    expect(r.failures).toEqual([
      "config key password.minLength has no row",
      "row password.maxLength names no config key",
    ]);
  });

  it("fails when it reads no key", () => {
    expect(checkConfig("", []).failures).toEqual(["read 0 keys", "read 0 rows"]);
  });
});
