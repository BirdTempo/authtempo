import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTarball } from "./check-pack.ts";
import {
  COPY_BUILD,
  COPY_CHECK_PACK,
  COPY_INSTALL,
  COPY_PREPARE,
  packCommand,
  RELEASE_COPY_MARKER,
} from "./lib/release-copy.ts";
import { releasedNames } from "./lib/released.ts";
import type { Report } from "./lib/report.ts";
import { readWorkspace } from "./lib/workspace.ts";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** The seam of each child process of the dry run. The test replaces it. */
export type Run = (cmd: string, args: string[], cwd: string) => RunResult;

/**
 * The registry of each publish call: an address where nothing listens. A
 * publish call that lost --dry-run cannot reach a registry. Task 6 Step 1 read
 * on 2026-10-20 that npm 11.19.1 and pnpm 12.8.1 run the dry run with it and no
 * network error. pnpm 12.8.1 does not read npm_config_registry, so it is a flag.
 */
export const DEAD_REGISTRY = "http://127.0.0.1:9";

/** The body of the one temporary changeset. */
export const CHANGESET_BODY = "Dry run of the next release.";

export interface DryRunOptions {
  /** The checkout. The dry run reads it with git and never writes to it. */
  root: string;
  run?: Run;
  /** The parent of the temp folder. The default is the system temp folder. */
  tmp?: string;
  /** Keep the temp folder after the run. */
  keep?: boolean;
  /** Gets one line as each step starts. */
  log?: (line: string) => void;
}

export interface DryRunReport extends Report {
  /** 0 PASS, 1 FAIL, 2 a dirty checkout. */
  exit: 0 | 1 | 2;
  /** The group version after changeset version, or null before it. */
  version: string | null;
  /** The temp folder, or null when the run stopped before it. */
  dir: string | null;
  /** One line per tarball: `<name>@<version> <sha256> files=<n>`. */
  lines: string[];
}

/**
 * The summary line of the dry run. `packages` counts each released package that
 * passed each step that ran, so a PASS line has `<n> of <n>`.
 */
export function dryRunLine(r: DryRunReport): string {
  const c = r.counts;
  const verdict = r.failures.length === 0 ? "PASS" : "FAIL";
  return `release-dry-run: ${verdict} packages=${c.packages ?? 0} of ${c.released ?? 0} version=${r.version ?? "none"} tarballs=${c.tarballs ?? 0} files=${c.files ?? 0} smoke=${c.smoke ?? 0} failures=${r.failures.length}`;
}

/** The env of each child process. The four wrangler keys hold a build that spawns wrangler (ruling 40 of plan 11e). */
const CHILD_ENV = {
  CI: "1",
  NO_COLOR: "1",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_HIDE_BANNER: "true",
  TURBO_TELEMETRY_DISABLED: "1",
};

const spawnRun: Run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...CHILD_ENV },
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: `${r.stderr ?? ""}${r.error ? String(r.error) : ""}`,
  };
};

const nonEmpty = (text: string) => text.split("\n").filter((l) => l.trim() !== "");
const firstLine = (r: RunResult) =>
  (nonEmpty(r.stderr)[0] ?? nonEmpty(r.stdout).at(-1) ?? "no output").trim();

/**
 * The summary line and the failure lines of a release check that printed its
 * report: "<name>: PASS|FAIL ..." and each line after it that starts with two
 * spaces, except a note. A step with no summary line gives null.
 */
function reportOf(stdout: string): { summary: string; failures: string[] } | null {
  const all = nonEmpty(stdout);
  const at = all.findIndex((l) => /^\S+: (PASS|FAIL) /.test(l));
  if (at < 0) return null;
  const failures = all
    .slice(at + 1)
    .filter((l) => l.startsWith("  ") && !l.trim().startsWith("note:"))
    .map((l) => l.trim());
  return { summary: all[at] ?? "", failures };
}

/**
 * The dry run of spec 33 item 4.1, in a copy of `git archive HEAD` under a new
 * temp folder. It stops at the first step that fails. It never commits, tags,
 * pushes, or publishes, and it leaves the checkout unchanged.
 */
