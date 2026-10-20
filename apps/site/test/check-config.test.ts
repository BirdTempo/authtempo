import { describe, expect, it } from "vitest";
import { checkConfig } from "../scripts/check-config.ts";
import { configKeyPaths } from "../scripts/lib/config-keys.ts";

const table = (keys: string[]) =>
  `<table><thead><tr><th>Key</th></tr></thead><tbody>${keys.map((k) => `<tr><td><code>${k}</code></td><td>x</td></tr>`).join("")}</tbody></table>`;

describe("checkConfig", () => {
  it("lists 175 keys, the nested ones by their path", () => {
    const keys = configKeyPaths();
    // Plan 12e adds oauth.registration.initialAccessTokenHash, oauth.introspection,
    // oauth.dpop, oauth.dpop.algs, oauth.dpop.windowSeconds, oauth.signInURL,
    // oauth.refreshReuseSeconds, oauth.device, oauth.device.codeTtlMinutes,
    // oauth.device.interval, oauth.devicePage, and oauth.defaultResource (ruling 52).
    // Plan 12f adds operator.secrets, operator.users, operator.impersonation, the three
    // keys of operator.secrets[], and the two keys of operator.impersonation.
    // Plan 12f Task 4 adds hooks.operator.
    expect(keys.length).toBe(175);
    expect(keys).toContain("hooks.operator");
    expect(keys).toContain("operator.secrets[].scopes");
    expect(keys).toContain("operator.impersonation.ttlMinutes");
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
