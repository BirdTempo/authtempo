import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { COMMON_OPTIONS, oneOf, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { INFO_HELP } from "../help/info.js";
import type { InfoJson } from "../json.js";
import { parseJsonc } from "../jsonc.js";
import { baseOf, basePathOf, HostError, timeoutOf } from "../net.js";
import { OperatorStop, operatorCall, readOperatorSecret } from "../operator-client.js";
import { type Ctx, printJson } from "../output.js";
import { CALLS_PER_HOUR } from "../rewrap-limits.js";
import { readableVersion, readD1Version } from "../schema-version.js";
import { type D1Target, findWranglerConfig, readD1Project, wranglerOf } from "../seams/d1.js";
import { openPostgres, type PostgresSeam, storageCode } from "../seams/postgres.js";
import { DEFAULT_TOKEN_ENV, DEFAULT_URL_ENV, readSecret } from "../secrets.js";
import { readTemplates } from "../templates.js";
import { CLI_VERSION, SCHEMA_VERSION } from "../version.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  target: { type: "string" },
  "url-env": { type: "string" },
  "url-file": { type: "string" },
  database: { type: "string" },
  config: { type: "string" },
  remote: { type: "boolean" },
  "token-env": { type: "string" },
  "token-file": { type: "string" },
  "base-path": { type: "string" },
  timeout: { type: "string" },
} as const;

const POSTGRES_FLAGS = ["url-env", "url-file"] as const;
const D1_FLAGS = ["database", "config", "remote"] as const;
/** The flags of the deployment part: each needs the base URL. */
const DEPLOYMENT_FLAGS = ["token-env", "token-file", "base-path", "timeout"] as const;

/** A config key path as the info route lists it: a name, or a name, a dot, and a name. Any other text is dropped. */
export const KEY_PATH = /^[A-Za-z][A-Za-z0-9]{0,39}(\.[A-Za-z][A-Za-z0-9]{0,39})?$/;
/** A version as a package.json holds it, with a short tag at most. Any other text reads as `unreadable`. */
export const VERSION_TEXT = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]{1,40})?$/;
/** The largest info answer that the report reads: 64 KiB. A deployment answers untrusted text. */
export const INFO_MAX_BYTES = 65_536;
/** The most config key paths that the report lists. The rest count as dropped. */
export const INFO_MAX_KEYS = 400;
/** A tool name or a tool version as the report prints it: the user agent and the packageManager field are untrusted text. */
const TOOL_WORD = /^[A-Za-z0-9._-]{1,40}$/;
/** The adapter packages, by their name under the scope. */
const ADAPTERS = ["adapter-d1", "adapter-postgres", "compat-better-auth"] as const;
const SCOPE = "@authtempo/";
/** The two example files of a template that list the secrets of a stack with no value. */
const EXAMPLE_FILES = new Set([".dev.vars.example", ".env.example"]);
/** The text of a wrangler failure can name the database or a path, so the report keeps none of it. */
const WRANGLER_FAILURE = "wrangler d1 execute: ";

type Database = NonNullable<InfoJson["database"]>;
type Deployment = NonNullable<InfoJson["deployment"]>;
type Unread = InfoJson["unread"][number];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The secret names of the templates (plan 11c2 deviation 8). A name is each
 * `NAME=` line with an empty value in `.dev.vars.example` or `.env.example`
 * of a stack. The two default variable names of the CLI join them. One
 * source with `init`: dist/templates.json. Sorted, each name once.
 */
export function secretNames(): string[] {
  const names = new Set<string>([DEFAULT_URL_ENV, DEFAULT_TOKEN_ENV]);
  const all = readTemplates((path) => readFileSync(path, "utf8"));
  for (const files of Object.values(all))
    for (const f of files) {
      if (!EXAMPLE_FILES.has(f.path)) continue;
      for (const line of f.text.split("\n")) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=$/.exec(line);
        if (m?.[1] !== undefined) names.add(m[1]);
      }
    }
  return [...names].sort();
}

