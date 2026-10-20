import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTarballs, readTarball } from "../src/check-pack.ts";
import { readYaml, type YamlNode } from "../src/check-workflows.ts";
import { type DryRunReport, dryRun, dryRunLine, type Run, type RunResult } from "../src/dry-run.ts";
import { reportLines } from "../src/lib/report.ts";
import { prepare } from "../src/prepare.ts";
import { changesetVersion, copyFixture } from "./support/release-copy.ts";

interface Call {
  kind: string;
  cmd: string;
  args: string[];
  cwd: string;
}

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const fromReport = (lines: string[], failed: boolean): RunResult => ({
  status: failed ? 1 : 0,
  stdout: `${lines.join("\n")}\n`,
  stderr: "",
});

/** The step of one child process call, by its command and its first arguments. */
function kindOf(cmd: string, args: string[], cwd: string): string {
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
  const run: Run = (cmd, args, cwd) => {
    const call = { kind: kindOf(cmd, args, cwd), cmd, args: [...args], cwd };
    calls.push(call);
    const changed = change[call.kind]?.(call);
    if (changed !== undefined) return changed;
    switch (call.kind) {
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
        const r = checkTarballs(cwd, args.slice(1));
        return fromReport(reportLines(r), r.failures.length > 0);
      }
      case "npm publish": {
        const t = readTarball(args[1] ?? "");
        return ok(`+ ${t.manifest.name}@${t.manifest.version}\n`);
      }
      case "pnpm publish":
        return ok(pnpmPublishLines(cwd).join("\n"));
      case "smoke":
        return ok("smoke: PASS packages=2 released=2 entries=2 exempt=0 cli=0 failures=0\n");
      default:
        return ok();
    }
  };
  return { run, calls, changesets };
}

/** What pnpm publish -r --dry-run prints for each packed tarball of the copy at `repo`. */
function pnpmPublishLines(repo: string, skip = ""): string[] {
  const out = join(dirname(repo), "out");
  return readdirSync(out)
    .sort()
    .map((f) => readTarball(join(out, f)).manifest)
    .filter((m) => m.name !== skip)
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

async function passingRun() {
  const { root, tmp } = setup();
  const before = snapshot(root);
  const f = fake();
  const report = await dryRun({ root, run: f.run, tmp });
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
    expect(f.calls.map((c) => c.kind)).toEqual(["git status"]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("runs the steps in order", async () => {
    const { report, calls, changesets } = await passingRun();
    expect(calls.map((c) => c.kind)).toEqual([
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
        return `${c.cmd} ${c.args.join(" ")}`;
      });
    expect(lines).toEqual(releaseCopyLines());
    expect(releaseCopyLines()).toEqual([
      "pnpm install --frozen-lockfile --offline",
      "node scripts/release/src/prepare.ts",
      "pnpm turbo run build --force",
      'pnpm --filter "$name" pack --pack-destination "$PWD/out"',
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
    for (const c of publishes) {
      expect(c.args).toContain("--dry-run");
      // A dead address: no publish call can reach a registry, also with no --dry-run.
      expect(c.args[c.args.indexOf("--registry") + 1]).toBe("http://127.0.0.1:9");
    }
    // npm reads the package document of the registry, and each retry on the dead address waits.
    for (const c of publishes.filter((p) => p.cmd === "npm"))
      expect(c.args).toContain("--fetch-retries=0");
    const git = calls.filter((c) => c.cmd === "git").map((c) => c.args[0]);
    expect(git).toEqual(["status", "archive"]);
    for (const c of calls)
      for (const word of ["push", "tag", "commit", "deprecate", "unpublish"])
        expect([c.kind, c.args.includes(word)]).toEqual([c.kind, false]);
    expect(calls.filter((c) => c.kind === "pnpm changeset").map((c) => c.args)).toEqual([
      ["changeset", "version"],
    ]);
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
