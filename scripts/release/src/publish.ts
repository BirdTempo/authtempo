// Runs only in the publish job of release.yml. The loop never runs it without
// the fake seams of its test.
//
// The publish job runs no install, so this file imports only Node modules,
// ./lib/release-facts.ts, which imports nothing, and ./lib/run-sync.ts, which
// imports only a Node module. A test holds the import list.
// It checks the npm floor, each SHA-256 against the SHA-256 list of the check
// job, and the registry. Then it runs one npm publish for each version that
// the registry lacks, in the order of the dependency graph. The list comes
// from the job output of the check job through env, and the SHA256SUMS of the
// artifact must equal it (ruling 67 of plan 12j, Low 4).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { NPM_FLOOR, PUBLIC_REGISTRY, SCOPE } from "./lib/release-facts.ts";
import { RunTimeout, runSync } from "./lib/run-sync.ts";

/** The env key of the SHA-256 list of the job check, which release.yml sets from its job output. */
export const SUMS_ENV = "RELEASE_SHA256SUMS";

/**
 * The registry arguments of each npm call. npm reads the project .npmrc of the
 * checkout, and a scope registry there wins over --registry. So each call names
 * both, and a committed .npmrc cannot move the publish (review of the Task 6 fix, I5).
 */
export const REGISTRY_ARGS = [
  `--registry=${PUBLIC_REGISTRY}`,
  `--${SCOPE}:registry=${PUBLIC_REGISTRY}`,
] as const;

/** The arguments of `npm view <spec> <field> --json` on the public registry. */
export const viewArgs = (spec: string, field: string): string[] => [
  "view",
  spec,
  field,
  "--json",
  ...REGISTRY_ARGS,
];

/** What one npm view call found: the value, no such package or version, or an error. */
export type ViewAnswer = { found: string } | { missing: true } | { error: string };

/** The child processes of the publish job. The test replaces both. */
export interface Seams {
  run(command: string, args: string[]): { code: number; stdout: string; stderr: string };
  /** `npm view <spec> <field> --json`. */
  npmView(spec: string, field: string): ViewAnswer;
}

/** One tarball of the downloaded folder. */
export interface Tarball {
  file: string;
  name: string;
  version: string;
  sha256: string;
  /** The SHA-512 of its bytes in the form of dist.integrity: `sha512-<base64>`. */
  integrity: string;
  /** The names of its dependencies, peer dependencies, and optional dependencies. */
  dependencies: string[];
}

/**
 * The registry state of one package: the version of the tarball is held, the
 * latest dist-tag, and for a held version its dist.integrity, or null when
 * the registry gives none.
 */
export type RegistryState =
  | { held: boolean; latest: string | null; integrity?: string | null }
  | { error: string };

