import { readFileSync } from "node:fs";
import { SCHEMA_VERSION } from "@authtempo/core";

/**
 * The version of this package. dist/version.js reads ../package.json, which
 * every pack holds; a test of src reads the same file.
 */
export const CLI_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** The schema version of the core this CLI bundles: the version that `migrate` and `check` expect. */
export { SCHEMA_VERSION };
