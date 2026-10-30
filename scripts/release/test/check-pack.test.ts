import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  breakingByMinor,
  checkPack,
  checkTarballs,
  entry,
  type PackInput,
  readTarball,
} from "../src/check-pack.ts";
import { readDeprecations } from "../src/lib/deprecations.ts";
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
      url: "git+https://github.com/BirdTempo/authtempo.git",
      directory: "packages/fixture",
    },
    breaking: {},
    deprecations: [],
    scripts: {},
    ...change,
  };
}
const failuresOf = (change: Partial<PackInput>) => checkPack(input(change)).failures;
const withManifest = (edit: (m: Manifest) => void) => {
  const manifest = structuredClone(MANIFEST);
  edit(manifest);
  return failuresOf({ manifest });
};

/** A copy of fixtures/pack/root in a new temporary folder, after `edit`. */
function copyRoot(edit: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-check-pack-root-"));
  cpSync(fixture("root"), dir, { recursive: true });
  edit(dir);
  return dir;
}

/**
 * Adds a released package to the tree at `dir`: a folder with a package.json,
 * a name in fixed[0] of .changeset/config.json, and an entry in
 * release/pack-needs.json.
 */
function addReleased(dir: string, name: string, version: string): void {
  const folder = join(dir, "packages", name.slice(name.indexOf("/") + 1));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version }));
  const editJson = (file: string, edit: (value: Record<string, unknown>) => void) => {
    const value = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    edit(value);
    writeFileSync(join(dir, file), JSON.stringify(value));
  };
  editJson(".changeset/config.json", (c) => {
    (c.fixed as string[][])[0]?.push(name);
  });
  editJson("release/pack-needs.json", (n) => {
    n[name] = ["package.json"];
  });
}

/** One entry of a tarball that writeTar makes. The type is the ustar type flag. */
interface TarEntry {
  name: string;
  type?: "0" | "1" | "2" | "5";
  body?: string;
  link?: string;
}

/**
 * Writes a gzip ustar file with `entries`, in order. A test makes each entry
 * that pnpm pack never writes, such as a link or a path outside package/.
 */
