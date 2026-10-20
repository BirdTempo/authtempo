// Runs only in the publish job of release.yml. The loop never runs it without
// the fake seams of its test.
//
// The publish job runs no install, so this file imports only Node modules and
// ./lib/release-facts.ts, which imports nothing. A test holds the import list.
// It checks the npm floor, each SHA-256 against SHA256SUMS of the check job,
// and the registry, then runs one npm publish for each version that the
// registry lacks, in the order of the dependency graph.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { NPM_FLOOR } from "./lib/release-facts.ts";

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
  /** The names of its runtime dependencies. */
  dependencies: string[];
}

/** The registry state of one package: the version of the tarball is held, and the latest dist-tag. */
export type RegistryState = { held: boolean; latest: string | null } | { error: string };

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
    else if (state.held) plan.skip.push(`${t.name}@${t.version}`);
    else {
      const m = VERSION.exec(t.version);
      const older = state.latest !== null && compare(t.version, state.latest) < 0;
      const tag = older && m !== null ? `release-${m[1]}.${m[2]}` : "latest";
      plan.publish.push({ file: t.file, tag });
    }
  }
  if (failures.length > 0) return { publish: [], skip: [], failures };
  return plan;
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

export interface Outcome {
  published: string[];
  skipped: string[];
  failures: string[];
}

/** Publishes each tarball of `dir` that the registry lacks. */
export function publish(dir: string, seams: Seams): Outcome {
  const failures: string[] = [];
  const npm = seams.run("npm", ["--version"]);
  const npmVersion = npm.code === 0 ? npm.stdout.trim() : `(npm --version exited ${npm.code})`;
  const sums = readSums(readFileSync(join(dir, "SHA256SUMS"), "utf8"), failures);
  const hashed = readdirSync(dir)
    .filter((f) => f.endsWith(".tgz"))
    .sort()
    .map((file) => {
      const bytes = readFileSync(join(dir, file));
      return { file, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
  // The bytes of a tarball are read only after its hash matches.
  failures.push(...sumFailures(hashed, sums));
  if (failures.length > 0) return { published: [], skipped: [], failures };
  const tarballs: Tarball[] = hashed.map(({ file, bytes, sha256 }) => {
    const manifest = readManifest(bytes);
    const deps = manifest.dependencies;
    return {
      file,
      name: String(manifest.name),
      version: String(manifest.version),
      sha256,
      dependencies: deps !== null && typeof deps === "object" ? Object.keys(deps) : [],
    };
  });
  const registry: Record<string, RegistryState> = {};
  for (const t of tarballs) {
    const held = seams.npmView(`${t.name}@${t.version}`, "version");
    const latest = seams.npmView(t.name, "dist-tags.latest");
    if ("error" in held) registry[t.name] = { error: held.error };
    else if ("error" in latest) registry[t.name] = { error: latest.error };
    else
      registry[t.name] = {
        held: "found" in held && held.found === t.version,
        latest: "found" in latest ? latest.found : null,
      };
  }
  const plan = publishPlan({ tarballs, sums, registry, npmVersion });
  if (failures.length > 0 || plan.failures.length > 0)
    return { published: [], skipped: [], failures: [...failures, ...plan.failures] };

  const published: string[] = [];
  for (const { file, tag } of plan.publish) {
    // No --provenance flag and no token: publishConfig.provenance of the
    // prepared manifest and the OIDC token of the job give both.
    const r = seams.run("npm", ["publish", join(dir, file), "--access", "public", "--tag", tag]);
    if (r.code !== 0)
      return {
        published,
        skipped: plan.skip,
        failures: [`npm publish ${file} exited ${r.code}; rerun the workflow on the same tag`],
      };
    published.push(file);
  }
  return { published, skipped: plan.skip, failures: [] };
}

/** The summary line, each failure, and each skipped version. */
export function publishLines(o: Outcome): string[] {
  const verdict = o.failures.length === 0 ? "PASS" : "FAIL";
  return [
    `publish: ${verdict} published=${o.published.length} skipped=${o.skipped.length} failures=${o.failures.length}`,
    ...o.failures.map((f) => `  ${f}`),
    ...o.skipped.map((s) => `  skipped: ${s} is on the registry`),
  ];
}

/** The real seams: npm on the PATH of the publish job. */
export const npmSeams: Seams = {
  run(command, args) {
    const r = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
  npmView(spec, field) {
    const r = spawnSync("npm", ["view", spec, field, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = (r.stdout ?? "").trim();
    if (r.status === 0) {
      // npm view prints nothing for a version that the package lacks.
      if (out === "") return { missing: true };
      const value: unknown = JSON.parse(out);
      return typeof value === "string" ? { found: value } : { error: `the answer ${out}` };
    }
    if (/\bE404\b/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`)) return { missing: true };
    const first = (r.stderr ?? "").split("\n").find((l) => l.trim() !== "");
    return { error: first ?? `npm view exited ${r.status}` };
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
  const outcome = publish(resolve(dir), npmSeams);
  for (const line of publishLines(outcome)) console.log(line);
  process.exit(outcome.failures.length > 0 ? 1 : 0);
}
