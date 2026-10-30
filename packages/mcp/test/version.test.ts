import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_VERSION } from "../src/server.js";
import { PKG } from "./support/bin.js";

// Ruling 65 of plan 12j, M2: one source for the version of the server. The
// build writes src/version.generated.ts from package.json, so `changeset
// version` moves the constant with the manifest. Before, MCP_VERSION stayed
// 0.0.0 in the tarball of 0.1.0, and the server answered it.
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
  version: string;
  scripts: Record<string, string>;
};

describe("the version of the server", () => {
  it("is the version of package.json, in src and in the built dist", () => {
    expect(MCP_VERSION).toBe(manifest.version);
    // The test task waits for the build of mcp (turbo.json), so dist is this build.
    const dist = readFileSync(join(PKG, "dist/version.generated.js"), "utf8");
    expect(dist).toContain(`export const MCP_VERSION = ${JSON.stringify(manifest.version)};`);
    // The build and the typecheck write the module first.
    for (const key of ["build", "typecheck"])
      expect(manifest.scripts[key], key).toContain(
        "node ../../scripts/write-version.mjs MCP_VERSION",
      );
  });
});
