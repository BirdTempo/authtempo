import { describe, expect, it } from "vitest";
import { checkConfig } from "../scripts/check-config.ts";
import { configKeyPaths } from "../scripts/lib/config-keys.ts";

const table = (keys: string[]) =>
  `<table><thead><tr><th>Key</th></tr></thead><tbody>${keys.map((k) => `<tr><td><code>${k}</code></td><td>x</td></tr>`).join("")}</tbody></table>`;

describe("checkConfig", () => {
  it("lists 121 keys, the nested ones by their path", () => {
    const keys = configKeyPaths();
    expect(keys.length).toBe(121);
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
