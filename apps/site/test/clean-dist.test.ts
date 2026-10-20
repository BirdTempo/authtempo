import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO } from "../scripts/lib/paths.ts";

// Final review of plan 12e, L1: tsc deletes no file, so the output of a removed
// source stayed in dist and a pack counted it. Each package build empties dist first.

const CLEAN = "node ../../scripts/clean-dist.mjs && ";

/** The name and build script of each package under packages/ that has a build. */
const builds = readdirSync(`${REPO}packages`, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(`${REPO}packages/${d.name}/package.json`))
  .map((d) => {
    const pkg = JSON.parse(readFileSync(`${REPO}packages/${d.name}/package.json`, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return { name: d.name, build: pkg.scripts?.build };
  })
  .filter((p): p is { name: string; build: string } => p.build !== undefined);

const temp = mkdtempSync(join(tmpdir(), "clean-dist-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("the package builds", () => {
  it("empties dist first in each package build", () => {
    // 24 builds counted 2026-10-20; sdk-conformance has no build.
    expect(builds.length).toBeGreaterThanOrEqual(24);
    const wrong = builds.filter((p) => !p.build.startsWith(CLEAN)).map((p) => p.name);
    expect(wrong).toEqual([]);
  });

  it("lets each test wait for its own build in turbo.json", () => {
    const text = readFileSync(`${REPO}turbo.json`, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const tasks = (JSON.parse(text) as { tasks: Record<string, { dependsOn?: string[] }> }).tasks;
    expect(tasks.test?.dependsOn).toEqual(["^build", "build"]);
  });

  it("leaves no stale file in dist after the build of verify", () => {
    // A copy of the package layout: <root>/scripts is the repo's own folder,
    // and <root>/packages/probe holds one source and one stale output.
    const root = join(temp, "repo");
    const probe = join(root, "packages", "probe");
    mkdirSync(join(probe, "src"), { recursive: true });
    mkdirSync(join(probe, "dist"), { recursive: true });
    symlinkSync(`${REPO}scripts`, join(root, "scripts"));
    writeFileSync(
      join(probe, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          outDir: "dist",
          rootDir: "src",
          module: "nodenext",
          target: "es2022",
          types: [],
        },
        include: ["src"],
      }),
    );
    writeFileSync(join(probe, "src", "kept.ts"), "export const kept = 1;\n");
    writeFileSync(join(probe, "dist", "stale-probe.js"), "export const stale = 1;\n");
    const build = builds.find((p) => p.name === "verify")?.build ?? "";
    const run = spawnSync("sh", ["-c", build], {
      cwd: probe,
      encoding: "utf8",
      env: { ...process.env, PATH: `${REPO}node_modules/.bin:${process.env.PATH ?? ""}` },
    });
    expect({ status: run.status, out: `${run.stdout}${run.stderr}` }).toEqual({
      status: 0,
      out: "",
    });
    expect(readdirSync(join(probe, "dist")).sort()).toEqual(["kept.js"]);
  });
});
