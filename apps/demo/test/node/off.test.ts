import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "../../../site/scripts/lib/config-keys.ts";
import { DEMO_OFF } from "../../src/facts.ts";

// The places of DEMO_OFF that a Node test can read (final review m3 of plan
// 11b). The pool test test/off.test.ts holds each config path unset and no
// scheduled handler. Here each config path is a key of core, so a typo
// cannot pass as unset. Each package is real and is not a dependency.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = resolve(PKG, "../..");

describe("the places of the parts that the demo turns off", () => {
  it("names a key of the core config for each config path", () => {
    const groups = CONFIG_KEYS as Readonly<Record<string, Readonly<Record<string, true>>>>;
    for (const x of DEMO_OFF) {
      if (x.place.kind !== "config") continue;
      const parts = x.place.path.split(".");
      const key = parts.pop() ?? "";
      const group = parts.join(".");
      expect({ path: x.place.path, known: groups[group]?.[key] === true }).toEqual({
        path: x.place.path,
        known: true,
      });
    }
  });

  it("names a workspace package that the demo does not depend on", () => {
    const own = JSON.parse(readFileSync(resolve(PKG, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const used = new Set([
      ...Object.keys(own.dependencies ?? {}),
      ...Object.keys(own.devDependencies ?? {}),
    ]);
    const packages = DEMO_OFF.flatMap((x) => (x.place.kind === "package" ? [x.place.name] : []));
    expect(packages).toEqual(["@authtempo/compat-better-auth"]);
    for (const name of packages) {
      const dir = name.replace("@authtempo/", "packages/");
      const real = JSON.parse(readFileSync(resolve(REPO, dir, "package.json"), "utf8")) as {
        name: string;
      };
      expect(real.name).toBe(name);
      expect({ name, dependency: used.has(name) }).toEqual({ name, dependency: false });
    }
  });
});