function writeTar(path: string, entries: TarEntry[]): void {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write(" ".repeat(8), 148);
    header.write(entry.type ?? "0", 156);
    header.write(entry.link ?? "", 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  writeFileSync(path, gzipSync(Buffer.concat(blocks)));
}

/** A package.json entry of a tarball. */
const manifestEntry = (name: string): TarEntry => ({
  name: "package/package.json",
  body: JSON.stringify({ name, version: "0.1.0" }),
});

/** Runs pnpm pack in `dir` and gives the path of the one new tarball in `out`. */
function pack(dir: string, out: string): string {
  const before = new Set(readdirSync(out));
  execFileSync("pnpm", ["pack", "--pack-destination", out], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: "pipe",
  });
  const made = readdirSync(out).filter((f) => !before.has(f));
  if (made.length !== 1) throw new Error(`pnpm pack wrote ${made.length} tarballs`);
  return join(out, made[0] as string);
}

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

  it("fails a files entry that is a pattern", () => {
    const manifest = structuredClone(MANIFEST);
    manifest.files = ["dist/*.js", "CHANGELOG.md"];
    expect(failuresOf({ manifest })).toContain(
      "the files entry dist/*.js is a pattern, and check-pack reads only paths",
    );
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
      [".npmrc", "dist/.npmrc"],
      ["*.pem", "dist/cert.pem"],
      ["*.key", "dist/server.key"],
      ["id_rsa", "dist/id_rsa"],
      ["id_dsa", "dist/id_dsa"],
      ["id_ecdsa", "dist/id_ecdsa"],
      ["id_ed25519", "dist/id_ed25519"],
      ["*.sqlite", "migrations/local.sqlite"],
      ["*.sqlite3", "migrations/local.sqlite3"],
      ["*.db", "migrations/dev.db"],
      [".git/", "dist/.git/config"],
      [".omc/", "dist/.omc/state.json"],
      [".superpowers/", "skills/.superpowers/x.md"],
      ["AGENTS.md", "skills/AGENTS.md"],
      ["proof/", "worker/proof/pack-files.mjs"],
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

  it("fails a target that is a pattern", () => {
    expect(
      withManifest((m) => {
        m.exports = { ...(m.exports as object), "./*": "./dist/*.js" };
      }),
    ).toEqual(['exports["./*"] names the pattern dist/*.js, which check-pack cannot read']);
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

  it("fails each script that runs at pack or publish", () => {
    // One script per row, typed here. pnpm 12.8.1 pack strips the publish
    // scripts from the packed manifest, so the workspace manifest counts too.
    const rows = [
      "prepack",
      "postpack",
      "prepare",
      "prepublish",
      "prepublishOnly",
      "publish",
      "postpublish",
    ];
    for (const script of rows) {
      const line = `scripts.${script} runs at pack or publish`;
      const packed = withManifest((m) => {
        m.scripts = { [script]: "node x.mjs" };
      });
      expect([script, "packed", packed]).toEqual([script, "packed", [line]]);
      const source = failuresOf({ scripts: { [script]: "node x.mjs" } });
      expect([script, "workspace", source]).toEqual([script, "workspace", [line]]);
    }
    // A script that no pack and no publish runs passes.
    expect(failuresOf({ scripts: { build: "tsc", test: "vitest run", postinstall: "x" } })).toEqual(
      [],
    );
  });

  it("reads the scripts of the workspace manifest, which pnpm pack strips", () => {
    const tree = copyRoot((dir) => {
      const file = join(dir, "packages/fixture/package.json");
      const m = JSON.parse(readFileSync(file, "utf8")) as Manifest;
      m.scripts = { prepack: "node -e \"require('fs').writeFileSync('ran.txt', '')\"" };
      writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
    });
    const out = mkdtempSync(join(tmpdir(), "authtempo-check-pack-"));
    try {
      const folder = join(tree, "packages/fixture");
      execFileSync("pnpm", ["pack", "--ignore-scripts", "--pack-destination", out], {
        cwd: folder,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: "pipe",
      });
      expect(readdirSync(folder)).not.toContain("ran.txt");
      const [tarball = ""] = readdirSync(out);
      const path = join(out, tarball);
      expect(readTarball(path).manifest.scripts).toEqual({});
      expect(checkTarballs(tree, [path]).failures).toEqual([
        "@authtempo/fixture@0.1.0: scripts.prepack runs at pack or publish",
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it("fails a committed .npmrc and a registry or proxy key in a config file", () => {
    // publish.ts runs npm in the checkout, and npm and pnpm read these files
    // at a publish (review of the Task 6 fix, I5 and m1).
    const hostile = "http://127.0.0.1:1/";
    const tree = copyRoot((dir) => {
      for (const file of [".npmrc", "packages/fixture/.npmrc", "docs/.npmrc"]) {
        mkdirSync(join(dir, file, ".."), { recursive: true });
        writeFileSync(join(dir, file), `registry=${hostile}\n`);
      }
      // The .npmrc of an installed package is not a file of the checkout.
      mkdirSync(join(dir, "node_modules/some-package"), { recursive: true });
      writeFileSync(join(dir, "node_modules/some-package/.npmrc"), `registry=${hostile}\n`);
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "authtempo", private: true, publishConfig: { registry: hostile } }),
      );
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        [
          "packages:",
          "  - packages/*",
          "# registry: a comment names no key",
          `httpsProxy: ${hostile}`,
          `"@authtempo:registry": ${hostile}`,
          "registries:",
          `  default: ${hostile}`,
          "",
        ].join("\n"),
      );
      const file = join(dir, "packages/fixture/package.json");
      const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
      m.publishConfig = { ...m.publishConfig, "@authtempo:registry": hostile };
      // A dependency name is not a key of a registry.
      m.dependencies = { ...m.dependencies, "registry-url": "7.0.0" };
      writeFileSync(file, JSON.stringify(m));
    });
    const out = mkdtempSync(join(tmpdir(), "authtempo-check-pack-"));
    try {
      const path = pack(fixture("root/packages/fixture"), out);
      expect(checkTarballs(tree, [path]).failures).toEqual([
        ".npmrc: an .npmrc, which can name a registry, a proxy, or a token",
        "docs/.npmrc: an .npmrc, which can name a registry, a proxy, or a token",
        "packages/fixture/.npmrc: an .npmrc, which can name a registry, a proxy, or a token",
        "package.json: the key publishConfig.registry names a registry or a proxy",
        "packages/fixture/package.json: the key publishConfig.@authtempo:registry names a registry or a proxy",
        "pnpm-workspace.yaml: line 4: the key httpsProxy names a registry or a proxy",
        "pnpm-workspace.yaml: line 5: the key @authtempo:registry names a registry or a proxy",
        "pnpm-workspace.yaml: line 6: the key registries names a registry or a proxy",
      ]);
      // The same tarball passes against the tree with none of these files.
      expect(checkTarballs(fixture("root"), [path]).failures).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(tree, { recursive: true, force: true });
    }
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

  it("fails a release at 0.0.0", () => {
    // The scaffold reads 0.0.0 as unpublished (ruling 13 of the plan 12j lane).
    const manifest = structuredClone(MANIFEST);
    manifest.version = "0.0.0";
    expect(failuresOf({ manifest, groupVersion: "0.0.0" })).toEqual([
      "the version is 0.0.0, which the scaffold reads as unpublished",
    ]);
  });

  it("fails a release at 0.0.x above 0.0.0", () => {
    // The first release is 0.1.0 (ruling 28 of the plan 12j lane).
    for (const version of ["0.0.1", "0.0.12"]) {
      const manifest = structuredClone(MANIFEST);
      manifest.version = version;
      expect(failuresOf({ manifest, groupVersion: version })).toEqual([
        `the version is ${version}; the first release is 0.1.0, so no release is at 0.0.x`,
      ]);
    }
    for (const version of ["0.1.0", "0.10.3", "1.0.1"]) {
      const manifest = structuredClone(MANIFEST);
      manifest.version = version;
      expect(failuresOf({ manifest, groupVersion: version })).toEqual([]);
    }
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
        m.repository = { type: "git", url: "git+https://github.com/BirdTempo/authtempo.git" };
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
      "repository.url is git+https://github.com/BirdTempo/authtempo.git, not git+https://github.com/x/y.git",
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
    const deprecations = readDeprecations(fixture("root"));
    expect(deprecations.map((e) => e.id)).toEqual(["authtempo-import"]);
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

  it("fails a tarball of a package that the tree does not release", () => {
    const out = mkdtempSync(join(tmpdir(), "authtempo-check-pack-"));
    try {
      const path = join(out, "other.tgz");
      writeTar(path, [manifestEntry("@authtempo/other")]);
      expect(checkTarballs(fixture("root"), [path]).failures).toEqual([
        `${path}: @authtempo/other is not a released package`,
        "@authtempo/fixture: no tarball",
        "read 0 tarballs",
        "read 0 files",
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("fails a released package with no needs entry, and a group of two versions", () => {
    const out = mkdtempSync(join(tmpdir(), "authtempo-check-pack-"));
    const roots: string[] = [];
    try {
      const path = pack(fixture("root/packages/fixture"), out);
      const noNeeds = copyRoot((dir) => writeFileSync(join(dir, "release/pack-needs.json"), "{}"));
      roots.push(noNeeds);
      expect(checkTarballs(noNeeds, [path]).failures).toEqual([
        "@authtempo/fixture: no entry in release/pack-needs.json",
      ]);
      const twoVersions = copyRoot((dir) => addReleased(dir, "@authtempo/second", "0.2.0"));
      roots.push(twoVersions);
      expect(checkTarballs(twoVersions, [path]).failures).toEqual([
        "the released packages hold 2 versions: 0.1.0, 0.2.0",
        "@authtempo/second: no tarball",
      ]);
    } finally {
      for (const dir of [out, ...roots]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires release/deprecations.json in the tree", () => {
    const out = mkdtempSync(join(tmpdir(), "authtempo-check-pack-"));
    const noRegister = copyRoot((dir) => rmSync(join(dir, "release/deprecations.json")));
    const badRegister = copyRoot();
    try {
      const path = pack(fixture("root/packages/fixture"), out);
      // Before plan 12j Task 9 an absent register read as no item. Now it is the
      // one source of core's authtempo.deprecations, so a tree without it stops.
      expect(() => checkTarballs(noRegister, [path])).toThrow("release/deprecations.json");
      expect(checkTarballs(fixture("root"), [path]).failures).toEqual([]);
      // The entry prints a FAIL summary line and the reason, not a stack.
      const missing = entry(noRegister, [path]);
      expect(missing.lines).toHaveLength(2);
      expect(missing.lines[0]).toBe("check-pack: FAIL tarballs=0 files=0 failures=1");
      expect(missing.lines[1]).toMatch(/^ {2}ENOENT: .*release\/deprecations\.json'$/);
      expect(missing.code).toBe(1);
      writeFileSync(join(badRegister, "release/deprecations.json"), "{}");
      expect(entry(badRegister, [path])).toEqual({
        lines: [
          "check-pack: FAIL tarballs=0 files=0 failures=1",
          "  release/deprecations.json: the register is not a list",
        ],
        code: 1,
      });
      expect(entry(fixture("root"), [path])).toEqual({
        lines: ["check-pack: PASS tarballs=1 files=9 failures=0"],
        code: 0,
      });
    } finally {
      for (const dir of [out, noRegister, badRegister])
        rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a tarball entry outside package/", () => {
    const out = mkdtempSync(join(tmpdir(), "authtempo-check-pack-"));
    try {
      const path = join(out, "outside.tgz");
      writeTar(path, [manifestEntry("@authtempo/fixture"), { name: "other/x.js", body: "x" }]);
      expect(() => readTarball(path)).toThrow(`${path}: other/x.js is not under package/`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses a tarball entry that is not a regular file, or a path with a .. part", () => {
    const out = mkdtempSync(join(tmpdir(), "authtempo-check-pack-"));
    try {
      const tarball = (file: string, entry: TarEntry) => {
        const path = join(out, file);
        writeTar(path, [manifestEntry("@authtempo/fixture"), entry]);
        return path;
      };
      const symlink = tarball("symlink.tgz", {
        name: "package/dist/leak.js",
        type: "2",
        link: "/etc/passwd",
      });
      expect(() => readTarball(symlink)).toThrow(
        `${symlink}: package/dist/leak.js is not a regular file`,
      );
      const hardlink = tarball("hardlink.tgz", {
        name: "package/dist/copy.js",
        type: "1",
        link: "package/package.json",
      });
      expect(() => readTarball(hardlink)).toThrow(
        `${hardlink}: package/dist/copy.js is not a regular file`,
      );
      const dotdot = tarball("dotdot.tgz", { name: "package/dist/../../evil.js", body: "x" });
      expect(() => readTarball(dotdot)).toThrow(
        `${dotdot}: package/dist/../../evil.js has a .. part`,
      );
      // A folder entry is not a file, and the reader skips it.
      const folder = tarball("folder.tgz", { name: "package/dist/", type: "5" });
      expect(readTarball(folder).files).toEqual(["package.json"]);
      // The entry turns a refusal into a failure line, so the summary line still prints.
      expect(checkTarballs(fixture("root"), [symlink]).failures).toEqual([
        `${symlink}: package/dist/leak.js is not a regular file`,
        "@authtempo/fixture: no tarball",
        "read 0 tarballs",
        "read 0 files",
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
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
      // Probe A of the Task 5 review: the tree and its package at 0.0.0.
      const zero = copyRoot((dir) => {
        const file = join(dir, "packages/fixture/package.json");
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace('"version": "0.1.0"', '"version": "0.0.0"'),
        );
      });
      try {
        const packed = pack(join(zero, "packages/fixture"), out);
        expect(checkTarballs(zero, [packed]).failures).toEqual([
          "@authtempo/fixture@0.0.0: the version is 0.0.0, which the scaffold reads as unpublished",
        ]);
      } finally {
        rmSync(zero, { recursive: true, force: true });
      }
      // Probe B of the Task 5 review: two released packages and one tarball.
      const two = copyRoot((dir) => addReleased(dir, "@authtempo/second", "0.1.0"));
      try {
        expect(checkTarballs(two, [path]).failures).toEqual(["@authtempo/second: no tarball"]);
      } finally {
        rmSync(two, { recursive: true, force: true });
      }
      expect(checkTarballs(fixture("root"), []).failures).toEqual([
        "@authtempo/fixture: no tarball",
        "read 0 tarballs",
        "read 0 files",
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
