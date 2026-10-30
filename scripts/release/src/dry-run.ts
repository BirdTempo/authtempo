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
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTarball } from "./check-pack.ts";
import {
  buildCommand,
  COPY_CHECK_PACK,
  COPY_INSTALL,
  COPY_PREPARE,
  packCommand,
  RELEASE_COPY_MARKER,
} from "./lib/release-copy.ts";
import { SCOPE } from "./lib/release-facts.ts";
import { releasedNames } from "./lib/released.ts";
import type { Report } from "./lib/report.ts";
import { readWorkspace } from "./lib/workspace.ts";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** The env of one child process: the keys of childEnv only. */
export type ChildEnv = Record<string, string>;

/** The seam of each child process of the dry run. The test replaces it. */
export type Run = (cmd: string, args: readonly string[], cwd: string, env: ChildEnv) => RunResult;

/**
 * The registry of each publish call: an address where nothing listens. Task 6
 * Step 1 read on 2026-10-20 that npm 11.19.1 and pnpm 12.8.1 run the dry run
 * with it and no network error. pnpm 12.8.1 does not read npm_config_registry,
 * so it is a flag.
 */
export const DEAD_REGISTRY = "http://127.0.0.1:9";

/** The scope registry argument of npm 11.19.1. */
export const NPM_SCOPE_REGISTRY = `--${SCOPE}:registry=${DEAD_REGISTRY}`;

/**
 * The scope registry argument of pnpm 12.8.1. It refuses the npm form with
 * exit 2, and it reads this form as a config key (read 2026-10-21).
 */
export const PNPM_SCOPE_REGISTRY = `--config.${SCOPE}:registry=${DEAD_REGISTRY}`;

/** The arguments of npm publish --dry-run for one tarball. */
export const npmPublishArgs = (tarball: string): readonly string[] => [
  "publish",
  tarball,
  "--dry-run",
  "--access",
  "public",
  "--tag",
  "latest",
  "--registry",
  DEAD_REGISTRY,
  NPM_SCOPE_REGISTRY,
  // npm 11.19.1 reads the package document before a dry run of a version
  // above 0.0.0. Each retry on the dead address waits, 70 s for each
  // tarball with the default retries (read 2026-10-20). One try fails at once.
  "--fetch-retries=0",
];

/** The arguments of pnpm publish -r --dry-run in the release copy. */
export const PNPM_PUBLISH_ARGS: readonly string[] = [
  "publish",
  "-r",
  "--dry-run",
  "--no-git-checks",
  // pnpm 12.8.1 runs the publish scripts under --dry-run (review of Task 6, m1).
  "--ignore-scripts",
  "--access",
  "public",
  "--registry",
  DEAD_REGISTRY,
  PNPM_SCOPE_REGISTRY,
  // pnpm 12.8.1 also reads the package document first. With the default
  // retries on the dead address, it waits 70 s (read 2026-10-21). One try fails at once.
  "--config.fetch-retries=0",
  // pnpm 12.8.1 reads a proxy from the root .npmrc of the copy, from pnpm-workspace.yaml,
  // and from its config.yaml under HOME (review of the Task 6 fix, m1).
  // Through a proxy, it sends each package document read to the proxy host and still prints the dead registry.
  // No proxy serves the dead address. pnpm 12.8.1 ignores noproxy=* (read 2026-10-21).
  "--config.noproxy=127.0.0.1",
];

/** The body of the one temporary changeset. */
export const CHANGESET_BODY = "Dry run of the next release.";

/**
 * The phases of the smoke, in order (ruling 45 of plan 12j). In the apps
 * phase, an app with no kit tool loads each entry that is not a kit, and runs
 * the CLI. In the kits phase, the tools are added and each kit loads. So a
 * main entry that imports vitest fails the apps phase.
 */
export const SMOKE_PHASES = ["apps", "kits"] as const;

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
  /** The env that childEnv reads. The default is process.env. */
  env?: NodeJS.ProcessEnv;
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

