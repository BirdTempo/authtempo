import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { openApiDocument, openApiJson, openApiOptionsFrom } from "../src/openapi/index.js";
import { noSecretInput, SECRETS } from "./no-secret-config.js";

function config() {
  return resolveConfig(noSecretInput());
}

describe("the OpenAPI document holds no secret (plan 11g, spec 25 item 10)", () => {
  it("holds no value of the config that is not one of the six keys", () => {
    const c = config();
    const doc = openApiJson(openApiDocument(openApiOptionsFrom(c)));
    const options = JSON.stringify(openApiOptionsFrom(c));
    // The document is of this config: the operator route and a provider route are in it.
    expect(doc).toContain('"/operator/keys/rotate"');
    expect(doc).toContain('"/social/{provider}/start"');
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(doc.includes(value), `${name} in the document`).toBe(false);
      expect(options.includes(value), `${name} in the options`).toBe(false);
    }
  });

  it("takes the six keys only", () => {
    expect(Object.keys(openApiOptionsFrom(config())).sort()).toEqual([
      "basePath",
      "cookieName",
      "features",
      "scopes",
      "serverUrl",
      "version",
    ]);
  });
});
