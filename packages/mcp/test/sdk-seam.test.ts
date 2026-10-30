// The one seam to the MCP SDK (plan 11e, final review L3). Two files import
// the SDK: packages/mcp/src/protocol.ts and examples/mcp-server/src/mcp.ts.
// No other workspace package names an SDK package as a dependency.
// The sets are typed here and compared both ways. So a seam file that loses
// its import fails too, and a scan that reads nothing cannot pass.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./support/bin.js";

/** A module name of the SDK in quotes: an import, an export, or a dynamic import. */
const SDK_SPECIFIER = /["'`]@modelcontextprotocol\//;

/** The folders that a walk skips: installs, builds, and caches. */
const SKIP = new Set(["node_modules", "dist", ".turbo", ".wrangler", ".astro", ".git"]);

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path, keep, out);
    else if (keep(e.name)) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(REPO, path);

/**
 * The manifest of each workspace package, from the `packages` list of
 * pnpm-workspace.yaml, the one source. A list of folders here missed
 * scripts/release (ruling 64 of plan 12j, Minor 3). An entry `<dir>/*`
 * names each folder of <dir> with a package.json, and any other entry names
 * its own folder.
 */
function workspaceManifests(): string[] {
  const yaml = readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8");
  const block = /^packages:\n((?:[ \t]+(?:-.*|#.*)\n)+)/m.exec(yaml)?.[1] ?? "";
  const entries = [...block.matchAll(/^[ \t]+-[ \t]+["']?([^"'\s#]+)["']?/gm)].map(
    (m) => m[1] ?? "",
  );
  expect(entries.length, "the packages list of pnpm-workspace.yaml").toBeGreaterThan(0);
  return entries.flatMap((entry) => {
    if (!entry.endsWith("/*")) return [join(REPO, entry, "package.json")];
    const dir = entry.slice(0, -2);
    return readdirSync(join(REPO, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(REPO, dir, e.name, "package.json")))
      .map((e) => join(REPO, dir, e.name, "package.json"));
  });
}

describe("the SDK seam", () => {
  it("lets only protocol.ts and the example's mcp.ts import the SDK", () => {
    const files = ["packages/mcp/src", "examples/mcp-server/src"].flatMap((d) =>
      walk(join(REPO, d), (n) => /\.(ts|mts|js|mjs)$/.test(n)),
    );
    // bin/authtempo-mcp.ts, server.ts, and the example's four files at least.
    expect(files.length).toBeGreaterThan(15);
    const importers = files.filter((f) => SDK_SPECIFIER.test(readFileSync(f, "utf8"))).map(rel);
    expect(importers.sort()).toEqual(
      ["examples/mcp-server/src/mcp.ts", "packages/mcp/src/protocol.ts"].sort(),
    );
  });

  it("lets only packages/mcp and examples/mcp-server depend on an SDK package", () => {
    const manifests = workspaceManifests();
    manifests.push(join(REPO, "package.json"));
    // The cli and verify are named in the review, and the release package is a
    // workspace package of its own; each must be in the walk.
    for (const pkg of [
      "packages/cli/package.json",
      "packages/verify/package.json",
      "scripts/release/package.json",
    ])
      expect(manifests.map(rel)).toContain(pkg);
    for (const file of manifests) expect(existsSync(file), rel(file)).toBe(true);
    const dependents = manifests
      .filter((f) => {
        const json = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
        const names = [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ]
          .flatMap((k) => Object.keys((json[k] as Record<string, string> | undefined) ?? {}))
          .filter((n) => n.startsWith("@modelcontextprotocol/"));
        return names.length > 0;
      })
      .map(rel);
    expect(dependents.sort()).toEqual(
      ["examples/mcp-server/package.json", "packages/mcp/package.json"].sort(),
    );
  });
});
