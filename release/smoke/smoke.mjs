// The consumer smoke of plan 12j (spec 33 item 6). The dry run copies this
// folder out of the repository, installs each release tarball into it offline,
// and runs `node smoke.mjs`. So each import resolves from node_modules, as in
// an app, and never from the workspace.
//
// For each @authtempo dependency of package.json, it imports each entry of the
// exports map. An entry of exempt.json needs a runtime that plain Node does
// not give (React, Electron, a browser, or workerd); the smoke checks that its
// target file exists and does not import it. Then it runs the packed CLI:
// `authtempo --help`, and `authtempo init <tmp>/app --stack node --json`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const own = readJson(join(here, "package.json"));
/** { "<package>": { "<export subpath>": "<reason>" } } */
const exempt = readJson(join(here, "exempt.json"));

const failures = [];
const names = Object.keys({ ...own.dependencies, ...own.devDependencies })
  .filter((n) => n.startsWith("@authtempo/"))
  .sort();
let entries = 0;
let exempted = 0;

/** The file of an export entry that Node loads: the default, import, or node condition. */
function targetOf(entry) {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object") return null;
  for (const key of ["node", "import", "default"])
    if (key in entry) {
      const t = targetOf(entry[key]);
      if (t !== null) return t;
    }
  return null;
}

for (const [name, subpaths] of Object.entries(exempt))
  for (const [subpath, reason] of Object.entries(subpaths))
    if (typeof reason !== "string" || reason.trim() === "")
      failures.push(`exempt.json: ${name} ${subpath} has no reason`);

for (const name of names) {
  const dir = join(here, "node_modules", name);
  const manifest = readJson(join(dir, "package.json"));
  const map =
    typeof manifest.exports === "string" ? { ".": manifest.exports } : (manifest.exports ?? {});
  const subpaths = Object.keys(map);
  if (subpaths.length === 0) failures.push(`${name} has no exports map`);
  const skip = exempt[name] ?? {};
  for (const subpath of Object.keys(skip))
    if (!(subpath in map)) failures.push(`exempt.json: ${name} has no export ${subpath}`);
  for (const subpath of subpaths) {
    const specifier = subpath === "." ? name : `${name}${subpath.slice(1)}`;
    if (subpath in skip) {
      exempted++;
      const target = targetOf(map[subpath]);
      if (target === null || !existsSync(join(dir, target)))
        failures.push(`${specifier} is exempt, and its target ${target} is not in the package`);
      continue;
    }
    entries++;
    try {
      await import(specifier);
    } catch (error) {
      failures.push(`${specifier} does not load: ${String(error).split("\n")[0]}`);
    }
  }
}
if (names.length === 0) failures.push("package.json names no @authtempo package");

// The packed CLI, run as an app runs it.
const cli = join(here, "node_modules", ".bin", "authtempo");
const cliVersion = existsSync(join(here, "node_modules/@authtempo/cli/package.json"))
  ? readJson(join(here, "node_modules/@authtempo/cli/package.json")).version
  : null;
let cliRuns = 0;
const run = (args, cwd) => {
  cliRuns++;
  return spawnSync(cli, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
};
const help = run(["--help"], here);
if (help.status !== 0 || !help.stdout.includes("authtempo"))
  failures.push(`authtempo --help exited ${help.status}: ${help.stderr.trim()}`);

const tmp = mkdtempSync(join(tmpdir(), "authtempo-smoke-"));
try {
  const app = join(tmp, "app");
  const init = run(["init", app, "--stack", "node", "--json"], tmp);
  if (init.status !== 0)
    failures.push(`authtempo init exited ${init.status}: ${init.stderr.trim()}`);
  else {
    const out = JSON.parse(init.stdout);
    const next = out.next.join("\n");
    // The published branch of plan 12j Task 11: no run form of a clone, and
    // each authtempo step through pnpm exec. The node stack has no authtempo
    // step today, so the second rule holds for a later step.
    if (next.includes("/path/to/authtempo") || `${init.stderr}`.includes("/path/to/authtempo"))
      failures.push("authtempo init gives the run form of a clone: node /path/to/authtempo");
    for (const step of out.next)
      if (/^authtempo\b/.test(step))
        failures.push(`the step ${step} does not run pnpm exec authtempo`);
    // Each @authtempo range of the app is the exact version of the packed CLI.
    const scaffold = readJson(join(app, "package.json"));
    const ranges = { ...scaffold.dependencies, ...scaffold.devDependencies };
    if (ranges["@authtempo/cli"] === undefined)
      failures.push("the scaffold has no @authtempo/cli in devDependencies");
    for (const [dep, range] of Object.entries(ranges))
      if (dep.startsWith("@authtempo/") && range !== cliVersion)
        failures.push(`the scaffold names ${dep} as ${range}, not ${cliVersion}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const verdict = failures.length === 0 ? "PASS" : "FAIL";
console.log(
  `smoke: ${verdict} packages=${names.length} entries=${entries} exempt=${exempted} cli=${cliRuns} failures=${failures.length}`,
);
for (const failure of failures) console.log(`  ${failure}`);
if (failures.length > 0) process.exit(1);
