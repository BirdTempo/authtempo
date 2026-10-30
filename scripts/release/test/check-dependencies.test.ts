import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkDependencies,
  type DependenciesInput,
  readInput,
  runtimeClosure,
  storeLicense,
} from "../src/check-dependencies.ts";
import { summaryLine } from "../src/lib/report.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const lockfile = (name: string) =>
  readFileSync(new URL(`./fixtures/lockfiles/${name}`, import.meta.url), "utf8");

/** A new copy of the input of the real tree, so that each test changes its own copy. */
const real = (): DependenciesInput => structuredClone(readInput(repoRoot));

/**
 * The real input with a fixture closure in place of the real one. The real
 * platform rows describe the real closure, so they go with it.
 */
const realWith = (closure: DependenciesInput["closure"]): DependenciesInput => {
  const input = real();
  input.closure = closure;
  input.rows = input.rows.filter((r) => r.kind !== "platform");
  return input;
};

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
      "check-dependencies: PASS rows=111 runtime=37 peer=16 dev=49 platform=9 packages=53 closure=65 skipped=8 exempt=1 builds=5 failures=0",
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
    expect(failures).toContain(
      "turbo: the row has the kind optional, not runtime, peer, dev, or platform",
    );
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
      {
        name: "native-bit",
        version: "0.1.0",
        license: "BSD-2-Clause",
        from: "@fixture/util",
        platform: true,
      },
      { name: "peer-lib", version: "2.0.0", license: "MIT", from: "@fixture/core" },
      { name: "string-width", version: "4.2.3", license: "MIT", from: "@fixture/util" },
    ]);
    const input = realWith(closure);
    input.licenseExempt = [];
    expect(checkDependencies(input).failures).toEqual([
      "copyleft@1.0.0 has the license GPL-3.0 in the runtime closure of @fixture/core, outside the allow list",
    ]);
  });

  it("reads a skipped platform package from its platform row, with the real license reader", () => {
    // The lockfile limits @esbuild/aix-ppc64 to aix on ppc64, so pnpm skips it on
    // each machine of this repository. jose 6.2.12 is installed in the store.
    const closure = runtimeClosure(
      lockfile("platform.yaml"),
      [{ name: "@fixture/core", dir: "packages/core" }],
      storeLicense(repoRoot),
    );
    expect(closure).toEqual([
      {
        name: "@esbuild/aix-ppc64",
        version: "0.28.1",
        license: "",
        from: "@fixture/core",
        platform: true,
        skipped: true,
      },
      { name: "jose", version: "6.2.12", license: "MIT", from: "@fixture/core" },
    ]);
    const input = realWith(closure);
    input.licenseExempt = [];
    const none = checkDependencies(input);
    expect(none.failures).toEqual([
      "@esbuild/aix-ppc64@0.28.1: pnpm skipped this platform package on this machine, and no platform row in release/dependencies.json gives its license",
    ]);
    expect(summaryLine(none)).toMatch(/^check-dependencies: FAIL .* closure=2 skipped=1 /);
    const row = {
      name: "@esbuild/aix-ppc64",
      kind: "platform",
      versions: ["0.28.1"],
      license: "MIT",
      reason: "esbuild takes it as an optional dependency for aix on ppc64.",
      read: "2026-10-21",
    };
    input.rows.push(row);
    const held = checkDependencies(input);
    expect(held.failures).toEqual([]);
    expect(summaryLine(held)).toMatch(/ platform=1 packages=53 closure=2 skipped=1 /);
    row.license = "GPL-3.0";
    expect(checkDependencies(input).failures).toEqual([
      "@esbuild/aix-ppc64@0.28.1 has the license GPL-3.0 in the runtime closure of @fixture/core, outside the allow list",
    ]);
  });

  it("throws for a package that is not installed and has no platform limit", () => {
    expect(() =>
      runtimeClosure(lockfile("gpl.yaml"), FIXTURE_RELEASED, storeLicense(repoRoot)),
    ).toThrow(
      "no package.json for @scope/tiny@1.2.3 under node_modules/.pnpm: run pnpm install --offline --frozen-lockfile",
    );
  });

  it("fails a platform row with a gap, a stale platform row, and a row that the installed license contradicts", () => {
    const input = realWith(
      runtimeClosure(lockfile("gpl.yaml"), FIXTURE_RELEASED, fixtureLicense).filter(
        (c) => c.name !== "copyleft",
      ),
    );
    input.licenseExempt = [];
    const row = (name: string, fields: Record<string, unknown>) => ({
      name,
      kind: "platform",
      versions: ["0.1.0"],
      license: "BSD-2-Clause",
      reason: "A platform package.",
      read: "2026-10-21",
      ...fields,
    });
    input.rows.push(row("native-bit", { license: "MIT" }));
    input.rows.push(row("@esbuild/linux-x64", { versions: ["0.28.1"] }));
    input.rows.push(row("gap", { versions: [], license: "", reason: "", read: "2026-10" }));
    expect(checkDependencies(input).failures).toEqual([
      "@esbuild/linux-x64@0.28.1: the platform row matches no platform package of the runtime closure",
      "gap: the platform row has no reason",
      "gap: the platform row has no read date in the form YYYY-MM-DD",
      "gap: the platform row lists no version",
      "gap: the platform row has no license",
      "native-bit@0.1.0: the platform row gives the license MIT, and the installed package.json gives BSD-2-Clause",
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
      read: "2026-10-20",
    });
    expect(checkDependencies(input).failures).toEqual([
      "left-pad@1.3.0 (WTFPL): the license exemption matches no package in the runtime closure",
    ]);
  });

  it("fails a license exemption with no reason, or with no read date in the form YYYY-MM-DD", () => {
    const noReason = real();
    const [entry] = noReason.licenseExempt;
    if (entry === undefined) throw new Error("no license exemption");
    entry.reason = "";
    expect(checkDependencies(noReason).failures).toEqual([
      "postgres@3.4.9: the license exemption has no reason",
      "postgres@3.4.9 has the license Unlicense in the runtime closure of @authtempo/cli, outside the allow list",
    ]);
    // The old field readAt, a time in the date, and other text each fail.
    for (const change of [
      (e: Record<string, unknown>) => {
        e.readAt = e.read;
        delete e.read;
      },
      (e: Record<string, unknown>) => {
        e.read = "2026-10-20 21:58 CST";
      },
      (e: Record<string, unknown>) => {
        e.read = "x";
      },
    ]) {
      const noRead = real();
      const [read] = noRead.licenseExempt;
      if (read === undefined) throw new Error("no license exemption");
      change(read);
      expect(checkDependencies(noRead).failures).toEqual([
        "postgres@3.4.9: the license exemption has no read date in the form YYYY-MM-DD",
        "postgres@3.4.9 has the license Unlicense in the runtime closure of @authtempo/cli, outside the allow list",
      ]);
    }
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

  it("fails a minimumReleaseAgeExclude entry with no row, in block and flow form", () => {
    const flow = real();
    flow.workspaceYaml = flow.workspaceYaml.replace(
      /^minimumReleaseAge: 1440$/m,
      "minimumReleaseAge: 1440\nminimumReleaseAgeExclude: ['*']",
    );
    expect(checkDependencies(flow).failures).toEqual([
      "minimumReleaseAgeExclude: * has no row in release/dependencies.json",
    ]);
    const block = real();
    block.workspaceYaml = block.workspaceYaml.replace(
      /^minimumReleaseAge: 1440$/m,
      "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - left-pad\n  - 'jose@6.2.13'",
    );
    expect(checkDependencies(block).failures).toEqual([
      "minimumReleaseAgeExclude: left-pad has no row in release/dependencies.json",
      "minimumReleaseAgeExclude: jose@6.2.13 has no row in release/dependencies.json",
    ]);
    const empty = real();
    empty.workspaceYaml = empty.workspaceYaml.replace(
      /^minimumReleaseAge: 1440$/m,
      "minimumReleaseAge: 1440\nminimumReleaseAgeExclude: []",
    );
    expect(checkDependencies(empty).failures).toEqual([]);
  });

  it("passes a minimumReleaseAgeExclude entry only with a row that holds a reason and a read date", () => {
    const input = real();
    input.workspaceYaml = input.workspaceYaml.replace(
      /^minimumReleaseAge: 1440$/m,
      "minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - jose\n  - zod@4.6.5",
    );
    expect(checkDependencies(input).failures).toEqual([]);
    // jose has a dev row and a runtime row: one of them with a reason holds the entry.
    rowOf(input, "jose", "runtime").reason = "";
    expect(checkDependencies(input).failures).toEqual(["jose: the runtime row has no reason"]);
    rowOf(input, "jose", "dev").reason = "";
    delete rowOf(input, "zod", "runtime").read;
    expect(checkDependencies(input).failures).toEqual([
      "minimumReleaseAgeExclude: jose has no row in release/dependencies.json",
      "minimumReleaseAgeExclude: zod@4.6.5 has no row in release/dependencies.json",
      "jose: the dev row has no reason",
      "jose: the runtime row has no reason",
      "zod: the runtime row has no read date in the form YYYY-MM-DD",
    ]);
  });

  it("reads allowBuilds in flow form, and fails each entry with no reason comment", () => {
    const input = real();
    input.workspaceYaml = input.workspaceYaml.replace(
      /^allowBuilds:\n(?: {2}.*\n)*/m,
      "allowBuilds: { esbuild: true, workerd: true, bun: true, evil-pkg: true }\n",
    );
    const r = checkDependencies(input);
    expect(r.failures).toEqual([
      "allowBuilds: esbuild has no reason comment",
      "allowBuilds: workerd has no reason comment",
      "allowBuilds: bun has no reason comment",
      "allowBuilds: evil-pkg has no reason comment",
    ]);
    expect(summaryLine(r)).toMatch(/ builds=4 failures=4$/);
    const lines = real();
    lines.workspaceYaml = lines.workspaceYaml.replace(
      /^allowBuilds:\n(?: {2}.*\n)*/m,
      "allowBuilds: {\n  esbuild: true, # it links the platform binary\n  evil-pkg: true,\n}\n",
    );
    expect(checkDependencies(lines).failures).toEqual([
      "allowBuilds: evil-pkg has no reason comment",
    ]);
    const odd = real();
    odd.workspaceYaml = odd.workspaceYaml.replace(
      /^allowBuilds:\n(?: {2}.*\n)*/m,
      "allowBuilds: true\n",
    );
    expect(checkDependencies(odd).failures).toEqual([
      'allowBuilds: the value "true" is not a list of "<name>: <value> # <reason>"',
    ]);
  });

  it("fails dangerouslyAllowAllBuilds", () => {
    const input = real();
    input.workspaceYaml = `${input.workspaceYaml}dangerouslyAllowAllBuilds: true\n`;
    expect(checkDependencies(input).failures).toEqual([
      "dangerouslyAllowAllBuilds is in pnpm-workspace.yaml: list each build in allowBuilds with a reason",
    ]);
  });

  it("fails each key that changes what pnpm installs and that no rule reads", () => {
    const input = real();
    input.workspaceYaml = `${input.workspaceYaml}overrides:\n  jose: 6.2.13\npackageExtensions: {}\npatchedDependencies:\n  zod: patches/zod.patch\ncatalog:\n  zod: 4.6.5\ncatalogs: {}\n`;
    expect(checkDependencies(input).failures).toEqual([
      "overrides is in pnpm-workspace.yaml: no rule of check-dependencies reads it yet",
      "packageExtensions is in pnpm-workspace.yaml: no rule of check-dependencies reads it yet",
      "patchedDependencies is in pnpm-workspace.yaml: no rule of check-dependencies reads it yet",
      "catalog is in pnpm-workspace.yaml: no rule of check-dependencies reads it yet",
      "catalogs is in pnpm-workspace.yaml: no rule of check-dependencies reads it yet",
    ]);
  });

  it("fails the keys pnpm and resolutions of the root package.json", () => {
    const clean = real();
    const cleanRoot = manifestOf(clean, "authtempo");
    expect([cleanRoot.pnpm, cleanRoot.resolutions]).toEqual([undefined, undefined]);
    expect(checkDependencies(clean).failures).toEqual([]);
    const input = real();
    const root = manifestOf(input, "authtempo");
    root.pnpm = { overrides: { jose: "6.2.13" }, onlyBuiltDependencies: ["esbuild"] };
    root.resolutions = { zod: "4.6.6" };
    expect(checkDependencies(input).failures).toEqual([
      "pnpm (overrides, onlyBuiltDependencies) is in the root package.json: no rule of check-dependencies reads it yet",
      "resolutions is in the root package.json: no rule of check-dependencies reads it yet",
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
