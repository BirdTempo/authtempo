import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { breakingByMinor } from "../src/check-pack.ts";
import { releasedNames } from "../src/lib/released.ts";
import { summaryLine } from "../src/lib/report.ts";
import { type Manifest, readWorkspace } from "../src/lib/workspace.ts";
import { prepare, prepareManifest, refusal } from "../src/prepare.ts";
import { changesetVersion, copyFixture, RELEASE_COPY_FIXTURE } from "./support/release-copy.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixturePath = (path: string) => fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Manifest;
const URL_OF_REPO = "https://github.com/authtempo/authtempo";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A release copy of the fixture tree: changeset version has run, and the marker exists. */
function releaseCopy(edit: (dir: string) => void = () => {}): string {
  const dir = copyFixture((d) => {
    changesetVersion(d, "Add the first release.");
    writeFileSync(join(d, ".release-copy"), "");
    edit(d);
  });
  made.push(dir);
  return dir;
}

/** The client manifest of the fixture after changeset version. */
function clientManifest(): Manifest {
  const manifest = readJson(join(RELEASE_COPY_FIXTURE, "packages/client/package.json"));
  manifest.version = "0.1.0";
  return manifest;
}

describe("prepare", () => {
  it("removes private and writes the release fields from their sources", () => {
    const out = prepareManifest(clientManifest(), {
      dir: "packages/client",
      license: "MIT",
      repository: URL_OF_REPO,
    });
    expect("private" in out).toBe(false);
    expect(out.license).toBe("MIT");
    expect(out.repository).toEqual({
      type: "git",
      url: "git+https://github.com/authtempo/authtempo.git",
      directory: "packages/client",
    });
    expect(out.publishConfig).toEqual({ access: "public", provenance: true });

    // The entry reads the license of the root package.json, release/repository.json,
    // and the root LICENSE of the copy.
    const dir = releaseCopy();
    const report = prepare(dir);
    expect(summaryLine(report)).toBe("prepare: PASS packages=2 failures=0");
    const written = readFileSync(join(dir, "packages/client/package.json"), "utf8");
    expect(written).toBe(`${JSON.stringify(out, null, 2)}\n`);
    const rootLicense = readFileSync(join(dir, "LICENSE"), "utf8");
    for (const p of ["client", "core"])
      expect(readFileSync(join(dir, `packages/${p}/LICENSE`), "utf8")).toBe(rootLicense);
    // An unreleased package keeps its manifest byte for byte.
    expect(readFileSync(join(dir, "packages/sdk-conformance/package.json"), "utf8")).toBe(
      readFileSync(join(RELEASE_COPY_FIXTURE, "packages/sdk-conformance/package.json"), "utf8"),
    );
  });

  it("keeps the key order of the manifest and adds the new keys after version", () => {
    const out = prepareManifest(clientManifest(), {
      dir: "packages/client",
      license: "MIT",
      repository: URL_OF_REPO,
    });
    expect(Object.keys(out)).toEqual([
      "name",
      "version",
      "license",
      "repository",
      "publishConfig",
      "type",
      "exports",
      "files",
      "engines",
      "dependencies",
    ]);
  });

  it("refuses a manifest with no engines", () => {
    const manifest = clientManifest();
    delete manifest.engines;
    expect(() =>
      prepareManifest(manifest, {
        dir: "packages/client",
        license: "MIT",
        repository: URL_OF_REPO,
      }),
    ).toThrow("@authtempo/client: the manifest has no engines");

    const dir = releaseCopy((d) => {
      const file = join(d, "packages/client/package.json");
      const m = readJson(file);
      delete m.engines;
      writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
    });
    const report = prepare(dir);
    expect(summaryLine(report)).toBe("prepare: FAIL packages=2 failures=1");
    expect(report.failures).toEqual(["@authtempo/client: the manifest has no engines"]);
  });

  it("writes breaking and deprecations into core only", () => {
    const register = readFileSync(fixturePath("pack/deprecations.json"), "utf8");
    const dir = releaseCopy((d) => writeFileSync(join(d, "release/deprecations.json"), register));
    expect(summaryLine(prepare(dir))).toBe("prepare: PASS packages=2 failures=0");
    const core = readJson(join(dir, "packages/core/package.json"));
    expect(core.authtempo).toEqual({
      schemaVersion: 11,
      breaking: {},
      deprecations: JSON.parse(register),
    });
    const client = readJson(join(dir, "packages/client/package.json"));
    expect("authtempo" in client).toBe(false);

    // Until Task 9 writes the register, the tree has no file and no item is deprecated.
    const bare = releaseCopy();
    expect(summaryLine(prepare(bare))).toBe("prepare: PASS packages=2 failures=0");
    expect(readJson(join(bare, "packages/core/package.json")).authtempo).toEqual({
      schemaVersion: 11,
      breaking: {},
      deprecations: [],
    });
  });

  it("reads the Breaking lines per minor", () => {
    // A later release: the group at 0.2.0, with the changelog that core then holds.
    const changelog = readFileSync(fixturePath("pack/core/CHANGELOG.md"), "utf8");
    const lines = {
      "0.2": [
        "Breaking: remove the authtempo-import binary. Run authtempo import instead.",
        "Breaking: remove the read of the old session cookie tempo_session.",
      ],
    };
    expect(breakingByMinor(changelog)).toEqual(lines);
    const dir = releaseCopy((d) => {
      for (const p of ["client", "core"]) {
        const file = join(d, `packages/${p}/package.json`);
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace('"version": "0.1.0"', '"version": "0.2.0"'),
        );
      }
      writeFileSync(join(d, "packages/core/CHANGELOG.md"), changelog);
    });
    expect(summaryLine(prepare(dir))).toBe("prepare: PASS packages=2 failures=0");
    const core = readJson(join(dir, "packages/core/package.json"));
    expect((core.authtempo as { breaking?: unknown }).breaking).toEqual(lines);
  });

  it("refuses to run in the repo checkout", () => {
    // The checkout has .git and no .release-copy marker. The test reads the
    // refusal only: prepare on the checkout would write each manifest when
    // the guard regresses (review of Task 6, m3).
    expect(refusal(repoRoot)).toBe(
      `prepare runs only in a release copy: ${repoRoot} has .git or no .release-copy file`,
    );
    // private: true is the hold on main (spec 33): every released package keeps it.
    const released = new Set(releasedNames(repoRoot));
    const packages = readWorkspace(repoRoot).filter((p) => released.has(p.name));
    expect(packages.length).toBe(released.size);
    for (const p of packages) expect([p.name, p.manifest.private]).toEqual([p.name, true]);

    // prepare runs on fixture copies only. A copy with no marker is refused,
    // and so is a copy that holds .git. Each one keeps its manifests.
    const unmarked = copyFixture();
    made.push(unmarked);
    const withGit = releaseCopy((d) => writeFileSync(join(d, ".git"), "gitdir: /elsewhere\n"));
    for (const dir of [unmarked, withGit]) {
      const before = readFileSync(join(dir, "packages/client/package.json"), "utf8");
      expect(() => prepare(dir)).toThrow(
        `prepare runs only in a release copy: ${dir} has .git or no .release-copy file`,
      );
      expect(readFileSync(join(dir, "packages/client/package.json"), "utf8")).toBe(before);
    }
    // A release copy has the marker and no .git.
    expect(refusal(releaseCopy())).toBe(null);
  });
});
