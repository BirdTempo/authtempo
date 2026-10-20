import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkDependencies,
  type DependenciesInput,
  readInput,
  runtimeClosure,
} from "../src/check-dependencies.ts";
import { summaryLine } from "../src/lib/report.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const lockfile = (name: string) =>
  readFileSync(new URL(`./fixtures/lockfiles/${name}`, import.meta.url), "utf8");

/** A new copy of the input of the real tree, so that each test changes its own copy. */
const real = (): DependenciesInput => structuredClone(readInput(repoRoot));

const manifestOf = (input: DependenciesInput, name: string) => {
  const p = input.packages.find((q) => q.name === name);
  if (p === undefined) throw new Error(`no package ${name}`);
  return p.manifest;
};

const rowOf = (input: DependenciesInput, name: string, kind: string) => {
  const row = input.rows.find((r) => r.name === name && r.kind === kind);
  if (row === undefined) throw new Error(`no ${kind} row ${name}`);
  return row;
};

/** The fixture licenses: each package of gpl.yaml by name and version. */
const FIXTURE_LICENSES: Record<string, string> = {
  "@scope/tiny@1.2.3": "MIT",
  "copyleft@1.0.0": "GPL-3.0",
  "inner@4.5.6": "ISC",
  "native-bit@0.1.0": "BSD-2-Clause",
  "peer-lib@2.0.0": "MIT",
  "string-width@4.2.3": "MIT",
};
const fixtureLicense = (name: string, version: string) => {
  const license = FIXTURE_LICENSES[`${name}@${version}`];
  if (license === undefined) throw new Error(`no fixture license for ${name}@${version}`);
  return license;
};
const FIXTURE_RELEASED = [
  { name: "@fixture/core", dir: "packages/core" },
  { name: "@fixture/util", dir: "packages/util" },
];