export interface Plan {
  publish: { file: string; tag: string }[];
  skip: string[];
  failures: string[];
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let k = 0; k < 3; k++) {
    const d = (pa[k] ?? 0) - (pb[k] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The tarballs in the order of the dependency graph: each package after the packages it needs. */
function graphOrder(tarballs: Tarball[], failures: string[]): Tarball[] {
  const byName = new Map(tarballs.map((t) => [t.name, t]));
  const done = new Set<string>();
  const order: Tarball[] = [];
  const visit = (t: Tarball, path: string[]) => {
    if (done.has(t.name)) return;
    if (path.includes(t.name)) {
      failures.push(`the dependency graph has a cycle: ${[...path, t.name].join(" -> ")}`);
      return;
    }
    for (const dep of t.dependencies) {
      const next = byName.get(dep);
      if (next !== undefined) visit(next, [...path, t.name]);
    }
    if (!done.has(t.name)) {
      done.add(t.name);
      order.push(t);
    }
  };
  for (const t of [...tarballs].sort((a, b) => a.name.localeCompare(b.name))) visit(t, []);
  return order;
}

/**
 * Each tarball has its line in SHA256SUMS with the same hash, and each line
 * has its tarball. The check job wrote the list, so a tarball that changed
 * between the two jobs fails here.
 */
export function sumFailures(
  tarballs: { file: string; sha256: string }[],
  sums: Map<string, string>,
): string[] {
  const failures: string[] = [];
  for (const t of tarballs) {
    const sum = sums.get(t.file);
    if (sum === undefined) failures.push(`${t.file} has no line in SHA256SUMS`);
    else if (sum !== t.sha256) failures.push(`the SHA-256 of ${t.file} differs from SHA256SUMS`);
  }
  const files = new Set(tarballs.map((t) => t.file));
  for (const file of sums.keys())
    if (!files.has(file))
      failures.push(`SHA256SUMS names ${file}, and the folder has no such tarball`);
  return failures;
}

/**
 * Decides each publish before the first one runs (spec 33 item 5). Any
 * failure leaves the plan empty, so a bad tarball or a registry error
 * publishes nothing. The highest version gets the dist-tag latest, and an
 * older minor gets release-<major>.<minor>.
 */
export function publishPlan(input: {
  tarballs: Tarball[];
  /** Each file name of SHA256SUMS with its hash. */
  sums: Map<string, string>;
  registry: Record<string, RegistryState>;
  npmVersion: string;
}): Plan {
  const { tarballs, sums, registry, npmVersion } = input;
  const failures = sumFailures(tarballs, sums);
  if (!VERSION.test(npmVersion) || compare(npmVersion, NPM_FLOOR) < 0)
    failures.unshift(`npm ${npmVersion} is below ${NPM_FLOOR}, the floor of trusted publishing`);
  if (tarballs.length === 0) failures.push("read 0 tarballs");
  const versions = new Set(tarballs.map((t) => t.version));
  if (versions.size > 1)
    failures.push(
      `the tarballs hold ${versions.size} versions: ${[...versions].sort().join(", ")}`,
    );
  for (const t of tarballs)
    if (!VERSION.test(t.version)) failures.push(`${t.file}: the version ${t.version} is not x.y.z`);
  const order = graphOrder(tarballs, failures);

  const plan: Plan = { publish: [], skip: [], failures };
  for (const t of order) {
    const state = registry[t.name];
    if (state === undefined) failures.push(`${t.name}: no registry answer`);
    else if ("error" in state)
      failures.push(`${t.name}: the registry answered ${state.error}; nothing is published`);
    else if (state.held) {
      // A held version with other bytes is a publish by hand or a token
      // before "disallow tokens". The job must not report it as this release
      // (ruling 67 of plan 12j, Low 2).
      if (state.integrity !== t.integrity)
        failures.push(
          `${t.name}@${t.version}: the registry holds this version with dist.integrity ${state.integrity ?? "none"}, not ${t.integrity} of the tarball`,
        );
      else plan.skip.push(`${t.name}@${t.version}`);
    } else {
      const m = VERSION.exec(t.version);
      const older = state.latest !== null && compare(t.version, state.latest) < 0;
      const tag = older && m !== null ? `release-${m[1]}.${m[2]}` : "latest";
      plan.publish.push({ file: t.file, tag });
    }
  }
  if (failures.length > 0) return { publish: [], skip: [], failures };
  return plan;
}

/**
 * The names of the packages that a manifest needs, peers and optional ones
 * too. A peer that publishes later leaves a version on npm that no install can
 * resolve until the rerun.
 */
export function dependencyNames(manifest: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest[field];
    if (deps !== null && typeof deps === "object")
      for (const name of Object.keys(deps)) names.add(name);
  }
  return [...names];
}

/** The package.json of a pnpm pack tarball, read from its tar headers. */
function readManifest(bytes: Buffer): Record<string, unknown> {
  const tar = gunzipSync(bytes);
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const text = (from: number, length: number) =>
      header
        .subarray(from, from + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const prefix = text(345, 155);
    const name = prefix === "" ? text(0, 100) : `${prefix}/${text(0, 100)}`;
    const size = Number.parseInt(text(124, 12).trim() || "0", 8);
    const type = text(156, 1);
    const body = at + 512;
    if (name === "package/package.json" && (type === "0" || type === ""))
      return JSON.parse(tar.subarray(body, body + size).toString("utf8")) as Record<
        string,
        unknown
      >;
    at = body + Math.ceil(size / 512) * 512;
  }
  throw new Error("the tarball has no package/package.json");
}

/** The lines of SHA256SUMS in the form of sha256sum: the hash, two spaces, the file name. */
function readSums(text: string, failures: string[]): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = /^([0-9a-f]{64}) {2}([^/\s]+)$/.exec(line);
    if (m === null) failures.push(`SHA256SUMS: the line ${line} is not <sha256>  <file>`);
    else sums.set(m[2] ?? "", m[1] ?? "");
  }
  return sums;
}

/**
 * The registry state of each tarball, from at most three npm view reads for
 * each. They read the version, the latest dist-tag, and for a held version its
 * dist.integrity. A read past its limit throws its RunTimeout.
 */
