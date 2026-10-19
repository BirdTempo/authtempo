import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { REPO, SITE } from "../scripts/lib/paths.ts";
import { findRoot } from "../src/data/repo.ts";

const MODULE = pathToFileURL(`${SITE}src/data/repo.ts`).href;
/** This checkout's root, with no trailing slash, as repo.ts gives it. */
const ROOT = REPO.replace(/\/$/, "");

// A folder that looks like another checkout: it holds its own pnpm-workspace.yaml.
const other = mkdtempSync(join(tmpdir(), "authtempo-other-checkout-"));
writeFileSync(join(other, "pnpm-workspace.yaml"), "packages: []\n");
afterAll(() => rmSync(other, { recursive: true, force: true }));

/** REPO_ROOT as a new Node process reads it, started in `cwd`, after `before` runs. */
function rootFrom(cwd: string, before = ""): string {
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `${before} const m = await import(${JSON.stringify(MODULE)}); console.log(m.REPO_ROOT);`,
    ],
    { cwd, encoding: "utf8" },
  );
  return run.status === 0
    ? run.stdout.trim()
    : `exit ${run.status}: ${run.stderr.trim().split("\n")[0]}`;
}

describe("the repository root of src/data/repo.ts (ruling 23 of the plan 11b lane)", () => {
  it("finds this checkout from the module's own file, from another checkout", () => {
    expect(rootFrom(other)).toBe(ROOT);
  });

  it("finds this checkout from a folder outside any workspace", () => {
    expect(rootFrom("/")).toBe(ROOT);
  });

  // A build started in another folder writes its chunks under that folder, so
  // the config passes the root that it finds from its own file (ruling 24).
  it("gives the Astro build the root of this checkout through vite.define", async () => {
    const config = (await import("../astro.config.mjs")).default as {
      vite?: { define?: Record<string, unknown> };
    };
    expect(config.vite?.define?.__AUTHTEMPO_REPO_ROOT__).toBe(JSON.stringify(ROOT));
  });

  // The Astro build writes the value in place of the name; a global gives the
  // same name a value here, so the branch of repo.ts that takes it runs.
  it("takes the root that the build defines, in place of the walk", () => {
    const probe = "/probe/root/of/the/build";
    expect(rootFrom(other, `globalThis.__AUTHTEMPO_REPO_ROOT__ = ${JSON.stringify(probe)};`)).toBe(
      probe,
    );
  });

  it("fails closed when no folder up to the file system root holds pnpm-workspace.yaml", () => {
    expect(() => findRoot("/")).toThrow("repo.ts: no pnpm-workspace.yaml at or above /");
  });
});
