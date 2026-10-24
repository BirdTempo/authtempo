import { describe, expect, it } from "vitest";
import { checkConfig } from "../scripts/check-config.ts";
import { configKeyPaths } from "../scripts/lib/config-keys.ts";

const table = (keys: string[]) =>
  `<table><thead><tr><th>Key</th></tr></thead><tbody>${keys.map((k) => `<tr><td><code>${k}</code></td><td>x</td></tr>`).join("")}</tbody></table>`;

describe("checkConfig", () => {
  it("lists 267 keys, the nested ones by their path", () => {
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
    // Plan 12h Task 2 adds observe, its six keys, and the three keys of observe.include.
    // Plan 12d Task 2b adds sso, its five keys, sso.saml.clockSkewSeconds, and the two
    // keys of sso.limits.
    // Plan 12d Task 9b adds scim, scim.groups, and scim.defaultRole.
    // Plan 12d Task 5 adds totp.gate.sso and hooks.sso. Task 10 adds hooks.scim.
    // Plan 12i Task 13 adds social.microsoft, social.discord, social.gitlab, and their eight keys.
    // Plan 12i Task 9 adds passkey.relatedOrigins, passkey.hints, and its two keys.
    // Plan 12i Task 19 adds social.stateData and social.stateData.maxBytes.
    // Plan 12i Task 2 adds username and its three keys.
    // Plan 12i Task 4 adds phone and its nine keys.
    // Plan 12i Task 12 adds lastMethod, its two keys, and redirectURI on the seven
    // presets and the two lists.
    // Plan 12i Task 14 adds social.slack, social.twitter, social.facebook, and their nine keys.
    // Plan 12i Task 21 adds passkey.extensions and its three keys.
    expect(keys.length).toBe(255 + 12 + 4);
    expect(keys).toContain("passkey.extensions.largeBlob");
    expect(keys).toContain("social.twitter.redirectURI");
    expect(keys).toContain("lastMethod.days");
    expect(keys).toContain("social.oauth2[].redirectURI");
    expect(keys).toContain("username.reserved");
    expect(keys).toContain("phone.dailyCap");
    expect(keys).toContain("social.microsoft.tenant");
    expect(keys).toContain("social.stateData.maxBytes");
    expect(keys).toContain("social.gitlab.issuer");
    expect(keys).toContain("passkey.hints.signIn");
    expect(keys).toContain("observe.include.email");
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