function registryStates(tarballs: Tarball[], seams: Seams): Record<string, RegistryState> {
  const registry: Record<string, RegistryState> = {};
  for (const t of tarballs) {
    const held = seams.npmView(`${t.name}@${t.version}`, "version");
    const latest = seams.npmView(t.name, "dist-tags.latest");
    if ("error" in held) registry[t.name] = { error: held.error };
    else if ("error" in latest) registry[t.name] = { error: latest.error };
    else if ("found" in held && held.found === t.version) {
      // npm view <spec> dist.integrity gives the SHA-512 of the tarball that the registry holds.
      const integrity = seams.npmView(`${t.name}@${t.version}`, "dist.integrity");
      registry[t.name] =
        "error" in integrity
          ? { error: integrity.error }
          : {
              held: true,
              latest: "found" in latest ? latest.found : null,
              integrity: "found" in integrity ? integrity.found : null,
            };
    } else registry[t.name] = { held: false, latest: "found" in latest ? latest.found : null };
  }
  return registry;
}

export interface Outcome {
  /** Each <name>@<version> that this run published. */
  published: string[];
  /** Each <name>@<version> of the plan that is not on the registry after a failed publish. */
  pending: string[];
  skipped: string[];
  failures: string[];
}

/**
 * Publishes each tarball of `dir` that the registry lacks. `listed` is the
 * SHA-256 list of the job check, from its job output: the artifact can bring
 * no list of its own.
 */
