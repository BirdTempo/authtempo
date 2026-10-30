import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO } from "../scripts/lib/paths.ts";

// Ruling 65 of plan 12j, M2: scripts/write-version.mjs writes the version
// module of core and of mcp from package.json at each build and typecheck.
// The tests of the two packages hold their dist to the manifest; this test
// holds the script itself, as clean-dist.test.ts holds clean-dist.mjs.
const SCRIPT = `${REPO}scripts/write-version.mjs`;
const temp = mkdtempSync(join(tmpdir(), "authtempo-write-version-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** Runs the script in `dir` with the name `name`. */
const write = (dir: string, name = "VERSION") =>
  spawnSync(process.execPath, [SCRIPT, name], { cwd: dir, encoding: "utf8" });

/** A package folder with a package.json at `version` and an empty src. */
function pkg(name: string, version: string): string {
  const dir = join(temp, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ version })}\n`);
  return dir;
}

describe("scripts/write-version.mjs", () => {
  it("writes the module only when its bytes differ", () => {
    const dir = pkg("pkg", "0.1.0");
    const target = join(dir, "src/version.generated.ts");
    const first = write(dir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toBe("write-version: VERSION 0.1.0, written\n");
    expect(readFileSync(target, "utf8")).toBe(
      '// Generated from the version of package.json by scripts/write-version.mjs. Do not edit.\nexport const VERSION = "0.1.0";\n',
    );
    // A run on the same bytes keeps the mtime, so the build-age rule of release-check holds.
    utimesSync(target, new Date(1_000_000), new Date(1_000_000));
    expect(write(dir).stdout).toBe("write-version: VERSION 0.1.0, unchanged\n");
    expect(statSync(target).mtimeMs).toBe(1_000_000);
    // A new version writes the new value, under the name of the argument.
    writeFileSync(join(dir, "package.json"), '{ "version": "0.2.0" }\n');
    expect(write(dir, "MCP_VERSION").stdout).toBe("write-version: MCP_VERSION 0.2.0, written\n");
    expect(readFileSync(target, "utf8")).toContain('export const MCP_VERSION = "0.2.0";');
  });

  // Ruling 70 of plan 12j, Low 1: turbo.json named only dist/** as the build
  // output. A cache hit restored dist and left src at another version.
  it("is an output of each build that runs it, in turbo.json", () => {
    /** A JSON file of the repository; turbo.json holds comments on whole lines only. */
    const json = (path: string) =>
      JSON.parse(readFileSync(`${REPO}${path}`, "utf8").replace(/^\s*\/\/.*$/gm, ""));
    const tasks = (json("turbo.json") as { tasks: Record<string, unknown> }).tasks;
    const writers: string[] = [];
    for (const parent of ["apps", "packages", "examples"])
      for (const dir of readdirSync(`${REPO}${parent}`)) {
        const path = `${parent}/${dir}/package.json`;
        if (!existsSync(`${REPO}${path}`)) continue;
        const m = json(path) as { name: string; scripts?: Record<string, string> };
        if (!(m.scripts?.build ?? "").includes("scripts/write-version.mjs")) continue;
        writers.push(m.name);
        expect({ name: m.name, build: tasks[`${m.name}#build`] }).toEqual({
          name: m.name,
          build: { dependsOn: ["^build"], outputs: ["dist/**", "src/version.generated.ts"] },
        });
        // A build task of the package turbo.json would be a second source of the outputs.
        const own = `${parent}/${dir}/turbo.json`;
        if (existsSync(`${REPO}${own}`))
          expect(
            (json(own) as { tasks: Record<string, unknown> }).tasks.build,
            own,
          ).toBeUndefined();
      }
    expect(writers.sort()).toEqual(["@authtempo/core", "@authtempo/mcp"]);
  });

  it("stops on a bad name or a bad version, and writes nothing", () => {
    const dir = pkg("bad", "0.1");
    const name = write(dir, "version");
    expect(name.status).toBe(2);
    expect(name.stderr).toBe("write-version: give the name of the constant, such as VERSION\n");
    const version = write(dir);
    expect(version.status).toBe(1);
    expect(version.stderr).toBe("write-version: the version of package.json is not x.y.z: 0.1\n");
    expect(() => statSync(join(dir, "src/version.generated.ts"))).toThrow();
  });
});