/**
 * The fixed keys of each child. The two wrangler keys, with CI and NO_COLOR,
 * hold a build that spawns wrangler (ruling 40 of plan 11e).
 */
const CHILD_ENV = {
  CI: "1",
  NO_COLOR: "1",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_HIDE_BANNER: "true",
  TURBO_TELEMETRY_DISABLED: "1",
};

/**
 * The keys of the parent env that a child keeps. Each other key stays out,
 * such as HOME, NPM_TOKEN, NODE_AUTH_TOKEN, NODE_OPTIONS, npm_config_*, and TURBO_*.
 */
const KEPT_ENV = [
  // The search path of node, pnpm, npm, git, and tar.
  "PATH",
  // The temp folder of each tool.
  "TMPDIR",
  // The text encoding of the output, such as the package mark of the pnpm lines.
  "LANG",
] as const;

/** The keys of KEPT_ENV that `parent` holds. */
function keptOf(parent: NodeJS.ProcessEnv): ChildEnv {
  const env: ChildEnv = {};
  for (const key of KEPT_ENV) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The files of the temp folder that each child gets in place of the files of the person. */
export interface ChildFiles {
  /** The empty user npmrc. */
  user: string;
  /** The empty global npmrc. */
  global: string;
  /** The empty HOME folder. */
  home: string;
}

/** The store and the caches of the person, which the offline installs read. */
export interface ToolPaths {
  store: string;
  pnpmCache: string;
  npmCache: string;
}

/**
 * The read of each tool path, under the HOME of the person. pnpm 12.8.1 and
 * npm 11.19.1 print one absolute path for each (read 2026-10-21).
 * npm config get cache refuses a path that looks like a secret, such as a path
 * with a UUID in it. npm exec gives the same value to its child, with no such check.
 */
const PATH_READS: [key: keyof ToolPaths, cmd: string, args: readonly string[]][] = [
  ["store", "pnpm", ["store", "path"]],
  ["pnpmCache", "pnpm", ["cache", "path"]],
  ["npmCache", "npm", ["exec", "--offline", "-c", "node -p process.env.npm_config_cache"]],
];

/**
 * The env of the path reads: the kept keys, the HOME of `parent`, the fixed
 * keys, and the two empty npmrc files. No read sends a request.
 */
export function readEnv(parent: NodeJS.ProcessEnv, files: ChildFiles): ChildEnv {
  const env: ChildEnv = {
    ...keptOf(parent),
    ...CHILD_ENV,
    NPM_CONFIG_USERCONFIG: files.user,
    NPM_CONFIG_GLOBALCONFIG: files.global,
  };
  if (parent.HOME !== undefined) env.HOME = parent.HOME;
  return env;
}

/** Reads each tool path once with `run`, in the empty folder `cwd`. */
export function readToolPaths(
  run: Run,
  env: ChildEnv,
  cwd: string,
): { paths: ToolPaths; failures: string[] } {
  const paths: ToolPaths = { store: "", pnpmCache: "", npmCache: "" };
  const failures: string[] = [];
  for (const [key, cmd, args] of PATH_READS) {
    const label = `${cmd} ${args.join(" ")}`;
    const r = run(cmd, args, cwd, env);
    const lines = nonEmpty(r.stdout).map((l) => l.trim());
    if (r.status !== 0) failures.push(`${label} exited ${r.status}: ${firstLine(r)}`);
    else if (lines.length !== 1 || !isAbsolute(lines[0] ?? ""))
      failures.push(`${label} printed no one absolute path: ${lines.join(", ") || "no output"}`);
    else paths[key] = lines[0] ?? "";
  }
  return { paths, failures };
}

/**
 * The env of each child of the dry run: the kept keys of `parent`, the fixed
 * keys, the files of the temp folder, and the tool paths. npm 11.19.1 refuses
 * one file as both the user and the global config (read 2026-10-21), so there are two.
 */
export function childEnv(parent: NodeJS.ProcessEnv, files: ChildFiles, paths: ToolPaths): ChildEnv {
  return {
    ...keptOf(parent),
    ...CHILD_ENV,
    // An empty folder, never the HOME of the person (review of the Task 6 fix, M1, m1, L1).
    // In the HOME of the person, pnpm 12.8.1 reads Library/Preferences/pnpm/config.yaml,
    // which can hold a proxy, a registry, and a token.
    // turbo 2.11.7 reads the token of turbo login and of the Vercel CLI under
    // Library/Application Support, and sends it to a remote cache.
    // git reads .gitconfig at git status and git archive.
    // npm reads no file in HOME, because the two npm config keys name the empty files.
    // The three keys below name the store and the caches, so no child needs the real HOME.
    HOME: files.home,
    NPM_CONFIG_USERCONFIG: files.user,
    NPM_CONFIG_GLOBALCONFIG: files.global,
    // The store and the metadata cache of the offline installs. pnpm 12.8.1 reads
    // pnpm_config_*, not npm_config_*, from the env (read 2026-10-21).
    pnpm_config_store_dir: paths.store,
    pnpm_config_cache_dir: paths.pnpmCache,
    // The cache of npm publish --dry-run.
    npm_config_cache: paths.npmCache,
  };
}

/** The registry that an npm or pnpm line names, with no slash at the end. */
const registryOf = (url: string) => url.replace(/\/+$/, "");

export const spawnRun: Run = (cmd, args, cwd, env) => {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env,
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
 * report. The summary line is "<name>: PASS|FAIL ...". Each failure line comes
 * after it and starts with two spaces, and a note is not one. A step with no
 * summary line gives null.
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
  // The temp folder comes first: the empty files of childEnv are in it.
  const temp = mkdtempSync(join(options.tmp ?? tmpdir(), "authtempo-release-"));
  const files: ChildFiles = {
    user: join(temp, "npmrc-user"),
    global: join(temp, "npmrc-global"),
    home: join(temp, "home"),
  };
  writeFileSync(files.user, "");
  writeFileSync(files.global, "");
  mkdirSync(files.home);
  const parent = options.env ?? process.env;
  let env: ChildEnv = {};
  /** Runs one step. A step that exits other than 0 adds a failure and gives null. */
  const step = (
    label: string,
    cmd: string,
    args: readonly string[],
    cwd: string,
  ): RunResult | null => {
    log(`dry-run: ${label}`);
    const r = run(cmd, args, cwd, env);
    if (r.status === 0) return r;
    const report = reportOf(r.stdout);
    failures.push(`${label} exited ${r.status}: ${report?.summary ?? firstLine(r)}`);
    for (const line of report?.failures ?? []) failures.push(`${label}: ${line}`);
    return null;
  };

  try {
    // The tool paths come from the real tools once, in the empty HOME folder as the working folder.
    log("dry-run: read the store and the caches");
    const read = readToolPaths(run, readEnv(parent, files), files.home);
    if (read.failures.length > 0) {
      failures.push(...read.failures);
      return done(1);
    }
    env = childEnv(parent, files, read.paths);
    // git archive HEAD holds no change of the working tree, so a dirty checkout
    // would pack another tree than the one that the person sees.
    log("dry-run: git status --porcelain");
    const status = run("git", ["status", "--porcelain"], options.root, env);
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
    dir = temp;
    return done(steps(temp));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    return done(1);
  } finally {
    // A run that stopped before the copy keeps no folder, also with --keep.
    if (options.keep !== true || dir === null) rmSync(temp, { recursive: true, force: true });
  }

  /**
   * The steps in the temp folder: the copy in repo/, the tarballs in out/, and
   * one smoke app for each phase in smoke-<phase>/.
   */
  function steps(temp: string): 0 | 1 {
    const repo = join(temp, "repo");
    const out = join(temp, "out");
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
    // The scope registry arguments hold only the names of SCOPE.
    for (const name of names)
      if (!name.startsWith(`${SCOPE}/`))
        failures.push(`${name} is outside ${SCOPE}, the scope of the scope registry arguments`);
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
    if (!copyStep("turbo run build", buildCommand(names))) return 1;

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
    const check = run(node, [...checkArgs, ...tarballs.map((t) => t.path)], repo, env);
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
      const r = run("npm", npmPublishArgs(t.path), out, env);
      const text = `${r.stdout}\n${r.stderr}`;
      // npm 11.19.1 prints "npm notice Publishing to <registry> with tag ..." (read 2026-10-21).
      const named = [...text.matchAll(/Publishing to (\S+) /g)].map((m) => m[1] ?? "");
      const other = named.find((url) => registryOf(url) !== DEAD_REGISTRY);
      if (r.status !== 0)
        failures.push(`${id}: npm publish --dry-run exited ${r.status}: ${firstLine(r)}`);
      else if (named.length === 0) failures.push(`${id}: npm publish --dry-run names no registry`);
      else if (other !== undefined)
        failures.push(
          `${id}: npm publish --dry-run names the registry ${other}, not ${DEAD_REGISTRY}`,
        );
      else if (!text.includes(`+ ${id}`))
        failures.push(`${id}: npm publish --dry-run does not print + ${id}`);
      else continue;
      bad.add(t.name);
    }
    if (failures.length > 0) return settle();

    const listed = step("pnpm publish -r --dry-run", "pnpm", PNPM_PUBLISH_ARGS, repo);
    if (listed === null) {
      for (const t of tarballs) bad.add(t.name);
      return settle();
    }
    // pnpm 12.8.1 prints "📦 <name>@<version> → <registry>" for each package (Task 6 Step 1).
    const seen = new Set<string>();
    for (const l of nonEmpty(listed.stdout)) {
      const m = /^📦 (\S+@[^@\s]+) → (\S+)/.exec(l.trim());
      if (m?.[1] === undefined || m[2] === undefined) continue;
      seen.add(m[1]);
      if (registryOf(m[2]) !== DEAD_REGISTRY) {
        failures.push(
          `pnpm publish -r --dry-run names the registry ${m[2]} for ${m[1]}, not ${DEAD_REGISTRY}`,
        );
        for (const t of tarballs) if (tag.get(t.name) === m[1]) bad.add(t.name);
      }
    }
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

    // Each smoke app is outside the workspace of the copy, as an app is. Each
    // @authtempo name resolves to its tarball through an override, because the
    // exact versions are on no registry yet (the form of Task 5).
    const deps = Object.fromEntries(tarballs.map((t) => [t.name, `file:${t.path}`]));
    for (const phase of SMOKE_PHASES) {
      const smoke = join(temp, `smoke-${phase}`);
      cpSync(join(repo, "release/smoke"), smoke, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(smoke, "package.json"), "utf8")) as Record<
        string,
        unknown
      >;
      manifest.dependencies = deps;
      // The devDependencies of release/smoke are the tools of the kits, such
      // as vitest. The apps phase installs none, as an app that runs no kit.
      if (phase === "apps") delete manifest.devDependencies;
      writeFileSync(join(smoke, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(
        join(smoke, "pnpm-workspace.yaml"),
        `overrides:\n${Object.entries(deps)
          .map(([k, v]) => `  "${k}": "${v}"`)
          .join("\n")}\n`,
      );
      if (!step(`smoke install ${phase}`, "pnpm", ["install", "--offline"], smoke)) {
        for (const t of tarballs) bad.add(t.name);
        return settle();
      }
      log(`dry-run: node smoke.mjs ${phase}`);
      const s = run("node", ["smoke.mjs", join(repo, ".changeset/config.json"), phase], smoke, env);
      const smoked = reportOf(s.stdout);
      if (s.status !== 0 || smoked === null || !smoked.summary.startsWith("smoke: PASS")) {
        failures.push(`node smoke.mjs exited ${s.status}: ${smoked?.summary ?? firstLine(s)}`);
        for (const l of smoked?.failures ?? []) failures.push(`smoke: ${l}`);
        for (const t of tarballs) bad.add(t.name);
        return settle();
      }
      lines.push(smoked.summary);
      counts.smoke++;
    }
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
