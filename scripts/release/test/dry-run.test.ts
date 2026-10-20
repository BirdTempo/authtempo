import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkTarballs, readTarball } from "../src/check-pack.ts";
import { readYaml, type YamlNode } from "../src/check-workflows.ts";
import {
  type ChildEnv,
  type ChildFiles,
  childEnv,
  type DryRunReport,
  dryRun,
  dryRunLine,
  NPM_SCOPE_REGISTRY,
  npmPublishArgs,
  PNPM_PUBLISH_ARGS,
  PNPM_SCOPE_REGISTRY,
  type Run,
  type RunResult,
  spawnRun,
  type ToolPaths,
} from "../src/dry-run.ts";
import { buildCommand } from "../src/lib/release-copy.ts";
import { reportLines } from "../src/lib/report.ts";
import { readWorkspace } from "../src/lib/workspace.ts";
import { prepare } from "../src/prepare.ts";
import { changesetVersion, copyFixture } from "./support/release-copy.ts";

/** What the three path reads print for a person, in the form of pnpm 12.8.1 and npm 11.19.1. */
const PERSON: ToolPaths = {
  store: "/home/person/Library/pnpm/store/v11",
  pnpmCache: "/home/person/Library/Caches/pnpm",
  npmCache: "/home/person/.npm",
};

/** The kinds of the three path reads, which come before each other call. */
const READS = ["pnpm store", "pnpm cache", "npm config"];

/** The files of childEnv and some tool paths in a new temp folder, for a call of a real tool. */
function childFiles(temp: string): { files: ChildFiles; paths: ToolPaths } {
  mkdirSync(temp, { recursive: true });
  const files = {
    user: join(temp, "npmrc-user"),
    global: join(temp, "npmrc-global"),
    home: join(temp, "home"),
  };
  writeFileSync(files.user, "");
  writeFileSync(files.global, "");
  mkdirSync(files.home);
  const paths = {
    store: join(temp, "store"),
    pnpmCache: join(temp, "pnpm-cache"),
    npmCache: join(temp, "npm-cache"),
  };
  return { files, paths };
}

interface Call {
  kind: string;
  cmd: string;
  args: string[];
  cwd: string;
  env: ChildEnv;
}

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const fromReport = (lines: string[], failed: boolean): RunResult => ({
  status: failed ? 1 : 0,
  stdout: `${lines.join("\n")}\n`,
  stderr: "",
});

/** The step of one child process call, by its command and its first arguments. */
function kindOf(cmd: string, args: readonly string[], cwd: string): string {
  const [a = "", b = ""] = args;
  if (cmd === "git") return `git ${a}`;
  if (cmd === "tar") return "extract";
  if (cmd === "npm" && a === "publish") return "npm publish";
  if (cmd === "node") return a.endsWith("smoke.mjs") ? "smoke" : `node ${a.split("/").pop()}`;
  if (cmd === "pnpm" && a === "install")
    return cwd.endsWith("/smoke") ? "smoke install" : "install";
  if (cmd === "pnpm" && a === "turbo") return `turbo ${b} ${args[2] ?? ""}`;
  if (cmd === "pnpm" && args.includes("pack")) return "pnpm pack";
  if (cmd === "pnpm") return `pnpm ${a}`;
  return `${cmd} ${a}`;
}

/**
 * A fake of each child process of the dry run. git archive and tar make a real
 * copy of the checkout, and pnpm pack runs for real on the fixture packages.
 * prepare and check-pack run in this process on the copy. The other calls get
 * the answer of the real command, as Task 6 Step 1 read it.
 */
function fake(change: Record<string, (call: Call) => RunResult | undefined> = {}) {
  const calls: Call[] = [];
  const changesets: string[] = [];
  const run: Run = (cmd, args, cwd, env) => {
    const call = { kind: kindOf(cmd, args, cwd), cmd, args: [...args], cwd, env: { ...env } };
    calls.push(call);
    const changed = change[call.kind]?.(call);
    if (changed !== undefined) return changed;
    switch (call.kind) {
      case "pnpm store":
        return ok(`${PERSON.store}\n`);
      case "pnpm cache":
        return ok(`${PERSON.pnpmCache}\n`);
      case "npm config":
        return ok(`${PERSON.npmCache}\n`);
      case "git status":
        return ok();
      case "git archive": {
        const out = args[args.indexOf("-o") + 1] ?? "";
        execFileSync("tar", ["-cf", out, "-C", cwd, "."]);
        return ok();
      }
      case "extract":
        execFileSync("tar", args, { cwd });
        return ok();
      case "pnpm changeset": {
        const file = join(cwd, ".changeset/dry-run.md");
        const text = readFileSync(file, "utf8");
        changesets.push(text);
        changesetVersion(cwd, text.split("---\n").pop()?.trim() ?? "");
        return ok("🦋  All files have been updated.\n");
      }
      case "node prepare.ts": {
        const r = prepare(cwd);
        return fromReport(reportLines(r), r.failures.length > 0);
      }
      case "pnpm pack":
        return ok(
          execFileSync("pnpm", args, {
            cwd,
            encoding: "utf8",
            env: { ...process.env, NO_COLOR: "1" },
          }),
        );
      case "node check-pack.ts": {
        // An error that check-pack throws ends the real process with exit 1 and no report.
        try {
          const r = checkTarballs(cwd, args.slice(1));
          return fromReport(reportLines(r), r.failures.length > 0);
        } catch (error) {
          return { status: 1, stdout: "", stderr: `${String(error)}\n` };
        }
      }
      case "npm publish": {
        const t = readTarball(args[1] ?? "");
        return {
          status: 0,
          stdout: `+ ${t.manifest.name}@${t.manifest.version}\n`,
          stderr:
            "npm notice Publishing to http://127.0.0.1:9 with tag latest and public access (dry-run)\n",
        };
      }
      case "pnpm publish":
        return ok(pnpmPublishLines(cwd).join("\n"));
      case "smoke": {
        // The real smoke.mjs reads the released list from the config of the copy.
        const config = join(cwd, "../repo/.changeset/config.json");
        if (
          args.length !== 2 ||
          args[0] !== "smoke.mjs" ||
          args[1] !== config ||
          !existsSync(config)
        )
          return fromReport(
            [
              "smoke: FAIL packages=2 released=0 entries=0 exempt=0 cli=0 failures=1",
              "  give the path of .changeset/config.json, whose fixed[0] is the released list",
            ],
            true,
          );
        return ok("smoke: PASS packages=2 released=2 entries=2 exempt=0 cli=0 failures=0\n");
      }
      default:
        return ok();
    }
  };
  return { run, calls, changesets };
}

