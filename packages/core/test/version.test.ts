import { describe, expect, it } from "vitest";
import distText from "../dist/version.generated.js?raw";
import manifestText from "../package.json?raw";
import { VERSION } from "../src/version.js";

// Ruling 65 of plan 12j, M2: one source for the version of core. The build
// writes src/version.generated.ts from package.json (scripts/write-version.mjs),
// so `changeset version` moves the constant with the manifest. Before, VERSION
// stayed 0.0.0 in the tarball of 0.1.0, and GET /operator/info and the
// OpenAPI document said so. apps/site/test/write-version.test.ts holds the script.
const manifest = JSON.parse(manifestText) as { version: string; scripts: Record<string, string> };

describe("the version of core", () => {
  it("is the version of package.json, in src and in the built dist", () => {
    expect(VERSION).toBe(manifest.version);
    // The test task waits for the build of core (turbo.json), so dist is this build.
    expect(distText).toContain(`export const VERSION = ${JSON.stringify(manifest.version)};`);
    // The build and the typecheck write the module first.
    for (const key of ["build", "typecheck"])
      expect(manifest.scripts[key], key).toContain("node ../../scripts/write-version.mjs VERSION");
  });
});
