import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPackages, readInput } from "../src/check-packages.ts";
import { summaryLine } from "../src/lib/report.ts";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/workspaces/${name}`, import.meta.url));
const run = (name: string) => checkPackages(readInput(fixture(name)));

describe("check-packages", () => {
  it("passes when each package is in exactly one list", () => {
    const r = run("ok");
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe(
      "check-packages: PASS packages=5 released=3 unreleased=2 failures=0",
    );
  });

  it("fails on a package in neither list", () => {
    const r = run("orphan");
    expect(r.failures).toContain("@fixture/new is in neither list");
    expect(summaryLine(r)).toMatch(/^check-packages: FAIL /);
  });

  it("fails on a package in both lists", () => {
    expect(run("both").failures).toContain(
      "authtempo-example-node is in the fixed group and in release/unreleased.json",
    );
  });

  it("fails on a package in the group and in ignore at once", () => {
    expect(run("ignored-released").failures).toContain(
      "@authtempo/cli is in the fixed group and in ignore",
    );
  });

  it("fails when ignore and unreleased.json differ", () => {
    const failures = run("ignore-drift").failures;
    expect(failures).toContain(
      "authtempo-example-node is in release/unreleased.json and not in ignore",
    );
    expect(failures).toContain("@authtempo/site is in ignore and not in release/unreleased.json");
  });

  it("fails on an unreleased entry with no reason", () => {
    expect(run("no-reason").failures).toContain(
      "authtempo-example-node has no reason in release/unreleased.json",
    );
  });

  it("fails on a released package that is not private on main", () => {
    expect(run("public").failures).toContain(
      "@authtempo/client is released and not private: true on main",
    );
  });

  it("fails on a version that differs in the group", () => {
    expect(run("two-versions").failures).toContain(
      "the fixed group holds 2 versions: @authtempo/cli@0.0.0, @authtempo/client@0.1.0, @authtempo/core@0.0.0",
    );
  });

  it("fails a group version at 0.0.x above 0.0.0", () => {
    // A version pull request with only patch changesets writes 0.0.1. The first
    // release is 0.1.0, so the pull request fails before the merge (ruling 31).
    const ok = readInput(fixture("ok"));
    const released = new Set(ok.fixed);
    const at = (version: string) =>
      checkPackages({
        ...ok,
        packages: ok.packages.map((p) =>
          released.has(p.name) ? { ...p, manifest: { ...p.manifest, version } } : p,
        ),
      });
    for (const version of ["0.0.1", "0.0.12"])
      expect(at(version).failures).toEqual([
        `the fixed group is at ${version}; the first release is 0.1.0, so no group version is 0.0.x above 0.0.0`,
      ]);
    for (const version of ["0.0.0", "0.1.0", "0.1.1", "1.0.0"])
      expect(at(version).failures).toEqual([]);
  });

  it("fails on an @authtempo reference that is not workspace:*", () => {
    expect(run("caret").failures).toContain(
      "@authtempo/client references @authtempo/core as workspace:^, not workspace:*",
    );
    expect(run("range").failures).toContain(
      "@authtempo/client references @authtempo/core as ^0.1.0, not workspace:*",
    );
  });

  it("fails on a devDependencies reference that is not workspace:*", () => {
    expect(run("dev-caret").failures).toEqual([
      "@authtempo/site references @authtempo/cli as workspace:^, not workspace:*",
    ]);
  });

  it("fails on an unscoped workspace name that is not workspace:*", () => {
    expect(run("unscoped-range").failures).toContain(
      "@authtempo/core references authtempo-example-node as ^0.0.0, not workspace:*",
    );
  });

  it("fails on a runtime reference of a released package to an unreleased one", () => {
    expect(run("runtime-unreleased").failures).toEqual([
      "@authtempo/cli is released and names the unreleased authtempo-example-node in optionalDependencies",
      "@authtempo/client is released and names the unreleased @authtempo/site in peerDependencies",
      "@authtempo/core is released and names the unreleased authtempo-example-node in dependencies",
    ]);
  });

  it("fails on two folders with one package name", () => {
    expect(run("duplicate").failures).toEqual([
      "@authtempo/client is the name of 2 folders: packages/client, packages/zz-dup",
    ]);
  });

  it("fails on a second fixed group", () => {
    expect(run("two-groups").failures).toEqual(["fixed holds 2 groups, not 1 group"]);
  });

  it("fails on a linked group", () => {
    expect(run("linked").failures).toEqual(["linked holds 1 group, not 0 groups"]);
  });

  it("throws on a linked value that is not a list of name lists", () => {
    expect(() => run("bad-linked")).toThrow(
      ".changeset/config.json: linked is not a list of name lists",
    );
  });

  it("fails on a listed name that is not a workspace package", () => {
    expect(run("stale").failures).toContain(
      "@authtempo/gone is in the fixed group and is not a workspace package",
    );
  });

  it("fails when it reads zero packages", () => {
    const r = run("empty");
    expect(summaryLine(r)).toMatch(/^check-packages: FAIL packages=0 /);
    expect(r.failures).toContain("read 0 packages");
  });

  it("reads the real tree", () => {
    const r = checkPackages(readInput(fileURLToPath(new URL("../../../", import.meta.url))));
    expect(summaryLine(r)).toMatch(/^check-packages: PASS packages=\d+ released=24 /);
    expect(r.failures).toEqual([]);
  });
});