/**
 * What pnpm publish -r --dry-run prints in the copy at `repo`: one package for
 * each workspace package with no private, as pnpm 12.8.1 does.
 */
function pnpmPublishLines(repo: string, skip = ""): string[] {
  return readWorkspace(repo)
    .map((p) => p.manifest)
    .filter((m) => m.private !== true && m.name !== skip)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((m) => [
      `📦 ${m.name}@${m.version} → http://127.0.0.1:9/`,
      `[WARN] Skip publishing ${m.name}@${m.version} (dry run)`,
    ]);
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkout (a copy of the fixture tree) and a parent for the temp folder of the dry run. */
function setup(edit: (dir: string) => void = () => {}) {
  const root = copyFixture(edit);
  const tmp = mkdtempSync(join(tmpdir(), "authtempo-dry-run-test-"));
  made.push(root, tmp);
  return { root, tmp };
}

/** Each file of `dir` with its bytes, so a test can prove that the dry run changed nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path, "base64");
    }
  };
  walk(dir);
  return out;
}

async function passingRun(env?: NodeJS.ProcessEnv) {
  const { root, tmp } = setup();
  const before = snapshot(root);
  const f = fake();
  const report = await dryRun({ root, run: f.run, tmp, ...(env === undefined ? {} : { env }) });
  return { root, tmp, before, report, ...f };
}

const failuresOf = (r: DryRunReport) => r.failures;

const repoRoot = new URL("../../../", import.meta.url);

/**
 * Each command line of the steps of the job check of release.yml that run in
 * the release copy, in order.
 */
function releaseCopyLines(): string[] {
  const text = readFileSync(new URL(".github/workflows/release.yml", repoRoot), "utf8");
  const map = (n: YamlNode | undefined) => (n?.kind === "map" ? n.entries : {});
  const steps = map(map(map(readYaml(text)).jobs).check).steps;
  if (steps?.kind !== "list") throw new Error("release.yml: jobs.check.steps is not a list");
  return steps.items.flatMap((step) => {
    const e = map(step);
    const dir = e["working-directory"];
    const run = e.run;
    if (dir?.kind !== "scalar" || !dir.value?.endsWith("/release-copy")) return [];
    if (run?.kind !== "scalar" || run.value === null) return [];
    return run.value
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(pnpm|node) /.test(l));
  });
}

