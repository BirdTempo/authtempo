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
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTarballs, readTarball } from "../src/check-pack.ts";
import { readYaml, type YamlNode } from "../src/check-workflows.ts";
import {
  type ChildEnv,
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
} from "../src/dry-run.ts";
import { reportLines } from "../src/lib/report.ts";
import { prepare } from "../src/prepare.ts";
import { changesetVersion, copyFixture } from "./support/release-copy.ts";

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
        return {
          status: 0,
          stdout: `+ ${t.manifest.name}@${t.manifest.version}\n`,
          stderr:
            "npm notice Publishing to http://127.0.0.1:9 with tag latest and public access (dry-run)\n",
        };
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
      `pnpm turbo run build --force $(jq -r '"--filter=" + .fixed[0][]' .changeset/config.json)`,
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
    expect(calls).toHaveLength(15);
    for (const c of calls)
      expect([c.kind, c.env]).toEqual([
        c.kind,
        {
          PATH: "/bin",
          HOME: "/home/person",
          TMPDIR: "/tmp/person",
          LANG: "en_US.UTF-8",
          CI: "1",
          NO_COLOR: "1",
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_HIDE_BANNER: "true",
          TURBO_TELEMETRY_DISABLED: "1",
          NPM_CONFIG_USERCONFIG: `${dir}/npmrc-user`,
          NPM_CONFIG_GLOBALCONFIG: `${dir}/npmrc-global`,
        },
      ]);
    // A key that the parent lacks stays out of the child.
    const bare = await passingRun({ PATH: "/bin", NPM_TOKEN: "FAKE-TEST-TOKEN" });
    for (const c of bare.calls)
      expect([c.kind, Object.keys(c.env).sort()]).toEqual([
        c.kind,
        [
          "CI",
          "NO_COLOR",
          "NPM_CONFIG_GLOBALCONFIG",
          "NPM_CONFIG_USERCONFIG",
          "PATH",
          "TURBO_TELEMETRY_DISABLED",
          "WRANGLER_HIDE_BANNER",
          "WRANGLER_SEND_METRICS",
        ],
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
      const configs = { user: join(temp, "npmrc-user"), global: join(temp, "npmrc-global") };
      writeFileSync(configs.user, "");
      writeFileSync(configs.global, "");

      // Each guard holds alone: the env without the scope arguments, and the
      // scope arguments with the env of the parent.
      const cases: [label: string, env: ChildEnv, scope: boolean][] = [
        ["both", childEnv(parent, configs), true],
        ["env alone", childEnv(parent, configs), false],
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