export async function dryRun(options: DryRunOptions): Promise<DryRunReport> {
  const run = options.run ?? spawnRun;
  const log = options.log ?? (() => {});
  const counts = { packages: 0, released: 0, tarballs: 0, files: 0, smoke: 0 };
  const failures: string[] = [];
  const lines: string[] = [];
  let version: string | null = null;
  let dir: string | null = null;
  const done = (exit: 0 | 1 | 2): DryRunReport => ({
    name: "release-dry-run",
    counts,
    failures,
    notes: [],
    exit: failures.length === 0 ? exit : exit === 0 ? 1 : exit,
    version,
    dir,
    lines,
  });
  /** Runs one step. A step that exits other than 0 adds a failure and gives null. */
  const step = (label: string, cmd: string, args: string[], cwd: string): RunResult | null => {
    log(`dry-run: ${label}`);
    const r = run(cmd, args, cwd);
    if (r.status === 0) return r;
    const report = reportOf(r.stdout);
    failures.push(`${label} exited ${r.status}: ${report?.summary ?? firstLine(r)}`);
    for (const line of report?.failures ?? []) failures.push(`${label}: ${line}`);
    return null;
  };

  // git archive HEAD holds no change of the working tree, so a dirty checkout
  // would pack another tree than the one that the person sees.
  log("dry-run: git status --porcelain");
  const status = run("git", ["status", "--porcelain"], options.root);
  if (status.status !== 0) {
    failures.push(`git status --porcelain exited ${status.status}: ${firstLine(status)}`);
    return done(2);
  }
  const dirty = nonEmpty(status.stdout).map((l) => l.trim());
  if (dirty.length > 0) {
    failures.push(
      `the checkout has changes that git archive HEAD does not hold: ${dirty.join(", ")}`,
    );
    return done(2);
  }

  dir = mkdtempSync(join(options.tmp ?? tmpdir(), "authtempo-release-"));
  try {
    return done(steps(dir));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return done(1);
  } finally {
    if (options.keep !== true) rmSync(dir, { recursive: true, force: true });
  }

  /** The steps in the temp folder: the copy in repo/, the tarballs in out/, the smoke app in smoke/. */
  function steps(temp: string): 0 | 1 {
    const repo = join(temp, "repo");
    const out = join(temp, "out");
    const smoke = join(temp, "smoke");
    mkdirSync(repo);
    mkdirSync(out);
    const archive = join(temp, "head.tar");
    if (
      !step(
        "git archive HEAD",
        "git",
        ["archive", "--format=tar", "-o", archive, "HEAD"],
        options.root,
      )
    )
      return 1;
    if (!step("tar -x", "tar", ["-xf", archive, "-C", repo], temp)) return 1;
    rmSync(archive);
    writeFileSync(
      join(repo, RELEASE_COPY_MARKER),
      "A release copy of the dry run. prepare runs only here.\n",
    );

    const names = releasedNames(repo).sort();
    counts.released = names.length;
    if (names.length === 0) {
      failures.push("read 0 packages");
      return 1;
    }
    const folders = new Map(readWorkspace(repo).map((p) => [p.name, p.dir]));
    for (const name of names) if (!folders.has(name)) failures.push(`${name}: no workspace folder`);
    if (failures.length > 0) return 1;

    // The commands of src/lib/release-copy.ts, which the job check of release.yml also runs.
    const copyStep = (label: string, command: readonly string[]) =>
      step(label, command[0] ?? "", command.slice(1), repo);
    if (!copyStep("pnpm install", COPY_INSTALL)) return 1;
    writeFileSync(
      join(repo, ".changeset/dry-run.md"),
      `---\n${names.map((n) => `"${n}": minor`).join("\n")}\n---\n\n${CHANGESET_BODY}\n`,
    );
    if (!step("changeset version", "pnpm", ["changeset", "version"], repo)) return 1;
    const versions = [
      ...new Set(
        readWorkspace(repo)
          .filter((p) => names.includes(p.name))
          .map((p) => p.manifest.version),
      ),
    ];
    if (versions.length !== 1) {
      failures.push(
        `the released packages hold ${versions.length} versions: ${versions.join(", ")}`,
      );
      return 1;
    }
    version = versions[0] ?? null;
    if (!copyStep("prepare", COPY_PREPARE)) return 1;
    if (!copyStep("turbo run build", COPY_BUILD)) return 1;

    const tarballs: { name: string; path: string }[] = [];
    for (const name of names) {
      const r = copyStep(`pnpm pack ${name}`, packCommand(name, out));
      if (r === null) continue;
      const path = resolve(nonEmpty(r.stdout).at(-1)?.trim() ?? "");
      if (!path.endsWith(".tgz") || !path.startsWith(`${out}/`) || !existsSync(path))
        failures.push(`pnpm pack ${name} names no tarball in ${out}`);
      else tarballs.push({ name, path });
    }
    counts.tarballs = tarballs.length;
    if (failures.length > 0) return 1;
    const tag = new Map<string, string>();
    for (const t of tarballs) {
      const read = readTarball(t.path);
      if (read.manifest.name !== t.name)
        failures.push(`${t.path} holds ${read.manifest.name}, not ${t.name}`);
      const sha = createHash("sha256").update(readFileSync(t.path)).digest("hex");
      lines.push(
        `${read.manifest.name}@${read.manifest.version} ${sha} files=${read.files.length}`,
      );
      counts.files += read.files.length;
      tag.set(t.name, `${read.manifest.name}@${read.manifest.version}`);
    }
    if (failures.length > 0) return 1;

    const bad = new Set<string>();
    const settle = () => {
      counts.packages = tarballs.filter((t) => !bad.has(t.name)).length;
      return failures.length === 0 ? 0 : 1;
    };
    log("dry-run: check-pack");
    const [node = "", ...checkArgs] = COPY_CHECK_PACK;
    const check = run(node, [...checkArgs, ...tarballs.map((t) => t.path)], repo);
    const checked = reportOf(check.stdout);
    if (check.status !== 0 || !checked?.summary.startsWith("check-pack: PASS")) {
      failures.push(`check-pack exited ${check.status}: ${checked?.summary ?? firstLine(check)}`);
      for (const l of checked?.failures ?? []) {
        failures.push(`check-pack: ${l}`);
        for (const t of tarballs) if (l.startsWith(`${tag.get(t.name)}:`)) bad.add(t.name);
      }
      // A failure that names no package, such as a group of two versions, holds back each package.
      if (bad.size === 0) for (const t of tarballs) bad.add(t.name);
      return settle();
    }

    for (const t of tarballs) {
      const id = tag.get(t.name) ?? t.name;
      log(`dry-run: npm publish --dry-run ${id}`);
      const args = [
        "publish",
        t.path,
        "--dry-run",
        "--access",
        "public",
        "--tag",
        "latest",
        "--registry",
        DEAD_REGISTRY,
        // npm 11.19.1 reads the package document before a dry run of a version
        // above 0.0.0. Each retry on the dead address waits, 70 s for each
        // tarball with the default retries (read 2026-10-20). One try fails at once.
        "--fetch-retries=0",
      ];
      const r = run("npm", args, out);
      if (r.status !== 0)
        failures.push(`${id}: npm publish --dry-run exited ${r.status}: ${firstLine(r)}`);
      else if (!`${r.stdout}\n${r.stderr}`.includes(`+ ${id}`))
        failures.push(`${id}: npm publish --dry-run does not print + ${id}`);
      else continue;
      bad.add(t.name);
    }
    if (failures.length > 0) return settle();

    const listed = step(
      "pnpm publish -r --dry-run",
      "pnpm",
      [
        "publish",
        "-r",
        "--dry-run",
        "--no-git-checks",
        "--access",
        "public",
        "--registry",
        DEAD_REGISTRY,
      ],
      repo,
    );
    if (listed === null) {
      for (const t of tarballs) bad.add(t.name);
      return settle();
    }
    // pnpm 12.8.1 prints "📦 <name>@<version> → <registry>" for each package (Task 6 Step 1).
    const seen = new Set(
      nonEmpty(listed.stdout).flatMap((l) => {
        const m = /^📦 (\S+@[^@\s]+) → /.exec(l.trim());
        return m?.[1] === undefined ? [] : [m[1]];
      }),
    );
    for (const t of tarballs) {
      const id = tag.get(t.name) ?? t.name;
      if (!seen.has(id)) {
        failures.push(`pnpm publish -r --dry-run does not list ${id}`);
        bad.add(t.name);
      }
    }
    const ids = new Set(tag.values());
    for (const id of [...seen].sort())
      if (!ids.has(id))
        failures.push(`pnpm publish -r --dry-run lists ${id}, which has no tarball`);
    if (failures.length > 0) return settle();

    // The smoke app is outside the workspace of the copy, as an app is. Each
    // @authtempo name resolves to its tarball through an override, because the
    // exact versions are on no registry yet (the form of Task 5).
    cpSync(join(repo, "release/smoke"), smoke, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(smoke, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const deps = Object.fromEntries(tarballs.map((t) => [t.name, `file:${t.path}`]));
    manifest.dependencies = deps;
    writeFileSync(join(smoke, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(smoke, "pnpm-workspace.yaml"),
      `overrides:\n${Object.entries(deps)
        .map(([k, v]) => `  "${k}": "${v}"`)
        .join("\n")}\n`,
    );
    if (!step("smoke install", "pnpm", ["install", "--offline"], smoke)) {
      for (const t of tarballs) bad.add(t.name);
      return settle();
    }
    log("dry-run: node smoke.mjs");
    const s = run("node", ["smoke.mjs", join(repo, ".changeset/config.json")], smoke);
    const smoked = reportOf(s.stdout);
    if (s.status !== 0 || smoked === null || !smoked.summary.startsWith("smoke: PASS")) {
      failures.push(`node smoke.mjs exited ${s.status}: ${smoked?.summary ?? firstLine(s)}`);
      for (const l of smoked?.failures ?? []) failures.push(`smoke: ${l}`);
      for (const t of tarballs) bad.add(t.name);
      return settle();
    }
    lines.push(smoked.summary);
    counts.smoke = 1;
    return settle();
  }
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const keep = process.argv.includes("--keep");
  const report = await dryRun({ root, keep, log: (line) => console.error(line) });
  for (const line of report.lines) console.log(line);
  console.log(dryRunLine(report));
  for (const failure of report.failures) console.log(`  ${failure}`);
  if (keep && report.dir !== null) console.log(`  note: the temp folder stays at ${report.dir}`);
  process.exit(report.exit);
}
