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

/** True when a .ts file under `dir` imports vitest. */
function importsVitest(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).some(
    (file) => file.endsWith(".ts") && /from "vitest"/.test(readFileSync(join(dir, file), "utf8")),
  );
}

// spec 33 item 1 and plan 12j deviation 12: a floor of Node 22 or higher in 22.
// A package with a higher floor, such as the CLI's 22.13, keeps it.
const NODE_FLOOR = /^>=22(\.\d+){0,2}$/;

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
      .filter((p) => !NODE_FLOOR.test(String(p.manifest.engines?.node)))
      .map((p) => `${p.name}: engines.node is ${String(p.manifest.engines?.node)}`);
    expect(missing).toEqual([]);
  });

  it("lists CHANGELOG.md in the files of each released package", () => {
    // The last entry, so the files of the package come first (plan 12j Task 3).
    const missing = releasedManifests()
      .filter((p) => p.manifest.files?.at(-1) !== "CHANGELOG.md")
      .map((p) => `${p.name}: files is ${JSON.stringify(p.manifest.files)}`);
    expect(missing).toEqual([]);
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
