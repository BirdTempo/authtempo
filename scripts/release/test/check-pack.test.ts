import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  breakingByMinor,
  checkPack,
  checkTarballs,
  type PackInput,
  readTarball,
} from "../src/check-pack.ts";
import { FORBIDDEN_PACK_NAMES } from "../src/lib/pack-rules.ts";
import { releasedNames } from "../src/lib/released.ts";
import { summaryLine } from "../src/lib/report.ts";
import type { Manifest } from "../src/lib/workspace.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (path: string) =>
  fileURLToPath(new URL(`./fixtures/pack/${path}`, import.meta.url));
const readText = (path: string) => readFileSync(fixture(path), "utf8");

/** The list that `pnpm pack --dry-run --json` wrote for fixtures/pack/release. */
const PACKED: string[] = (
  JSON.parse(readText("root/packages/fixture/pack.json")) as { files: { path: string }[] }
).files.map((f) => f.path);
const MANIFEST = JSON.parse(readText("root/packages/fixture/package.json")) as Manifest;
/** The root LICENSE: prepare copies these bytes into each package folder. */
const ROOT_LICENSE = readFileSync(join(root, "LICENSE"), "utf8");
const NEEDS = ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/errors.js"];

/** The input of a release tarball that passes. Each test changes one part of it. */
function input(change: Partial<PackInput> = {}): PackInput {
  return {
    files: [...PACKED],
    manifest: structuredClone(MANIFEST),
    license: ROOT_LICENSE,
    needs: [...NEEDS],
    groupVersion: "0.1.0",
    rootLicense: ROOT_LICENSE,
    repository: {
      url: "git+https://github.com/authtempo/authtempo.git",
      directory: "packages/fixture",
    },
    breaking: {},
    deprecations: [],
    ...change,
  };
}
const failuresOf = (change: Partial<PackInput>) => checkPack(input(change)).failures;
const withManifest = (edit: (m: Manifest) => void) => {
  const manifest = structuredClone(MANIFEST);
  edit(manifest);
  return failuresOf({ manifest });
};