/** The parsed JSON object of a file, or null when the file is missing, does not parse, or is no object. */
function readJson(ctx: Ctx, path: string): Record<string, unknown> | null {
  if (!ctx.exists(path)) return null;
  try {
    const v: unknown = JSON.parse(ctx.readFile(path));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/** The nearest package.json upward from cwd: its folder and its content. */
function nearestPackage(ctx: Ctx): { dir: string; pkg: Record<string, unknown> } | null {
  let dir = ctx.cwd;
  for (;;) {
    const path = join(dir, "package.json");
    if (ctx.exists(path)) {
      const pkg = readJson(ctx, path);
      if (pkg === null) ctx.err(`warning: ${path} is not a JSON object; the report has no project`);
      return pkg === null ? null : { dir, pkg };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** A tool and its version, when both are tool words; else null. */
function tool(
  name: string,
  version: string,
  source: "user-agent" | "package.json",
): InfoJson["packageManager"] {
  return TOOL_WORD.test(name) && TOOL_WORD.test(version) ? { name, version, source } : null;
}

/**
 * The package manager: the first word of npm_config_user_agent
 * (`pnpm/12.8.1 npm/? node/v26.10.0 …`), else the packageManager field of
 * the package.json (`pnpm@12.8.1` or `pnpm@12.8.1+sha512…`, without the
 * hash), else null. The tools part runs no child process.
 */
function packageManagerOf(
  ctx: Ctx,
  pkg: Record<string, unknown> | null,
): InfoJson["packageManager"] {
  const agent = ctx.env.npm_config_user_agent;
  if (agent !== undefined && agent !== "") {
    const [name = "", version = ""] = (agent.split(" ")[0] ?? "").split("/");
    return tool(name, version, "user-agent");
  }
  const field = pkg?.packageManager;
  if (typeof field !== "string") return null;
  const at = field.indexOf("@");
  if (at < 0) return null;
  return tool(field.slice(0, at), field.slice(at + 1).split("+")[0] ?? "", "package.json");
}

/**
 * Each @authtempo package of the dependencies and devDependencies, with the
 * version of its package.json under node_modules, or null when it is not
 * installed. `adapters` lists the adapter packages among them.
 */
function packagesOf(
  ctx: Ctx,
  project: { dir: string; pkg: Record<string, unknown> },
): { packages: InfoJson["packages"]; adapters: string[] } {
  const names = new Set<string>();
  for (const deps of [project.pkg.dependencies, project.pkg.devDependencies])
    if (isRecord(deps))
      for (const name of Object.keys(deps)) if (name.startsWith(SCOPE)) names.add(name);
  const packages: InfoJson["packages"] = {};
  for (const name of [...names].sort()) {
    const installed = readJson(ctx, join(project.dir, "node_modules", name, "package.json"));
    const version = installed?.version;
    packages[name] = typeof version === "string" && VERSION_TEXT.test(version) ? version : null;
  }
  return { packages, adapters: ADAPTERS.filter((a) => names.has(`${SCOPE}${a}`)) };
}

/**
 * The wrangler config beside the package.json: each `database_name` of
 * `d1_databases`, never a `database_id`. A file that does not parse gives
 * no database and one warning.
 */
function projectOf(ctx: Ctx, dir: string): NonNullable<InfoJson["project"]> {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const path = join(dir, name);
    if (!ctx.exists(path)) continue;
    let config: unknown;
    try {
      config = parseJsonc(ctx.readFile(path));
    } catch {
      ctx.err(`warning: ${path} does not parse; the report lists no D1 database`);
      return { wrangler: true, d1Databases: [] };
    }
    const list = isRecord(config) && Array.isArray(config.d1_databases) ? config.d1_databases : [];
    const d1Databases: string[] = [];
    for (const entry of list)
      if (isRecord(entry) && typeof entry.database_name === "string")
        d1Databases.push(entry.database_name);
    return { wrangler: true, d1Databases };
  }
  return { wrangler: false, d1Databases: [] };
}

/**
 * The Postgres database through one connection: the ping, the applied
 * migrations, the version text, and the compat version. A failure is no
 * stop: the part is unread with the code of the driver error. The host
 * never prints, because a support report goes into a public issue.
 */
async function readPostgres(ctx: Ctx, url: string): Promise<Database | Unread> {
  ctx.err("reading the postgres database");
  // The open is inside the try: a string that is no URL throws there (ERR_INVALID_URL).
  let pg: PostgresSeam | undefined;
  try {
    pg = openPostgres(url, 1);
    await pg.ping();
    const applied = await pg.appliedCore();
    const text = await pg.schemaVersionText();
    const compat = await pg.compatVersion();
    return {
      kind: "postgres",
      // The rule of migrate and check: a version that the CLI cannot read is a reason, not a number.
      schemaVersion: readableVersion(text, applied.length),
      applied: applied.length,
      // The seam answers 0 for a missing row; a mapping version starts at 1.
      compatVersion: compat === 0 ? null : compat,
    };
  } catch (e) {
    // A Stop of the version rule names no host; a driver error can, so the code alone prints.
    const reason = e instanceof Stop ? e.message : `storage: ${storageCode(e)}`;
    return { part: "database", reason };
  } finally {
    await pg?.close();
  }
}

/** The D1 database through the project's wrangler. The stderr line names the kind only, never the database. */
async function readD1(ctx: Ctx, t: D1Target): Promise<Database | Unread> {
  ctx.err(`reading the ${t.remote ? "remote" : "local"} D1 database`);
  try {
    const r = await readD1Version(ctx, t);
    return { kind: "d1", schemaVersion: r.version, applied: r.applied.length, compatVersion: null };
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    const reason = e.message.startsWith(WRANGLER_FAILURE)
      ? "wrangler d1 execute failed; run authtempo check --target d1 for its text"
      : e.message;
    return { part: "database", reason };
  }
}

/**
 * The answer of GET /operator/info as the report keeps it. A deployment
 * answers untrusted text. A `schemaVersion` that is no whole number from 1
 * to 9999 makes the part unread. A `core` that is no version reads as
 * `unreadable`. A key path that is no plain name is dropped and counted.
 * Each entry after INFO_MAX_KEYS is dropped and counted too.
 */
function infoAnswer(body: unknown): Deployment | Unread {
  const notInfo: Unread = { part: "deployment", reason: "the answer is not an info document" };
  if (!isRecord(body)) return notInfo;
  const schemaVersion = body.schemaVersion;
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > 9999
  )
    return notInfo;
  if (!Array.isArray(body.configKeys)) return notInfo;
  const core =
    typeof body.core === "string" && VERSION_TEXT.test(body.core) ? body.core : "unreadable";
  const configKeys: string[] = [];
  let dropped = 0;
  for (const [i, entry] of (body.configKeys as unknown[]).entries()) {
    if (i < INFO_MAX_KEYS && typeof entry === "string" && KEY_PATH.test(entry))
      configKeys.push(entry);
    else dropped++;
  }
  return { core, schemaVersion, configKeys, dropped };
}

/**
 * The deployment through `operatorCall`. A stop of the call is no stop of
 * `info`. The part is then unread with the status and the short reason,
 * and never with the URL of the request.
 */
async function readDeployment(
  ctx: Ctx,
  call: { base: string; basePath: string; secret: string; ms: number },
): Promise<Deployment | Unread> {
  ctx.err("reading the deployment");
  let body: unknown;
  try {
    body = await operatorCall(ctx, {
      ...call,
      path: "/operator/info",
      method: "GET",
      maxBytes: INFO_MAX_BYTES,
      perHour: CALLS_PER_HOUR,
    });
  } catch (e) {
    if (e instanceof OperatorStop)
      return { part: "deployment", reason: `GET /operator/info answered ${e.status}: ${e.why}` };
    // A HostError names the request before its last colon: `GET <url>: no answer`.
    if (e instanceof HostError) {
      const why = e.message.slice(e.message.lastIndexOf(": ") + 2);
      return { part: "deployment", reason: `GET /operator/info: ${why}` };
    }
    throw e;
  }
  return infoAnswer(body);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The human form: one line per part, then one line per config key and per unread part. */
function printReport(ctx: Ctx, doc: InfoJson): void {
  ctx.out(`authtempo ${doc.cli} (schema version ${doc.schemaVersion})`);
  ctx.out(`runtime: node ${doc.runtime.node}, ${doc.runtime.platform}, ${doc.runtime.arch}`);
  const pm = doc.packageManager;
  ctx.out(
    pm
      ? `package manager: ${pm.name} ${pm.version} (from ${pm.source === "user-agent" ? "npm_config_user_agent" : "package.json"})`
      : "package manager: none",
  );
  const packages = Object.entries(doc.packages).map(([n, v]) => `${n} ${v ?? "not installed"}`);
  ctx.out(`packages: ${packages.length > 0 ? packages.join(", ") : "none"}`);
  ctx.out(`adapters: ${doc.adapters.length > 0 ? doc.adapters.join(", ") : "none"}`);
  const p = doc.project;
  if (p === null) ctx.out("project: no package.json");
  else if (!p.wrangler) ctx.out("wrangler: none");
  else {
    const names = p.d1Databases.length > 0 ? `: ${p.d1Databases.join(", ")}` : "";
    ctx.out(`wrangler: ${plural(p.d1Databases.length, "D1 database")}${names}`);
  }
  ctx.out(
    `env: ${Object.entries(doc.env)
      .map(([n, s]) => `${n} ${s}`)
      .join(", ")}`,
  );
  const d = doc.database;
  if (d)
    ctx.out(
      `database: ${d.kind}, schema version ${d.schemaVersion ?? "none"}, ${plural(d.applied, "migration")} applied, compat version ${d.compatVersion ?? "none"}`,
    );
  const dep = doc.deployment;
  if (dep) {
    ctx.out(
      `deployment: core ${dep.core}, schema version ${dep.schemaVersion}, ${dep.configKeys.length} config keys, ${dep.dropped} dropped`,
    );
    for (const key of dep.configKeys) ctx.out(`config key: ${key}`);
  }
  for (const u of doc.unread) ctx.out(`unread: ${u.part}: ${u.reason}`);
}

/**
 * `authtempo info [<base url>]` (plan 11c2, spec 19): a support report of
 * the tools, the project, the database of `--target`, and the deployment of
 * the base URL. It holds no secret value and no host name, and it judges no
 * value: `check` judges. Exit 1 when a part that a flag asked for gave no
 * answer, else 0.
 */
export const infoCommand: Command = {
  help: INFO_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    const { values: v, positionals } = parseOrUsage(
      () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
      Object.keys(OPTIONS),
    );
    if (positionals.length > 1) throw new UsageError(`unexpected argument ${positionals[1]}`);
    // The base carries the operator secret, so http is for this machine only.
    const base = positionals[0] === undefined ? undefined : baseOf(positionals[0]);
    const target = oneOf("target", v.target, ["d1", "postgres"] as const);
    for (const flag of POSTGRES_FLAGS)
      if (v[flag] !== undefined && target !== "postgres")
        throw new UsageError(`--${flag} needs --target postgres`);
    for (const flag of D1_FLAGS)
      if (v[flag] !== undefined && target !== "d1")
        throw new UsageError(`--${flag} needs --target d1`);
    for (const flag of DEPLOYMENT_FLAGS)
      if (v[flag] !== undefined && base === undefined)
        throw new UsageError(`--${flag} needs the base URL of the deployment`);
    const basePath = basePathOf(v["base-path"]);
    const ms = timeoutOf(v.timeout);
    // The operator secret right after the parse: a missing secret is a usage
    // error that costs no connection, and the value is in the scrub list first.
    const secret = base === undefined ? undefined : readOperatorSecret(ctx, v);

    // Before the first output line: each set secret joins the scrub list,
    // also when no part reads it (spec 19 item 5). The env part says set or unset only.
    const env: InfoJson["env"] = {};
    for (const name of secretNames()) {
      const value = ctx.env[name];
      const set = value !== undefined && value !== "";
      if (set) ctx.addSecret(value);
      env[name] = set ? "set" : "unset";
    }

    const near = nearestPackage(ctx);
    const { packages, adapters } = near ? packagesOf(ctx, near) : { packages: {}, adapters: [] };
    const project = near ? projectOf(ctx, near.dir) : null;
    const packageManager = packageManagerOf(ctx, near?.pkg ?? null);

    const unread: Unread[] = [];
    let database: InfoJson["database"] = null;
    if (target === "postgres") {
      const url = readSecret(ctx, {
        envFlag: "url-env",
        fileFlag: "url-file",
        env: v["url-env"],
        file: v["url-file"],
        defaultEnv: DEFAULT_URL_ENV,
        what: "the connection string",
      });
      const r = await readPostgres(ctx, url);
      if ("part" in r) unread.push(r);
      else database = r;
    } else if (target === "d1") {
      const d1 = readD1Project(ctx, findWranglerConfig(ctx, v.config), v.database);
      if (!ctx.exists(wranglerOf(d1.cwd)))
        throw new Stop(
          `no wrangler in ${join(d1.cwd, "node_modules")}: install the packages of the project first`,
        );
      const r = await readD1(ctx, { ...d1, remote: v.remote === true });
      if ("part" in r) unread.push(r);
      else database = r;
    }

    let deployment: InfoJson["deployment"] = null;
    if (base !== undefined && secret !== undefined) {
      const r = await readDeployment(ctx, { base, basePath, secret, ms });
      if ("part" in r) unread.push(r);
      else deployment = r;
    }

    const doc: InfoJson = {
      cli: CLI_VERSION,
      schemaVersion: SCHEMA_VERSION,
      runtime: { ...ctx.runtime },
      packageManager,
      packages,
      adapters,
      project,
      env,
      database,
      deployment,
      unread,
      exit: unread.length > 0 ? 1 : 0,
      stopped: null,
    };
    if (v.json === true) printJson(ctx, doc);
    else printReport(ctx, doc);
    return doc.exit;
  },
};