export function publish(dir: string, seams: Seams, listed: string): Outcome {
  const failures: string[] = [];
  const stop = (failure: string): Outcome => ({
    published: [],
    pending: [],
    skipped: [],
    failures: [failure],
  });
  let npm: { code: number; stdout: string; stderr: string };
  try {
    npm = seams.run("npm", ["--version"]);
  } catch (error) {
    // npm --version past its limit gives a FAIL line that names the call, not a
    // stack (ruling 41 of plan 12n). The check entries do the same.
    if (!(error instanceof RunTimeout)) throw error;
    return stop(error.message);
  }
  const npmVersion = npm.code === 0 ? npm.stdout.trim() : `(npm --version exited ${npm.code})`;
  if (listed.trim() === "")
    return stop(`${SUMS_ENV} is empty; the job check exports the SHA-256 list as its output sums`);
  if (!existsSync(join(dir, "SHA256SUMS")))
    return stop("the folder has no SHA256SUMS; the job check writes it");
  // The artifact carries its own copy, which the token fallback of the runbook reads.
  const copy = readFileSync(join(dir, "SHA256SUMS"), "utf8");
  if (copy.trimEnd() !== listed.trimEnd())
    return stop(`SHA256SUMS of the artifact differs from ${SUMS_ENV}, the output of the job check`);
  const sums = readSums(listed, failures);
  const hashed = readdirSync(dir)
    .filter((f) => f.endsWith(".tgz"))
    .sort()
    .map((file) => {
      const bytes = readFileSync(join(dir, file));
      return { file, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
  // The bytes of a tarball are read only after its hash matches.
  failures.push(...sumFailures(hashed, sums));
  if (failures.length > 0) return { published: [], pending: [], skipped: [], failures };
  // A tarball that it cannot read gives a failure line, never a stack (ruling 64 of plan 12j, Minor 3).
  const tarballs: Tarball[] = [];
  for (const { file, bytes, sha256 } of hashed) {
    let manifest: Record<string, unknown>;
    try {
      manifest = readManifest(bytes);
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    tarballs.push({
      file,
      name: String(manifest.name),
      version: String(manifest.version),
      sha256,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      dependencies: dependencyNames(manifest),
    });
  }
  if (failures.length > 0) return { published: [], pending: [], skipped: [], failures };
  let registry: Record<string, RegistryState>;
  try {
    registry = registryStates(tarballs, seams);
  } catch (error) {
    // An npm view past its limit gives such a FAIL line too. publish makes no
    // plan, so no publish runs.
    if (!(error instanceof RunTimeout)) throw error;
    return stop(error.message);
  }
  const plan = publishPlan({ tarballs, sums, registry, npmVersion });
  if (failures.length > 0 || plan.failures.length > 0)
    return {
      published: [],
      pending: [],
      skipped: [],
      failures: [...failures, ...plan.failures],
    };

  const spec = new Map(tarballs.map((t) => [t.file, `${t.name}@${t.version}`]));
  const published: string[] = [];
  for (const [k, { file, tag }] of plan.publish.entries()) {
    let r: { code: number; stdout: string; stderr: string };
    try {
      // No --provenance flag and no token: publishConfig.provenance of the
      // prepared manifest and the OIDC token of the job give both.
      r = seams.run("npm", [
        "publish",
        join(dir, file),
        "--access",
        "public",
        "--tag",
        tag,
        ...REGISTRY_ARGS,
      ]);
    } catch (error) {
      // A publish past its limit gives the lines of a half release, not a
      // stack (review of Task 1 of plan 12n, M2). npm may hold that version
      // or not, so the failure line names it, and neither list does.
      if (!(error instanceof RunTimeout)) throw error;
      const version = spec.get(file) ?? file;
      return {
        published,
        // Each later version. No later publish runs.
        pending: plan.publish.slice(k + 1).map((p) => spec.get(p.file) ?? p.file),
        skipped: plan.skip,
        failures: [
          `${error.message}; the registry may hold ${version}, so rerun the workflow on the same tag`,
        ],
      };
    }
    if (r.code !== 0)
      return {
        published,
        // The failed version and each later one. No later publish runs.
        pending: plan.publish.slice(k).map((p) => spec.get(p.file) ?? p.file),
        skipped: plan.skip,
        failures: [`npm publish ${file} exited ${r.code}; rerun the workflow on the same tag`],
      };
    published.push(spec.get(file) ?? file);
  }
  return { published, pending: [], skipped: plan.skip, failures: [] };
}

/**
 * The summary line, each failure, and each version by its registry state. After
 * a half release, the owner reads here which versions npm has.
 */
export function publishLines(o: Outcome): string[] {
  const verdict = o.failures.length === 0 ? "PASS" : "FAIL";
  return [
    `publish: ${verdict} published=${o.published.length} skipped=${o.skipped.length} failures=${o.failures.length}`,
    ...o.failures.map((f) => `  ${f}`),
    ...o.published.map((s) => `  published: ${s} is on the registry`),
    ...o.pending.map((s) => `  not published: ${s} is not on the registry`),
    ...o.skipped.map((s) => `  skipped: ${s} is on the registry`),
  ];
}

/** The answer of one `npm view <spec> <field> --json` from its exit code and output. */
export function readView(status: number | null, stdout: string, stderr: string): ViewAnswer {
  const out = stdout.trim();
  if (status === 0) {
    // npm view prints nothing for a version that the package lacks.
    if (out === "") return { missing: true };
    let value: unknown;
    try {
      value = JSON.parse(out);
    } catch {
      return { error: `the answer ${out} is not JSON` };
    }
    return typeof value === "string" ? { found: value } : { error: `the answer ${out}` };
  }
  if (/\bE404\b/.test(`${stdout}${stderr}`)) return { missing: true };
  const first = stderr.split("\n").find((l) => l.trim() !== "");
  return { error: first ?? `npm view exited ${status}` };
}

/**
 * The real seams: npm on the PATH of the publish job. A call past its limit
 * throws a RunTimeout that names the call, and the job fails. npm --version
 * and each npm view run before the publish loop. publish prints a stalled one
 * as a FAIL line that names the call, as the check entries do, and no publish
 * runs. The loop prints a stalled npm publish with each version after it.
 */
export const npmSeams: Seams = {
  run(command, args) {
    let r: ReturnType<typeof runSync>;
    try {
      // This seam runs npm --version and each npm publish. No real publish ran
      // before the first release, so each call takes the widest limit. A real
      // publish has no measure yet. The first real publish gives it.
      r = runSync(command, args, { stdio: ["ignore", "pipe", "pipe"], limit: "step" });
    } catch (error) {
      // The output up to the kill shows how far npm got. It goes to the log
      // before the failure line (review of Task 1 of plan 12n, M2).
      if (error instanceof RunTimeout) {
        process.stdout.write(error.stdout);
        process.stderr.write(error.stderr);
      }
      throw error;
    }
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
  npmView(spec, field) {
    const r = runSync("npm", viewArgs(spec, field), {
      stdio: ["ignore", "pipe", "pipe"],
      limit: "registry",
    });
    return readView(r.status, r.stdout ?? "", r.stderr ?? "");
  },
};

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.log("publish: FAIL published=0 skipped=0 failures=1");
    console.log("  usage: node scripts/release/src/publish.ts <folder of the tarballs>");
    process.exit(2);
  }
  // The folder is relative to the working folder, the checkout of the publish job.
  const outcome = publish(resolve(dir), npmSeams, process.env[SUMS_ENV] ?? "");
  for (const line of publishLines(outcome)) console.log(line);
  process.exit(outcome.failures.length > 0 ? 1 : 0);
}