describe("check-pack", () => {
  it("passes a release tarball", () => {
    const r = checkPack(input());
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe("check-pack: PASS tarballs=1 files=9 failures=0");
  });

  it("fails a file outside files", () => {
    expect(failuresOf({ files: [...PACKED, "scripts/x.mjs"] })).toEqual([
      "the tarball holds scripts/x.mjs, which is outside files and the always-shipped files",
    ]);
  });

  it("fails each forbidden name", () => {
    // One path per row, typed here, so the list cannot lose a row unseen.
    const cases: [name: string, path: string][] = [
      [".env", ".env"],
      [".dev.vars", "dist/.dev.vars"],
      [".wrangler/", "dist/.wrangler/state/v3/d1.sqlite"],
      ["node_modules/", "dist/node_modules/x/index.js"],
      [".scaffold/", "dist/.scaffold/app.json"],
      ["test/", "dist/test/a.js"],
      ["src/", "dist/src/index.ts"],
      ["typetest/", "dist/typetest/a.js"],
      ["coverage/", "dist/coverage/lcov.info"],
      ["*.test.*", "dist/index.test.js"],
      ["*.tsbuildinfo", "dist/tsconfig.tsbuildinfo"],
    ];
    expect([...FORBIDDEN_PACK_NAMES]).toEqual(cases.map(([name]) => name));
    for (const [name, path] of cases)
      expect(failuresOf({ files: [...PACKED, path] }), name).toContain(
        `the tarball holds ${path}, which matches ${name}`,
      );
    // A folder named src is allowed when files lists it, as worker/src of @authtempo/import.
    const manifest = structuredClone(MANIFEST);
    manifest.files = ["dist", "CHANGELOG.md", "worker/src"];
    expect(failuresOf({ manifest, files: [...PACKED, "worker/src/index.ts"] })).toEqual([]);
    expect(failuresOf({ manifest, files: [...PACKED, "src/index.ts"] })).toContain(
      "the tarball holds src/index.ts, which matches src/",
    );
  });

  it("fails a binary file", () => {
    expect(failuresOf({ files: [...PACKED, "dist/addon.node"] })).toEqual([
      "the tarball holds the binary file dist/addon.node, and no declared binary list names it",
    ]);
    expect(failuresOf({ files: [...PACKED, "dist/hash.wasm"] })).toEqual([
      "the tarball holds the binary file dist/hash.wasm, and no declared binary list names it",
    ]);
  });

  it("fails an exports target that the tarball lacks", () => {
    const lacks = (path: string) => PACKED.filter((p) => p !== path);
    expect(failuresOf({ files: lacks("dist/errors.js"), needs: [] })).toEqual([
      'exports["./errors"].default names dist/errors.js, which the tarball lacks',
    ]);
    expect(failuresOf({ files: lacks("dist/index.js"), needs: [] })).toEqual([
      "main names dist/index.js, which the tarball lacks",
      'exports["."].default names dist/index.js, which the tarball lacks',
    ]);
    expect(failuresOf({ files: lacks("dist/index.d.ts"), needs: [] })).toEqual([
      "types names dist/index.d.ts, which the tarball lacks",
      'exports["."].types names dist/index.d.ts, which the tarball lacks',
    ]);
    expect(failuresOf({ files: lacks("dist/bin/fixture.js"), needs: [] })).toEqual([
      'bin["fixture"] names dist/bin/fixture.js, which the tarball lacks',
    ]);
  });

  it("fails a workspace: text", () => {
    for (const key of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ])
      expect(
        withManifest((m) => {
          m[key] = { "@authtempo/core": "workspace:*" };
        }),
        key,
      ).toEqual([`${key} holds @authtempo/core as workspace:*, which npm cannot resolve`]);
  });

  it("fails a private key", () => {
    expect(
      withManifest((m) => {
        m.private = true;
      }),
    ).toEqual(["the manifest holds private"]);
    expect(
      withManifest((m) => {
        m.private = false;
      }),
    ).toEqual(["the manifest holds private"]);
  });

  it("fails a publishConfig without public access and provenance", () => {
    expect(
      withManifest((m) => {
        m.publishConfig = { access: "restricted", provenance: true };
      }),
    ).toEqual(["publishConfig.access is not public"]);
    expect(
      withManifest((m) => {
        m.publishConfig = { access: "public" };
      }),
    ).toEqual(["publishConfig.provenance is not true"]);
  });

  it("fails another version than the group's", () => {
    expect(failuresOf({ groupVersion: "0.2.0" })).toEqual([
      "the version is 0.1.0, not the group version 0.2.0",
    ]);
  });

  it("fails a missing license, repository.url, repository.directory, or CHANGELOG.md", () => {
    expect(
      withManifest((m) => {
        delete m.license;
      }),
    ).toEqual(["the manifest has no license"]);
    expect(
      withManifest((m) => {
        m.license = "ISC";
      }),
    ).toEqual(["the license is ISC, not MIT"]);
    expect(
      withManifest((m) => {
        m.repository = { type: "git", directory: "packages/fixture" };
      }),
    ).toEqual(["the manifest has no repository.url"]);
    expect(
      withManifest((m) => {
        m.repository = { type: "git", url: "git+https://github.com/authtempo/authtempo.git" };
      }),
    ).toEqual(["the manifest has no repository.directory"]);
    expect(failuresOf({ files: PACKED.filter((p) => p !== "CHANGELOG.md") })).toEqual([
      "the tarball has no CHANGELOG.md",
    ]);
    // A value that is present and wrong fails too.
    expect(
      failuresOf({
        repository: { url: "git+https://github.com/x/y.git", directory: "packages/x" },
      }),
    ).toEqual([
      "repository.url is git+https://github.com/authtempo/authtempo.git, not git+https://github.com/x/y.git",
      "repository.directory is packages/fixture, not packages/x",
    ]);
  });

  it("fails a LICENSE whose bytes differ from the root", () => {
    expect(failuresOf({ license: `${ROOT_LICENSE} ` })).toEqual([
      "the LICENSE bytes differ from the root LICENSE",
    ]);
    expect(failuresOf({ license: null, files: PACKED.filter((p) => p !== "LICENSE") })).toEqual([
      "the tarball has no LICENSE",
      "the needed file LICENSE of release/pack-needs.json is not in the tarball",
    ]);
  });

  it("fails a needed file that the tarball lacks", () => {
    expect(failuresOf({ needs: [...NEEDS, "dist/oauth.js"] })).toEqual([
      "the needed file dist/oauth.js of release/pack-needs.json is not in the tarball",
    ]);
    // A need that ends in "/" is a folder: at least one file under it.
    expect(failuresOf({ needs: [...NEEDS, "migrations/"] })).toEqual([
      "the needed folder migrations/ of release/pack-needs.json has no file in the tarball",
    ]);
    expect(failuresOf({ needs: [...NEEDS, "dist/bin/"] })).toEqual([]);
  });

  it("holds core's breaking and deprecation fields to their sources", () => {
    const breaking = breakingByMinor(readText("core/CHANGELOG.md"));
    expect(breaking).toEqual({
      "0.2": [
        "Breaking: remove the authtempo-import binary. Run authtempo import instead.",
        "Breaking: remove the read of the old session cookie tempo_session.",
      ],
    });
    const deprecations = JSON.parse(readText("deprecations.json")) as unknown[];
    const core = (authtempo: Record<string, unknown>) => {
      const manifest = structuredClone(MANIFEST);
      manifest.name = "@authtempo/core";
      manifest.authtempo = authtempo;
      return failuresOf({ manifest, breaking, deprecations });
    };
    expect(core({ schemaVersion: 11, breaking, deprecations })).toEqual([]);
    expect(core({ schemaVersion: 11, breaking: {}, deprecations })).toEqual([
      "authtempo.breaking differs from the Breaking: lines of CHANGELOG.md",
    ]);
    expect(core({ schemaVersion: 11, breaking, deprecations: [] })).toEqual([
      "authtempo.deprecations differs from release/deprecations.json",
    ]);
    // Only core carries the two fields; upgrade reads them from core alone.
    expect(
      withManifest((m) => {
        m.authtempo = { breaking, deprecations };
      }),
    ).toEqual([
      "authtempo.breaking is in @authtempo/fixture; only @authtempo/core holds it",
      "authtempo.deprecations is in @authtempo/fixture; only @authtempo/core holds it",
    ]);
  });

  it("gives every released package an entry in pack-needs.json", () => {
    const needs = JSON.parse(readFileSync(join(root, "release/pack-needs.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const released = releasedNames(root).sort();
    expect(Object.keys(needs).sort()).toEqual(released);
    for (const name of released) {
      const list = needs[name];
      expect(Array.isArray(list) && list.length > 0, name).toBe(true);
      expect(
        (list as unknown[]).every((p) => typeof p === "string" && p !== ""),
        name,
      ).toBe(true);
    }
  });

  it("reads a pnpm pack tarball and checks it against the tree", () => {
    const out = mkdtempSync(join(tmpdir(), "authtempo-check-pack-"));
    try {
      execFileSync("pnpm", ["pack", "--pack-destination", out], {
        cwd: fixture("root/packages/fixture"),
        env: { ...process.env, NO_COLOR: "1" },
        stdio: "pipe",
      });
      const [tarball] = readdirSync(out);
      if (tarball === undefined) throw new Error("pnpm pack wrote no tarball");
      const t = readTarball(join(out, tarball));
      expect(t.files).toEqual([...PACKED].sort());
      expect(t.manifest.name).toBe("@authtempo/fixture");
      expect(t.license).toBe(readText("root/packages/fixture/LICENSE"));
      expect(t.changelog).toBe(readText("root/packages/fixture/CHANGELOG.md"));
      // The entry reads the released list, the folder, the needs, the
      // repository, and the LICENSE of the tree at fixtures/pack/root.
      const path = join(out, tarball);
      expect(summaryLine(checkTarballs(fixture("root"), [path]))).toBe(
        "check-pack: PASS tarballs=1 files=9 failures=0",
      );
      expect(checkTarballs(fixture("root"), [path, path]).failures).toEqual([
        `${path}: a second tarball of @authtempo/fixture`,
      ]);
      expect(checkTarballs(fixture("root"), []).failures).toEqual([
        "read 0 tarballs",
        "read 0 files",
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