describe("dry run", () => {
  it("stops on a dirty checkout with exit 2", async () => {
    const { root, tmp } = setup();
    const f = fake({ "git status": () => ok(" M package.json\n") });
    const report = await dryRun({ root, run: f.run, tmp });
    expect(report.exit).toBe(2);
    expect(failuresOf(report)).toEqual([
      "the checkout has changes that git archive HEAD does not hold: M package.json",
    ]);
    expect(dryRunLine(report)).toBe(
      "release-dry-run: FAIL packages=0 of 0 version=none tarballs=0 files=0 smoke=0 failures=1",
    );
    expect(f.calls.map((c) => c.kind)).toEqual([...READS, "git status"]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("runs the steps in order", async () => {
    const { report, calls, changesets } = await passingRun();
    expect(calls.map((c) => c.kind)).toEqual([
      ...READS,
      "git status",
      "git archive",
      "extract",
      "install",
      "pnpm changeset",
      "node prepare.ts",
      "turbo run build",
      "pnpm pack",
      "pnpm pack",
      "node check-pack.ts",
      "npm publish",
      "npm publish",
      "pnpm publish",
      "smoke install",
      "smoke",
    ]);
    expect(changesets).toEqual([
      '---\n"@authtempo/client": minor\n"@authtempo/core": minor\n---\n\nDry run of the next release.\n',
    ]);
    // smoke.mjs reads the released list from the config path (review of Task 6, L1).
    const smoke = calls.find((c) => c.kind === "smoke");
    expect([smoke?.cwd, smoke?.args]).toEqual([
      `${report.dir}/smoke`,
      ["smoke.mjs", `${report.dir}/repo/.changeset/config.json`],
    ]);
    expect(failuresOf(report)).toEqual([]);
    expect(report.exit).toBe(0);
    expect(dryRunLine(report)).toBe(
      "release-dry-run: PASS packages=2 of 2 version=0.1.0 tarballs=2 files=10 smoke=1 failures=0",
    );
    const lines = report.lines.filter((l) => l.startsWith("@authtempo/"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^@authtempo\/client@0\.1\.0 [0-9a-f]{64} files=5$/);
    expect(lines[1]).toMatch(/^@authtempo\/core@0\.1\.0 [0-9a-f]{64} files=5$/);
  });

  it("runs the release copy steps of release.yml", async () => {
    // ruling 21 of plan 12j: the dry run and the job check run one list of
    // commands in the copy. The pack and check-pack lines differ only by the
    // name and the paths that the shell fills in.
    const { report, calls } = await passingRun();
    expect(report.exit).toBe(0);
    const dir = report.dir ?? "";
    const out = `${dir}/out`;
    const kinds = [
      "install",
      "node prepare.ts",
      "turbo run build",
      "pnpm pack",
      "node check-pack.ts",
    ];
    // One pack line stands for the loop of release.yml, so the first pack call is enough.
    const firstPack = calls.find((c) => c.kind === "pnpm pack");
    const lines = calls
      .filter((c) => kinds.includes(c.kind) && (c.kind !== "pnpm pack" || c === firstPack))
      .map((c) => {
        if (c.kind === "pnpm pack")
          return `pnpm ${c.args.map((a, i) => (i === 1 ? '"$name"' : a === out ? '"$PWD/out"' : a)).join(" ")}`;
        if (c.kind === "node check-pack.ts") return `node ${c.args[0]} out/*.tgz`;
        if (c.kind === "turbo run build") {
          // One filter for each released package, which the shell reads from fixed[0].
          const filters = c.args.filter((a) => a.startsWith("--filter="));
          expect(filters).toEqual(["--filter=@authtempo/client", "--filter=@authtempo/core"]);
          const rest = c.args.filter((a) => !a.startsWith("--filter="));
          return `pnpm ${rest.join(" ")} $(jq -r '"--filter=" + .fixed[0][]' .changeset/config.json)`;
        }
        return `${c.cmd} ${c.args.join(" ")}`;
      });
    expect(lines).toEqual(releaseCopyLines());
    expect(releaseCopyLines()).toEqual([
      "pnpm install --frozen-lockfile --offline",
      "node scripts/release/src/prepare.ts",
      `pnpm turbo run build --cache=local:w $(jq -r '"--filter=" + .fixed[0][]' .changeset/config.json)`,
      'pnpm --filter "$name" pack --ignore-scripts --pack-destination "$PWD/out"',
      "node scripts/release/src/check-pack.ts out/*.tgz",
    ]);
  });

  it("fails when the pnpm publish list differs from the tarballs", async () => {
    const { root, tmp } = setup();
    const f = fake({
      "pnpm publish": (c) => ok(pnpmPublishLines(c.cwd, "@authtempo/core").join("\n")),
    });
    const report = await dryRun({ root, run: f.run, tmp });
    expect(failuresOf(report)).toEqual([
      "pnpm publish -r --dry-run does not list @authtempo/core@0.1.0",
    ]);
    expect(report.exit).toBe(1);
    expect(dryRunLine(report)).toBe(
      "release-dry-run: FAIL packages=1 of 2 version=0.1.0 tarballs=2 files=10 smoke=0 failures=1",
    );
    expect(f.calls.map((c) => c.kind)).not.toContain("smoke");
  });

  it("fails when the pnpm publish list names a package with no tarball", async () => {
    // check-packages holds private only on a released package, so an
    // unreleased package with no private reaches pnpm publish -r.
    const { root, tmp } = setup((d) => {
      const file = join(d, "packages/sdk-conformance/package.json");
      const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      delete m.private;
      writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
    });
    const f = fake();
    const report = await dryRun({ root, run: f.run, tmp });
    expect(failuresOf(report)).toEqual([
      "pnpm publish -r --dry-run lists @authtempo/sdk-conformance@0.0.0, which has no tarball",
    ]);
    expect(report.exit).toBe(1);
    expect(dryRunLine(report)).toBe(
      "release-dry-run: FAIL packages=2 of 2 version=0.1.0 tarballs=2 files=10 smoke=0 failures=1",
    );
    expect(f.calls.map((c) => c.kind)).not.toContain("smoke");
  });

  it("fails when it reads zero packages", async () => {
    const { root, tmp } = setup((d) => {
      const file = join(d, ".changeset/config.json");
      const config = JSON.parse(readFileSync(file, "utf8")) as { fixed: string[][] };
      config.fixed = [[]];
      writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    });
    const f = fake();
    const report = await dryRun({ root, run: f.run, tmp });
    expect(failuresOf(report)).toEqual(["read 0 packages"]);
    expect(report.exit).toBe(1);
    expect(dryRunLine(report)).toBe(
      "release-dry-run: FAIL packages=0 of 0 version=none tarballs=0 files=0 smoke=0 failures=1",
    );
    expect(f.calls.map((c) => c.kind)).not.toContain("pnpm changeset");
  });

  it("fails when a count is not n of n", async () => {
    const { root, tmp } = setup();
    const f = fake({
      "npm publish": (c) =>
        c.args[1]?.includes("authtempo-core-")
          ? { status: 1, stdout: "", stderr: "npm error code E403\n" }
          : undefined,
    });
    const report = await dryRun({ root, run: f.run, tmp });
    expect(failuresOf(report)).toEqual([
      "@authtempo/core@0.1.0: npm publish --dry-run exited 1: npm error code E403",
    ]);
    expect(dryRunLine(report)).toBe(
      "release-dry-run: FAIL packages=1 of 2 version=0.1.0 tarballs=2 files=10 smoke=0 failures=1",
    );
  });

  it("counts the packages that pass check-pack", async () => {
    // A failure that names core holds back core only.
    const { root, tmp } = setup((d) => {
      const file = join(d, "packages/core/package.json");
      const m = JSON.parse(readFileSync(file, "utf8")) as { files: string[] };
      m.files = m.files.filter((f) => f !== "CHANGELOG.md");
      writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
    });
    const f = fake();
    const report = await dryRun({ root, run: f.run, tmp });
    expect(failuresOf(report)).toEqual([
      "check-pack exited 1: check-pack: FAIL tarballs=2 files=9 failures=2",
      "check-pack: @authtempo/core@0.1.0: the tarball has no CHANGELOG.md",
      "check-pack: @authtempo/core@0.1.0: the needed file CHANGELOG.md of release/pack-needs.json is not in the tarball",
    ]);
    expect(dryRunLine(report)).toBe(
      "release-dry-run: FAIL packages=1 of 2 version=0.1.0 tarballs=2 files=9 smoke=0 failures=3",
    );
    expect(f.calls.map((c) => c.kind)).not.toContain("npm publish");

    // A failure that names no package holds back each package, so the line
    // never reads 2 of 2 on a check that did not pass.
    const broken = setup((d) => rmSync(join(d, "release/pack-needs.json")));
    const g = fake();
    const r2 = await dryRun({ root: broken.root, run: g.run, tmp: broken.tmp });
    expect(failuresOf(r2)).toHaveLength(1);
    expect(failuresOf(r2)[0]).toMatch(
      /^check-pack exited 1: Error: ENOENT: no such file or directory, open '.*\/release\/pack-needs\.json'$/,
    );
    expect(dryRunLine(r2)).toBe(
      "release-dry-run: FAIL packages=0 of 2 version=0.1.0 tarballs=2 files=10 smoke=0 failures=1",
    );
  });

  it("fails when npm publish exits 0 and prints no + line", async () => {
    // An exit code alone is a claim: the + line names what npm would publish.
    const { root, tmp } = setup();
    const f = fake({
      "npm publish": (c) =>
        c.args[1]?.includes("authtempo-core-")
          ? {
              status: 0,
              stdout: "",
              stderr:
                "npm notice Publishing to http://127.0.0.1:9 with tag latest and public access (dry-run)\n",
            }
          : undefined,
    });
    const report = await dryRun({ root, run: f.run, tmp });
    expect(failuresOf(report)).toEqual([
      "@authtempo/core@0.1.0: npm publish --dry-run does not print + @authtempo/core@0.1.0",
    ]);
    expect(dryRunLine(report)).toBe(
      "release-dry-run: FAIL packages=1 of 2 version=0.1.0 tarballs=2 files=10 smoke=0 failures=1",
    );
    expect(f.calls.map((c) => c.kind)).not.toContain("pnpm publish");
  });

  it("prints each failure line of a failed step", async () => {
    // Before Task 3b of plan 12j, 22 released packages have no engines, and the
    // person needs each name, not the last line only.
    const { root, tmp } = setup((d) => {
      for (const p of ["client", "core"]) {
        const file = join(d, `packages/${p}/package.json`);
        const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        delete m.engines;
        writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
      }
    });
    const f = fake();
    const report = await dryRun({ root, run: f.run, tmp });
    expect(failuresOf(report)).toEqual([
      "prepare exited 1: prepare: FAIL packages=2 failures=2",
      "prepare: @authtempo/client: the manifest has no engines",
      "prepare: @authtempo/core: the manifest has no engines",
    ]);
    expect(dryRunLine(report)).toBe(
      "release-dry-run: FAIL packages=0 of 2 version=0.1.0 tarballs=0 files=0 smoke=0 failures=3",
    );
  });

  it("never calls publish without --dry-run, push, or tag", async () => {
    const { report, calls } = await passingRun();
    expect(report.exit).toBe(0);
    const publishes = calls.filter((c) => c.args.includes("publish"));
    expect(publishes.map((c) => c.kind)).toEqual(["npm publish", "npm publish", "pnpm publish"]);
    for (const c of publishes) expect(c.args).toContain("--dry-run");
    const git = calls.filter((c) => c.cmd === "git").map((c) => c.args[0]);
    expect(git).toEqual(["status", "archive"]);
    for (const c of calls)
      for (const word of ["push", "tag", "commit", "deprecate", "unpublish"])
        expect([c.kind, c.args.includes(word)]).toEqual([c.kind, false]);
    expect(calls.filter((c) => c.kind === "pnpm changeset").map((c) => c.args)).toEqual([
      ["changeset", "version"],
    ]);
  });

  it("never reaches a network host", async () => {
    const { report, calls } = await passingRun();
    expect(report.exit).toBe(0);
    // Each publish call names the dead address, where nothing listens. pnpm 12.8.1
    // does not read npm_config_registry (Task 6 Step 1, 2026-10-20), so the flag is the guard.
    const publishes = calls.filter((c) => c.args.includes("publish"));
    expect(publishes).toHaveLength(3);
    for (const c of publishes)
      expect([c.kind, c.args[c.args.indexOf("--registry") + 1]]).toEqual([
        c.kind,
        "http://127.0.0.1:9",
      ]);
    // A scoped name goes to the scope registry of an npmrc, not to --registry.
    expect(publishes.map((c) => c.args.filter((a) => a.includes(":registry=")))).toEqual([
      ["--@authtempo:registry=http://127.0.0.1:9"],
      ["--@authtempo:registry=http://127.0.0.1:9"],
      ["--config.@authtempo:registry=http://127.0.0.1:9"],
    ]);
    // npm reads the package document of the registry, and each retry on the dead address waits.
    expect(publishes.map((c) => c.args.filter((a) => a.includes("fetch-retries")))).toEqual([
      ["--fetch-retries=0"],
      ["--fetch-retries=0"],
      ["--config.fetch-retries=0"],
    ]);
    // Each install reads the store only.
    const installs = calls.filter((c) => c.kind === "install" || c.kind === "smoke install");
    expect(installs).toHaveLength(2);
    for (const c of installs)
      expect([c.kind, c.args.includes("--offline")]).toEqual([c.kind, true]);
    // No other call names a host.
    for (const c of calls)
      for (const a of c.args)
        if (/[a-z+]+:\/\//.test(a))
          expect([c.kind, a.replace(/^.*?([a-z+]+:\/\/)/, "$1")]).toEqual([
            c.kind,
            "http://127.0.0.1:9",
          ]);
  });

  it("runs no script at pack or publish", async () => {
    const { report, calls } = await passingRun();
    expect(report.exit).toBe(0);
    const scripted = calls.filter((c) => c.kind === "pnpm pack" || c.kind === "pnpm publish");
    expect(scripted.map((c) => [c.kind, c.args.includes("--ignore-scripts")])).toEqual([
      ["pnpm pack", true],
      ["pnpm pack", true],
      ["pnpm publish", true],
    ]);

    // A prepack script of core does not run at the real pack, and check-pack refuses it.
    const { root, tmp } = setup((d) => {
      const file = join(d, "packages/core/package.json");
      const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      m.scripts = { prepack: "node -e \"require('fs').writeFileSync('ran.txt', '')\"" };
      writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
    });
    let ran = true;
    const f = fake({
      "node check-pack.ts": (c) => {
        ran = existsSync(join(c.cwd, "packages/core/ran.txt"));
        return undefined;
      },
    });
    const scriptRun = await dryRun({ root, run: f.run, tmp });
    expect(ran).toBe(false);
    expect(failuresOf(scriptRun)).toEqual([
      "check-pack exited 1: check-pack: FAIL tarballs=2 files=10 failures=1",
      "check-pack: @authtempo/core@0.1.0: scripts.prepack runs at pack or publish",
    ]);
    expect(dryRunLine(scriptRun)).toBe(
      "release-dry-run: FAIL packages=1 of 2 version=0.1.0 tarballs=2 files=10 smoke=0 failures=2",
    );
  });

  it("runs no script at the real pnpm publish", () => {
    const repo = copyFixture((d) => {
      changesetVersion(d, "Add the first release.");
      writeFileSync(join(d, ".release-copy"), "");
    });
    made.push(repo);
    expect(prepare(repo).failures).toEqual([]);
    const scripts = ["prepublishOnly", "prepack", "prepare", "publish", "postpack", "postpublish"];
    const file = join(repo, "packages/core/package.json");
    const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    m.scripts = Object.fromEntries(
      scripts.map((s) => [s, `node -e "require('fs').writeFileSync('ran-${s}.txt', '')"`]),
    );
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
    const temp = mkdtempSync(join(tmpdir(), "authtempo-scripts-test-"));
    made.push(temp);
    const { files, paths } = childFiles(temp);
    const r = spawnRun("pnpm", PNPM_PUBLISH_ARGS, repo, childEnv(process.env, files, paths));
    expect([r.status, r.stdout.includes("📦 @authtempo/core@0.1.0 → http://127.0.0.1:9/")]).toEqual(
      [0, true],
    );
    expect(readdirSync(join(repo, "packages/core")).filter((f) => f.startsWith("ran-"))).toEqual(
      [],
    );
  });

  it("gives each child the keys of the allowlist only", async () => {
    // The env of a person on the day before a release: a token, a scope
    // registry, and a user npmrc (review of Task 6, M1).
    const parent = {
      PATH: "/bin",
      HOME: "/home/person",
      TMPDIR: "/tmp/person",
      LANG: "en_US.UTF-8",
      NPM_TOKEN: "FAKE-TEST-TOKEN",
      NODE_AUTH_TOKEN: "FAKE-TEST-TOKEN",
      NODE_OPTIONS: "--require /home/person/hook.cjs",
      NPM_CONFIG_USERCONFIG: "/home/person/.npmrc",
      npm_config_registry: "http://127.0.0.1:1/",
      "npm_config_@authtempo:registry": "http://127.0.0.1:1/",
      TURBO_TOKEN: "FAKE-TEST-TOKEN",
      TURBO_TEAM: "person",
      TURBO_API: "http://127.0.0.1:1",
    };
    const { report, calls } = await passingRun(parent);
    expect(report.exit).toBe(0);
    const dir = report.dir ?? "";
    expect(calls).toHaveLength(18);
    const fixed = {
      PATH: "/bin",
      TMPDIR: "/tmp/person",
      LANG: "en_US.UTF-8",
      CI: "1",
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_HIDE_BANNER: "true",
      TURBO_TELEMETRY_DISABLED: "1",
      NPM_CONFIG_USERCONFIG: `${dir}/npmrc-user`,
      NPM_CONFIG_GLOBALCONFIG: `${dir}/npmrc-global`,
    };
    // Only the three path reads get the HOME of the person.
    for (const c of calls.slice(0, 3))
      expect([c.kind, c.env]).toEqual([c.kind, { ...fixed, HOME: "/home/person" }]);
    for (const c of calls.slice(3))
      expect([c.kind, c.env]).toEqual([
        c.kind,
        {
          ...fixed,
          HOME: `${dir}/home`,
          pnpm_config_store_dir: "/home/person/Library/pnpm/store/v11",
          pnpm_config_cache_dir: "/home/person/Library/Caches/pnpm",
          npm_config_cache: "/home/person/.npm",
        },
      ]);
    // A key that the parent lacks stays out of the child.
    const bare = await passingRun({ PATH: "/bin", NPM_TOKEN: "FAKE-TEST-TOKEN" });
    const keys = [
      "CI",
      "NO_COLOR",
      "NPM_CONFIG_GLOBALCONFIG",
      "NPM_CONFIG_USERCONFIG",
      "PATH",
      "TURBO_TELEMETRY_DISABLED",
      "WRANGLER_HIDE_BANNER",
      "WRANGLER_SEND_METRICS",
    ];
    for (const c of bare.calls.slice(0, 3))
      expect([c.kind, Object.keys(c.env).sort()]).toEqual([c.kind, keys]);
    for (const c of bare.calls.slice(3))
      expect([c.kind, Object.keys(c.env).sort()]).toEqual([
        c.kind,
        [
          ...keys,
          "HOME",
          "npm_config_cache",
          "pnpm_config_cache_dir",
          "pnpm_config_store_dir",
        ].sort(),
      ]);
  });

  it("writes the two npmrc files empty before the first call", async () => {
    const { root, tmp } = setup();
    const seen: string[] = [];
    const f = fake();
    const run: Run = (cmd, args, cwd, env) => {
      for (const key of ["NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG"])
        seen.push(`${key}=${JSON.stringify(readFileSync(env[key] ?? "", "utf8"))}`);
      return f.run(cmd, args, cwd, env);
    };
    const report = await dryRun({ root, run, tmp });
    expect(report.exit).toBe(0);
    expect(new Set(seen)).toEqual(
      new Set(['NPM_CONFIG_USERCONFIG=""', 'NPM_CONFIG_GLOBALCONFIG=""']),
    );
  });

  it("gives each child an empty HOME in the temp folder", async () => {
    // The HOME of the person holds the pnpm config.yaml and the turbo and
    // Vercel tokens (review of the Task 6 fix, M1).
    const { root, tmp } = setup();
    const f = fake();
    const homes: string[] = [];
    const run: Run = (cmd, args, cwd, env) => {
      const home = env.HOME ?? "";
      homes.push(
        `${kindOf(cmd, args, cwd)} ${existsSync(home) ? readdirSync(home).length : "none"}`,
      );
      return f.run(cmd, args, cwd, env);
    };
    const report = await dryRun({ root, run, tmp, env: { PATH: "/bin", HOME: root } });
    expect(report.exit).toBe(0);
    const dir = report.dir ?? "";
    const kinds = f.calls.map((c) => c.kind);
    expect(f.calls.map((c) => c.env.HOME)).toEqual(
      kinds.map((k) => (READS.includes(k) ? root : `${dir}/home`)),
    );
    // Each path read runs in the empty folder, so no project config of the checkout applies.
    expect(f.calls.slice(0, 3).map((c) => c.cwd)).toEqual([
      `${dir}/home`,
      `${dir}/home`,
      `${dir}/home`,
    ]);
    expect(homes.slice(3).filter((h) => !h.endsWith(" 0"))).toEqual([]);
  });

  it("fails when a tool path read fails", async () => {
    const { root, tmp } = setup();
    const f = fake({
      "pnpm store": () => ({ status: 1, stdout: "", stderr: "ERR_PNPM_SOMETHING\n" }),
      "npm config": () => ok("undefined\n"),
    });
    const report = await dryRun({ root, run: f.run, tmp });
    expect(report.exit).toBe(1);
    expect(failuresOf(report)).toEqual([
      "pnpm store path exited 1: ERR_PNPM_SOMETHING",
      "npm config get cache printed no one absolute path: undefined",
    ]);
    expect(f.calls.map((c) => c.kind)).toEqual(READS);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("fails when a publish line names another registry than the dead one", async () => {
    const { root, tmp } = setup();
    const f = fake({
      "npm publish": (c) =>
        c.args[1]?.includes("authtempo-core-")
          ? {
              status: 0,
              stdout: "+ @authtempo/core@0.1.0\n",
              stderr:
                "npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access (dry-run)\n",
            }
          : undefined,
    });
    const report = await dryRun({ root, run: f.run, tmp });
    expect(failuresOf(report)).toEqual([
      "@authtempo/core@0.1.0: npm publish --dry-run names the registry https://registry.npmjs.org/, not http://127.0.0.1:9",
    ]);
    expect(dryRunLine(report)).toBe(
      "release-dry-run: FAIL packages=1 of 2 version=0.1.0 tarballs=2 files=10 smoke=0 failures=1",
    );

    // An npm answer that names no registry is not proof of the dead one.
    const silent = setup();
    const quiet = fake({
      "npm publish": (c) =>
        c.args[1]?.includes("authtempo-client-") ? ok("+ @authtempo/client@0.1.0\n") : undefined,
    });
    const r2 = await dryRun({ root: silent.root, run: quiet.run, tmp: silent.tmp });
    expect(failuresOf(r2)).toEqual([
      "@authtempo/client@0.1.0: npm publish --dry-run names no registry",
    ]);

    const other = setup();
    const g = fake({
      "pnpm publish": (c) =>
        ok(
          pnpmPublishLines(c.cwd)
            .map((l) => l.replace("http://127.0.0.1:9/", "https://registry.npmjs.org/"))
            .join("\n"),
        ),
    });
    const r3 = await dryRun({ root: other.root, run: g.run, tmp: other.tmp });
    expect(failuresOf(r3)).toEqual([
      "pnpm publish -r --dry-run names the registry https://registry.npmjs.org/ for @authtempo/client@0.1.0, not http://127.0.0.1:9",
      "pnpm publish -r --dry-run names the registry https://registry.npmjs.org/ for @authtempo/core@0.1.0, not http://127.0.0.1:9",
    ]);
    expect(dryRunLine(r3)).toBe(
      "release-dry-run: FAIL packages=0 of 2 version=0.1.0 tarballs=2 files=10 smoke=0 failures=2",
    );
    expect(g.calls.map((c) => c.kind)).not.toContain("smoke");
  });

  it("writes only under the temp folder", async () => {
    const { root, tmp, before, report, calls } = await passingRun();
    expect(report.exit).toBe(0);
    const dir = report.dir ?? "";
    expect(dir.startsWith(`${tmp}/authtempo-release-`)).toBe(true);
    const inside = (p: string) => p === dir || p.startsWith(`${dir}/`);
    const archive = calls.findIndex((c) => c.kind === "git archive");
    for (const c of calls.slice(archive + 1))
      expect([c.kind, inside(c.cwd)]).toEqual([c.kind, true]);
    for (const c of calls.slice(archive))
      for (const flag of ["-o", "-C", "--pack-destination"])
        if (c.args.includes(flag))
          expect([c.kind, inside(c.args[c.args.indexOf(flag) + 1] ?? "")]).toEqual([c.kind, true]);
    // The checkout is unchanged, and the temp folder is gone without --keep.
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(dir)).toBe(false);
  });
});

/**
 * A loopback listener on a free port in its own process, because each publish
 * call blocks this process. It writes one line for each request to `log`.
 */
async function listen(log: string): Promise<{ url: string; stop: () => void }> {
  const code = `
    const { createServer } = require("node:http");
    const { appendFileSync } = require("node:fs");
    const server = createServer((req, res) => {
      appendFileSync(${JSON.stringify(log)}, req.method + " " + req.url + " " + (req.headers.authorization ?? "none") + "\\n");
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => console.log(server.address().port));
  `;
  writeFileSync(log, "");
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((ok, fail) => {
    child.stdout.once("data", (d: Buffer) => ok(d.toString().trim()));
    child.once("exit", (status) => fail(new Error(`the listener exited ${status}`)));
  });
  return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}

describe("dry run against a scope registry", () => {
  it("sends no request to the scope registry of the env or of an npmrc", async () => {
    // Each released name is @authtempo/*. npm and pnpm send a scoped name to
    // the scope registry of an npmrc, not to --registry (review of Task 6, M1).
    const temp = mkdtempSync(join(tmpdir(), "authtempo-scope-test-"));
    made.push(temp);
    const log = join(temp, "requests.log");
    const listener = await listen(log);
    try {
      const host = listener.url.slice("http:".length, -1);
      const npmrc = `@authtempo:registry=${listener.url}\n${host}/:_authToken=FAKE-TEST-TOKEN\n`;
      const home = join(temp, "home");
      mkdirSync(home);
      writeFileSync(join(home, ".npmrc"), npmrc);
      writeFileSync(join(temp, "user.npmrc"), npmrc);
      const parent: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        NPM_CONFIG_USERCONFIG: join(temp, "user.npmrc"),
        "npm_config_@authtempo:registry": listener.url,
        NPM_TOKEN: "FAKE-TEST-TOKEN",
        NODE_AUTH_TOKEN: "FAKE-TEST-TOKEN",
      };

      // A release copy after prepare, and its tarballs.
      const repo = copyFixture((d) => {
        changesetVersion(d, "Add the first release.");
        writeFileSync(join(d, ".release-copy"), "");
      });
      made.push(repo);
      expect(prepare(repo).failures).toEqual([]);
      const out = join(temp, "out");
      mkdirSync(out);
      execFileSync("pnpm", ["--filter", "@authtempo/core", "pack", "--pack-destination", out], {
        cwd: repo,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: "pipe",
      });
      const [tarball = ""] = readdirSync(out);
      const { files, paths } = childFiles(join(temp, "child"));

      // Each guard holds alone: the env without the scope arguments, and the
      // scope arguments with the env of the parent.
      const cases: [label: string, env: ChildEnv, scope: boolean][] = [
        ["both", childEnv(parent, files, paths), true],
        ["env alone", childEnv(parent, files, paths), false],
        ["arguments alone", parent as ChildEnv, true],
      ];
      const drop = (args: readonly string[], scope: boolean) =>
        args.filter((a) => scope || (a !== NPM_SCOPE_REGISTRY && a !== PNPM_SCOPE_REGISTRY));
      for (const [label, env, scope] of cases) {
        const npm = spawnRun("npm", drop(npmPublishArgs(join(out, tarball)), scope), out, env);
        const pnpm = spawnRun("pnpm", drop(PNPM_PUBLISH_ARGS, scope), repo, env);
        const lines = (r: RunResult) => `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim());
        // npm names the --registry value with a slash and the scope value without one.
        const said = [
          ...lines(npm)
            .filter((l) => l.includes("Publishing to"))
            .map((l) => l.replace("127.0.0.1:9/ ", "127.0.0.1:9 ")),
          ...lines(pnpm)
            .filter((l) => l.includes(" → "))
            .sort(),
        ];
        expect([label, npm.status, pnpm.status, said, readFileSync(log, "utf8")]).toEqual([
          label,
          0,
          0,
          [
            "npm notice Publishing to http://127.0.0.1:9 with tag latest and public access (dry-run)",
            "📦 @authtempo/client@0.1.0 → http://127.0.0.1:9/",
            "📦 @authtempo/core@0.1.0 → http://127.0.0.1:9/",
          ],
          "",
        ]);
      }
    } finally {
      listener.stop();
    }
  });
});

describe("dry run against a remote cache", () => {
  it("sends no request to the remote cache of a committed turbo.json", async () => {
    // turbo 2.11.7 reads the token of turbo login and of the Vercel CLI from
    // HOME. With remoteCache in turbo.json, it sends the token and each build
    // output to that host (review of the Task 6 fix, M1).
    const temp = mkdtempSync(join(tmpdir(), "authtempo-cache-test-"));
    made.push(temp);
    const log = join(temp, "requests.log");
    const listener = await listen(log);
    try {
      const home = join(temp, "person");
      for (const file of [
        "Library/Application Support/turborepo/config.json",
        "Library/Application Support/com.vercel.cli/auth.json",
      ]) {
        mkdirSync(join(home, file, ".."), { recursive: true });
        writeFileSync(join(home, file), '{"token":"FAKE-TEST-TOKEN"}\n');
      }
      const root = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8")) as {
        packageManager: string;
      };
      const repo = copyFixture((d) => {
        const remoteCache = { apiUrl: listener.url.slice(0, -1), teamId: "team_test" };
        const turbo = { tasks: { build: { outputs: [] } }, remoteCache };
        writeFileSync(join(d, "turbo.json"), `${JSON.stringify(turbo, null, 2)}\n`);
        // turbo reads the workspace of the packageManager of the root manifest.
        for (const [file, key, value] of [
          ["package.json", "packageManager", root.packageManager],
          ["packages/core/package.json", "scripts", { build: "node -e 0" }],
          ["packages/client/package.json", "scripts", { build: "node -e 0" }],
        ] as const) {
          const m = JSON.parse(readFileSync(join(d, file), "utf8")) as Record<string, unknown>;
          m[key] = value;
          writeFileSync(join(d, file), `${JSON.stringify(m, null, 2)}\n`);
        }
      });
      made.push(repo);
      const { files, paths } = childFiles(join(temp, "child"));
      const env = childEnv({ ...process.env, HOME: home }, files, paths);
      const turbo = fileURLToPath(new URL("node_modules/.bin/turbo", repoRoot));
      const [pnpm, sub, ...args] = buildCommand(["@authtempo/client", "@authtempo/core"]);
      expect([pnpm, sub]).toEqual(["pnpm", "turbo"]);
      // Each guard holds alone: the empty HOME with the --force of the old
      // command, and the cache flag with the HOME of the person.
      const forced = args.map((a) => (a.startsWith("--cache=") ? "--force" : a));
      const cases: [label: string, env: ChildEnv, args: readonly string[]][] = [
        ["both", env, args],
        ["empty HOME alone", env, forced],
        ["cache flag alone", { ...env, HOME: home }, args],
      ];
      for (const [label, e, a] of cases) {
        const r = spawnRun(turbo, a, repo, e);
        expect([
          label,
          r.status,
          /Tasks:\s+2 successful, 2 total/.test(r.stdout),
          readFileSync(log, "utf8"),
        ]).toEqual([label, 0, true, ""]);
      }
    } finally {
      listener.stop();
    }
  });
});
