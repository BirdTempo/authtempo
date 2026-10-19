import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Ruling 44 of the plan 11b lane: only the build writes dist and the generated
// files. One turbo run starts the demo build, test, and typecheck at once, and
// two writers of one dist raced (evidence run 2 at 91cb772).
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = resolve(PKG, "../..");

/** Each step of a script that writes dist or src/migrations.gen.ts. */
const WRITERS: readonly RegExp[] = [
  /node scripts\/gen-migrations\.mjs/,
  /node scripts\/copy-assets\.mjs(?! --check)/,
  /node scripts\/dry-run\.mjs/,
  /tsc -p tsconfig\.(?:browser|facts)\.json(?! --noEmit)/,
];

const scripts = (
  JSON.parse(readFileSync(resolve(PKG, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/** turbo.json with each line comment gone. A key such as "//#typecheck:configs" starts with a quote, so it stays. */
const turbo = JSON.parse(
  readFileSync(resolve(REPO, "turbo.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
) as { tasks: Record<string, { dependsOn?: string[] }> };

describe("the writers of the demo dist", () => {
  it("runs each writer in the build", () => {
    for (const writer of WRITERS)
      expect({ writer: String(writer), build: writer.test(scripts.build ?? "") }).toEqual({
        writer: String(writer),
        build: true,
      });
  });

  it("runs no writer in test or typecheck", () => {
    for (const name of ["test", "typecheck"]) {
      const found = WRITERS.filter((w) => w.test(scripts[name] ?? "")).map(String);
      expect({ name, found }).toEqual({ name, found: [] });
    }
  });

  it("makes test and typecheck wait for the build of the demo", () => {
    for (const task of ["@authtempo/demo#test", "@authtempo/demo#typecheck"])
      expect({ task, dependsOn: turbo.tasks[task]?.dependsOn }).toEqual({
        task,
        dependsOn: ["^build", "build"],
      });
  });
});
