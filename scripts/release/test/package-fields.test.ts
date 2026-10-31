import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releasedNames } from "../src/lib/released.ts";
import { readWorkspace } from "../src/lib/workspace.ts";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

// The SPDX "MIT" license text (license list 3.29.0, read 2026-10-20), with the
// copyright line of plan 12j. The test compares words, not line breaks.
const MIT_TEXT = `MIT License

Copyright (c) 2026 BirdTempo

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

const words = (text: string) => text.trim().split(/\s+/).join(" ");

/** The manifest of each released package, from the one list of the group. */
function releasedManifests() {
  const dir = fileURLToPath(root);
  const names = releasedNames(dir);
  const byName = new Map(readWorkspace(dir).map((p) => [p.name, p]));
  const found = names.map((name) => {
    const p = byName.get(name);
    if (p === undefined) throw new Error(`${name}: released, and no workspace package`);
    return p;
  });
  // A list that reads no package proves nothing.
  expect(found.length).toBeGreaterThan(0);
  return found;
}

/**
 * An import of vitest or of a vitest subpath that loads it at run time:
 * `import ... from`, `export ... from`, a side-effect `import "vitest"`, and a
 * dynamic `import("vitest")`. `import type`, `export type`, and `typeof
 * import(...)` load nothing, so they stay out (rr-task3b N2 of plan 12j).
 * `@vitest/expect` and `vitest-environment-x` are other packages.
 */
const VITEST_IMPORT =
  /(?:\b(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*|(?<!\btypeof\s+)\bimport\s*\(?\s*)["']vitest(?:\/[^"']*)?["']/;

/** The text of a .ts file with its comments removed, so a comment never reads as an import. */
const codeOf = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** True when the code of `text` imports vitest at run time. */
const importsVitestText = (text: string): boolean => VITEST_IMPORT.test(codeOf(text));

/** True when a .ts file under `dir` imports vitest. */
function importsVitest(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).some(
    (file) => file.endsWith(".ts") && importsVitestText(readFileSync(join(dir, file), "utf8")),
  );
}

/** The three numbers of a floor `>=a`, `>=a.b`, or `>=a.b.c`, or null for another form. */
function floorOf(range: string | undefined): [number, number, number] | null {
  const m = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range ?? "");
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/** True when floor `a` is below floor `b`. */
function below(a: readonly number[], b: readonly number[]): boolean {
  for (const [i, x] of a.entries()) {
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

// spec 33 item 1 and plan 12j deviation 12: a floor of Node 22 or higher in 22.
// A package with a higher floor, such as the CLI's 22.13, keeps it. The name
// differs from NODE_FLOOR of the release facts, the Node version of CI.
const PACKAGE_FLOOR = /^>=22(\.\d+){0,2}$/;

describe("package fields", () => {
  it("holds the root license to MIT", () => {
    const manifest = JSON.parse(read("package.json")) as { license?: unknown };
    expect(manifest.license).toBe("MIT");
    const license = read("LICENSE");
    expect(license.split("\n")[0]).toBe("MIT License");
    expect(words(license)).toBe(words(MIT_TEXT));
  });

  it("gives each released package an engine floor", () => {
    const missing = releasedManifests()
      .filter((p) => !PACKAGE_FLOOR.test(String(p.manifest.engines?.node)))
      .map((p) => `${p.name}: engines.node is ${String(p.manifest.engines?.node)}`);
    expect(missing).toEqual([]);
  });

  it("gives no released package a floor below the floor of a package it needs", () => {
    // npm warns, and engine-strict fails the install, when a package needs a
    // package with a higher floor (ruling 45 of plan 12j, m1). A package needs
    // each workspace dependency and each peer that is not optional.
    const dir = fileURLToPath(root);
    const floors = new Map(readWorkspace(dir).map((p) => [p.name, p.manifest.engines?.node]));
    const bad: string[] = [];
    let pairs = 0;
    for (const p of releasedManifests()) {
      const own = floorOf(p.manifest.engines?.node);
      const meta = (p.manifest.peerDependenciesMeta ?? {}) as Record<
        string,
        { optional?: unknown } | undefined
      >;
      const needs = [
        ...Object.keys(p.manifest.dependencies ?? {}),
        ...Object.keys(p.manifest.peerDependencies ?? {}).filter((n) => meta[n]?.optional !== true),
      ].filter((n) => floors.has(n));
      for (const need of needs) {
        const theirs = floorOf(floors.get(need));
        if (theirs === null) continue;
        pairs++;
        if (own === null || below(own, theirs))
          bad.push(`${p.name} ${p.manifest.engines?.node} needs ${need} ${floors.get(need)}`);
      }
    }
    // The CLI needs core, so a read of no pair proves nothing.
    expect(pairs).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("lists CHANGELOG.md in the files of each released package", () => {
    // The last entry, so the files of the package come first (plan 12j Task 3).
    const missing = releasedManifests()
      .filter((p) => p.manifest.files?.at(-1) !== "CHANGELOG.md")
      .map((p) => `${p.name}: files is ${JSON.stringify(p.manifest.files)}`);
    expect(missing).toEqual([]);
  });

  it.each([
    ["static", 'import { describe } from "vitest";'],
    ["static, single quotes", "import { expect } from 'vitest';"],
    ["export", 'export { expect } from "vitest";'],
    ["side-effect", 'import "vitest";'],
    ["dynamic", 'const v = await import("vitest");'],
    ["dynamic, spaces", "await import( 'vitest' )"],
    ["subpath", 'import { vi } from "vitest/node";'],
    ["side-effect subpath", 'import "vitest/globals";'],
    ["dynamic subpath", 'const c = await import("vitest/config");'],
    ["inline type specifier", 'import { type Mock, vi } from "vitest";'],
    ["multi-line", 'import {\n  describe,\n  it,\n} from "vitest";'],
  ])("reads the %s import form of vitest", (_form, text) => {
    expect(importsVitestText(text)).toBe(true);
  });

  it("reads no type import and no comment as an import of vitest (rr-task3b N2)", () => {
    const no = [
      'import type { Mock } from "vitest";',
      'export type { Mock } from "vitest";',
      'type V = typeof import("vitest");',
      '// const v = await import("vitest");',
      '/* import { it } from "vitest"; */',
      '/**\n * See import("vitest") for the runner.\n */',
    ];
    expect(no.filter((t) => importsVitestText(t))).toEqual([]);
  });

  it("reads no other package as vitest", () => {
    const no = [
      'import { expect } from "@vitest/expect";',
      'import x from "vitest-environment-x";',
      'const name = "vitest";',
      'import { a } from "./vitest.js";',
    ];
    expect(no.filter((t) => importsVitestText(t))).toEqual([]);
  });

  it("gives vitest as an optional peer to each package whose source imports it", () => {
    // A conformance kit imports vitest and runs inside the test run of an
    // adapter, a limiter, or an SDK (ruling 14 of plan 12j). Without the peer,
    // the entry fails to load from an app. An optional peer installs nothing.
    const users = releasedManifests().filter((p) =>
      importsVitest(join(fileURLToPath(root), p.dir, "src")),
    );
    expect(users.map((p) => p.name)).toContain("@authtempo/core");
    const bad = users
      .filter((p) => {
        const meta = p.manifest.peerDependenciesMeta as
          | Record<string, { optional?: unknown } | undefined>
          | undefined;
        // The range starts at the version that the package's own tests run.
        const tested = p.manifest.devDependencies?.vitest;
        return (
          tested === undefined ||
          p.manifest.peerDependencies?.vitest !== `^${tested}` ||
          meta?.vitest?.optional !== true
        );
      })
      .map((p) => p.name);
    expect(bad).toEqual([]);
  });
});
