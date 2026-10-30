/**
 * The version of core. Two readers import this module, never the package
 * barrel: `GET /operator/info` answers it (plan 11c2), and the OpenAPI
 * generator writes it (plan 11g), so the document reads no barrel and no
 * config value. The build writes the value from package.json into
 * version.generated.ts (scripts/write-version.mjs, ruling 65 of plan 12j), so
 * a release answers its own version. test/version.test.ts holds it.
 */
export { VERSION } from "./version.generated.js";