describe("check-dependencies", () => {
  it("passes when each direct dependency has one row", () => {
    const r = checkDependencies(real());
    expect(r.failures).toEqual([]);
    expect(summaryLine(r)).toBe(
      "check-dependencies: PASS rows=89 runtime=34 peer=13 dev=42 packages=50 closure=33 exempt=1 builds=3 failures=0",
    );
  });

  it("fails a dependency with no row", () => {
    const input = real();
    const client = manifestOf(input, "@authtempo/client");
    client.dependencies = { ...client.dependencies, zod: "4.6.5" };
    const r = checkDependencies(input);
    expect(r.failures).toEqual([
      "zod: @authtempo/client takes it and no row names that user (kind runtime)",
    ]);
    expect(summaryLine(r)).toMatch(/^check-dependencies: FAIL /);
  });

  it("reads optionalDependencies as a runtime kind", () => {
    const input = real();
    const client = manifestOf(input, "@authtempo/client");
    client.optionalDependencies = { jose: "6.2.12" };
    expect(checkDependencies(input).failures).toEqual([
      "jose: @authtempo/client takes it and no row names that user (kind runtime)",
    ]);
  });

  it("fails a dependency of the root package with no row", () => {
    const input = real();
    const root = manifestOf(input, "authtempo");
    root.devDependencies = { ...root.devDependencies, "left-pad": "1.3.0" };
    expect(checkDependencies(input).failures).toEqual([
      "left-pad: authtempo takes it and no row names that user (kind dev)",
    ]);
  });

  it("fails a row with no user", () => {
    const input = real();
    rowOf(input, "jose", "runtime").users = [];
    expect(checkDependencies(input).failures).toContain("jose: the runtime row has no user");
  });

  it("fails a row with an empty reason", () => {
    const input = real();
    rowOf(input, "vitest", "dev").reason = " ";
    expect(checkDependencies(input).failures).toEqual(["vitest: the dev row has no reason"]);
  });

  it("fails a row with no read date", () => {
    const input = real();
    delete rowOf(input, "hono", "peer").read;
    rowOf(input, "turbo", "dev").read = "2026-10";
    expect(checkDependencies(input).failures).toEqual([
      "hono: the peer row has no read date in the form YYYY-MM-DD",
      "turbo: the dev row has no read date in the form YYYY-MM-DD",
    ]);
  });

  it("fails a runtime row with no seam", () => {
    const input = real();
    delete rowOf(input, "@simplewebauthn/server", "runtime").seam;
    expect(checkDependencies(input).failures).toEqual([
      "@simplewebauthn/server: the runtime row has no seam",
    ]);
  });

  it("fails a row whose users differ from the manifests", () => {
    const input = real();
    const row = rowOf(input, "bcryptjs", "runtime");
    row.users = [...(row.users as string[]), "@authtempo/client"];
    expect(checkDependencies(input).failures).toEqual([
      "bcryptjs: the runtime row names @authtempo/client, and @authtempo/client does not take it",
    ]);
  });

  it("fails a row whose versions differ from the manifests", () => {
    const input = real();
    const core = manifestOf(input, "@authtempo/core");
    core.dependencies = { ...core.dependencies, jose: "6.2.13" };
    expect(checkDependencies(input).failures).toEqual([
      "jose: the runtime row lists 6.2.12, and the manifests hold 6.2.13",
    ]);
  });

  it("fails two rows of one name and kind, and a row of another kind", () => {
    const input = real();
    input.rows.push({ ...rowOf(input, "zod", "runtime") });
    input.rows.push({ ...rowOf(input, "turbo", "dev"), kind: "optional" });
    const failures = checkDependencies(input).failures;
    expect(failures).toContain("zod: 2 runtime rows, not 1");
    expect(failures).toContain("turbo: the row has the kind optional, not runtime, peer, or dev");
  });

  it("fails a license outside the allow list in the runtime closure", () => {
    const closure = runtimeClosure(lockfile("gpl.yaml"), FIXTURE_RELEASED, fixtureLicense);
    // The closure follows dependencies and optionalDependencies of each released
    // importer and of each snapshot, through a workspace link and an alias. It
    // leaves out a devDependencies entry and each unreleased importer.
    expect(closure).toEqual([
      { name: "@scope/tiny", version: "1.2.3", license: "MIT", from: "@fixture/util" },
      { name: "copyleft", version: "1.0.0", license: "GPL-3.0", from: "@fixture/core" },
      { name: "inner", version: "4.5.6", license: "ISC", from: "@fixture/core" },
      { name: "native-bit", version: "0.1.0", license: "BSD-2-Clause", from: "@fixture/util" },
      { name: "peer-lib", version: "2.0.0", license: "MIT", from: "@fixture/core" },
      { name: "string-width", version: "4.2.3", license: "MIT", from: "@fixture/util" },
    ]);
    const input = real();
    input.closure = closure;
    input.licenseExempt = [];
    expect(checkDependencies(input).failures).toEqual([
      "copyleft@1.0.0 has the license GPL-3.0 in the runtime closure of @fixture/core, outside the allow list",
    ]);
  });

  it("reads a lockfile of one document, as pnpm writes it with no version document", () => {
    expect(runtimeClosure(lockfile("one-document.yaml"), FIXTURE_RELEASED, fixtureLicense)).toEqual(
      runtimeClosure(lockfile("gpl.yaml"), FIXTURE_RELEASED, fixtureLicense),
    );
  });

  it("passes a license outside the allow list only with an exemption of its name, version, and license", () => {
    const postgres = (input: DependenciesInput) => {
      const c = input.closure.find((p) => p.name === "postgres");
      if (c === undefined) throw new Error("no postgres in the closure");
      return c;
    };
    const version = real();
    postgres(version).version = "3.4.10";
    expect(checkDependencies(version).failures).toEqual([
      "postgres@3.4.9 (Unlicense): the license exemption matches no package in the runtime closure",
      "postgres@3.4.10 has the license Unlicense in the runtime closure of @authtempo/cli, outside the allow list",
    ]);
    const license = real();
    postgres(license).license = "GPL-3.0";
    expect(checkDependencies(license).failures).toEqual([
      "postgres@3.4.9 (Unlicense): the license exemption matches no package in the runtime closure",
      "postgres@3.4.9 has the license GPL-3.0 in the runtime closure of @authtempo/cli, outside the allow list",
    ]);
    const second = real();
    second.closure.push({
      name: "unlicensed",
      version: "1.0.0",
      license: "Unlicense",
      from: "@authtempo/core",
    });
    expect(checkDependencies(second).failures).toEqual([
      "unlicensed@1.0.0 has the license Unlicense in the runtime closure of @authtempo/core, outside the allow list",
    ]);
  });

  it("fails a license exemption that matches no package", () => {
    const input = real();
    input.licenseExempt.push({
      name: "left-pad",
      version: "1.3.0",
      license: "WTFPL",
      reason: "No package takes it.",
      readAt: "2026-10-20 22:10 CST",
    });
    expect(checkDependencies(input).failures).toEqual([
      "left-pad@1.3.0 (WTFPL): the license exemption matches no package in the runtime closure",
    ]);
  });

  it("fails a license exemption with no reason or no readAt", () => {
    const noReason = real();
    const [entry] = noReason.licenseExempt;
    if (entry === undefined) throw new Error("no license exemption");
    entry.reason = "";
    expect(checkDependencies(noReason).failures).toEqual([
      "postgres@3.4.9: the license exemption has no reason",
      "postgres@3.4.9 has the license Unlicense in the runtime closure of @authtempo/cli, outside the allow list",
    ]);
    const noRead = real();
    const [read] = noRead.licenseExempt;
    if (read === undefined) throw new Error("no license exemption");
    delete read.readAt;
    expect(checkDependencies(noRead).failures).toEqual([
      "postgres@3.4.9: the license exemption has no readAt",
      "postgres@3.4.9 has the license Unlicense in the runtime closure of @authtempo/cli, outside the allow list",
    ]);
  });

  it("throws on a lockfile version other than 9.0", () => {
    expect(() =>
      runtimeClosure(lockfile("version-6.yaml"), FIXTURE_RELEASED, fixtureLicense),
    ).toThrow("pnpm-lock.yaml: lockfileVersion 6.0 is not 9.0");
  });

  it("fails when minimumReleaseAge is gone or below 1440", () => {
    const gone = real();
    gone.workspaceYaml = gone.workspaceYaml.replace(/^minimumReleaseAge: 1440\n/m, "");
    expect(checkDependencies(gone).failures).toEqual([
      "minimumReleaseAge is gone from pnpm-workspace.yaml",
    ]);
    const low = real();
    low.workspaceYaml = low.workspaceYaml.replace(
      /^minimumReleaseAge: 1440$/m,
      "minimumReleaseAge: 60",
    );
    expect(checkDependencies(low).failures).toEqual(["minimumReleaseAge is 60, below 1440"]);
  });

  it("fails an allowBuilds line with no reason comment", () => {
    const input = real();
    input.workspaceYaml = input.workspaceYaml.replace(/^( {2}workerd: true) #.*$/m, "$1");
    expect(checkDependencies(input).failures).toEqual([
      "allowBuilds: workerd has no reason comment",
    ]);
    const form = real();
    form.workspaceYaml = form.workspaceYaml.replace(/^ {2}bun: true #.*$/m, "  bun true");
    expect(checkDependencies(form).failures).toEqual([
      'allowBuilds: the line "bun true" is not "<name>: <value> # <reason>"',
    ]);
  });

  it("fails when it reads zero rows", () => {
    const input = real();
    input.rows = [];
    const r = checkDependencies(input);
    expect(r.failures).toContain("read 0 rows");
    expect(summaryLine(r)).toMatch(/^check-dependencies: FAIL rows=0 /);
  });
});
