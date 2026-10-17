// The local tools (plan 11e Task 7; Tasks 8 to 10 add rows). Each one runs
// the CLI's main in process through the confined Io, and reads the result
// from the one --json document, never from stderr. Only the local binary
// imports this file: it reads the CLI, so the remote Worker cannot load it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ALL_CHECK_CODES,
  CHECK_IDS,
  type CheckId,
  type CheckStatus,
  HELP,
  pageUrl,
} from "@authtempo/cli";
import { main } from "@authtempo/cli/program";
import { type ConfinedIo, confinedIo, insideRoot, RootError } from "./cli-io.js";
import { isPlanError, PlanStore, sha256 } from "./plans.js";
import type { LocalContext } from "./server.js";
import type { ToolImpl, ToolResult } from "./spec.js";
import { IMPORT_FILE_INPUTS, TOOLS, type ToolRow } from "./tools.js";

export type { LocalContext };

/**
 * The init templates of the CLI (dist/templates.json). init reads this one
 * file, so the confined Io may read it. It reads no other file of the CLI.
 */
export const CLI_TEMPLATES = fileURLToPath(
  new URL("templates.json", import.meta.resolve("@authtempo/cli/program")),
);

/**
 * Runs the CLI with --json in the argv, and parses its one document. The
 * document's exit must equal the exit code of the run. A run that prints no
 * document, or more than one, is a fault of the server, not of the tool input.
 */
export async function runCli(
  argv: readonly string[],
  io: ConfinedIo,
  cli: CliMain = main,
): Promise<{ code: number; json: Record<string, unknown> }> {
  const code = await cli(argv, io.io);
  const { out } = io.lines();
  const [line, ...more] = out;
  if (line === undefined || more.length > 0)
    throw new Error(
      `authtempo ${argv[0] ?? ""} printed ${out.length} stdout lines, not one document`,
    );
  const json = JSON.parse(line) as Record<string, unknown>;
  if (json.exit !== code)
    throw new Error(
      `authtempo ${argv[0] ?? ""} exited ${code}, but its document says ${String(json.exit)}`,
    );
  return { code, json };
}

function row(name: string): ToolRow {
  const r = TOOLS.find((t) => t.name === name);
  if (!r) throw new Error(`the tool table has no row ${name}`);
  return r;
}

const fault = (error: string): ToolResult => ({
  structured: { error },
  isError: true,
  text: error,
});

/**
 * The tool answer of a document. Exit 2 is a tool fault whose text is the
 * stop, after the given lines; exit 0 or 1 is a result.
 */
function answer(json: Record<string, unknown>, before: readonly string[] = []): ToolResult {
  if (json.exit !== 2) return { structured: json, isError: false };
  return {
    structured: json,
    isError: true,
    text: [...before, `stopped: ${String(json.stopped)}`].join("\n"),
  };
}

/** A text in a shell command: as it is when it is safe, else in single quotes. */
const shellWord = (word: string): string =>
  /^[A-Za-z0-9_./:=,@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/**
 * The provider and the flags of an import input, by the row's flag map. A
 * true boolean is a bare flag; a false or absent value passes nothing.
 */
function importArgs(r: ToolRow, input: Record<string, unknown>): string[] {
  const args = [String(input.provider)];
  for (const [key, flag] of Object.entries(r.wraps?.flags ?? {})) {
    const v = input[key];
    if (v === undefined || v === false) continue;
    args.push(`--${flag}`);
    if (v !== true) args.push(String(v));
  }
  return args;
}

/** The input without the keys that only the tool reads. */
function cliInput(r: ToolRow, input: Record<string, unknown>): Record<string, unknown> {
  const only = new Set(r.wraps?.toolOnly ?? []);
  return Object.fromEntries(Object.entries(input).filter(([k]) => !only.has(k)));
}

/**
 * The bytes of each file input, read inside the root, as text for the CLI
 * and as a SHA-256 for the plan. The CLI then reads these texts, not the
 * disk again, so the run imports the bytes that the digest names.
 */
function readExports(
  root: string,
  input: Record<string, unknown>,
): { texts: Map<string, string>; digests: Record<string, string> } | ToolResult {
  const texts = new Map<string, string>();
  const digests: Record<string, string> = {};
  for (const key of IMPORT_FILE_INPUTS) {
    const path = input[key];
    if (typeof path !== "string") continue;
    let real: string;
    try {
      real = insideRoot(root, path);
    } catch (e) {
      if (e instanceof RootError) return fault(e.message);
      throw e;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(real);
    } catch (e) {
      const why = (e as { code?: unknown }).code;
      return fault(`the file ${key} cannot be read: ${typeof why === "string" ? why : "an error"}`);
    }
    digests[key] = sha256(bytes);
    texts.set(real, bytes.toString("utf8"));
  }
  return { texts, digests };
}

/**
 * A confined Io whose reads of the export files answer the bytes that the
 * tool read. Each other read goes to the confined Io.
 */
export function pinnedIo(
  root: string,
  env: LocalContext["env"],
  texts: Map<string, string>,
): ConfinedIo {
  const base = confinedIo({ root, env, allowFetch: false, readOnly: [CLI_TEMPLATES] });
  return {
    lines: base.lines,
    io: {
      ...base.io,
      readFile: (path) => {
        let real: string;
        try {
          real = insideRoot(root, path);
        } catch {
          // Not a path of the root: the confined Io answers it, or refuses it.
          return base.io.readFile(path);
        }
        return texts.get(real) ?? base.io.readFile(path);
      },
    },
  };
}

/**
 * The SHA-256 of the variable name and the connection string, which binds a
 * plan to its database. Only the store keeps it; no answer or log holds it.
 */
const databaseOf = (ctx: LocalContext): string =>
  sha256(`${ctx.urlEnv}\u0000${ctx.env[ctx.urlEnv] ?? ""}`);

/** The main of the CLI. A test can wrap it to put a fault into a real run. */
export type CliMain = typeof main;

/** The fields of a migrate document that a dry run reads from the database. */
interface SchemaState {
  before: number | null;
  pending: string[];
}

/** The state of a migrate document that did not stop, or null. */
function schemaState(json: Record<string, unknown>): SchemaState | null {
  const { before, pending } = json;
  if (json.exit === 2 || !Array.isArray(pending)) return null;
  if (before !== null && typeof before !== "number") return null;
  return { before, pending: pending.map(String) };
}

/** The refusal of a plan whose database moved after the dry run. */
const SCHEMA_CHANGED = "the database changed since the plan";

/** The text of an input that is not one of the two modes of schema.migrate. */
const SCHEMA_MODES = "schema.migrate takes dry_run: true alone, or plan_id with confirm: true";

/** The answer of the check tool: fixed values only (plan deviation 1). */
export interface McpCheckResult {
  /** The origin that the CLI checked: the origin of base_url. */
  base: string;
  checks: { id: CheckId; status: CheckStatus; code: string | null; docs: string | null }[];
  /** The code of each warning, with no text after it. */
  warnings: string[];
  summary: { run: number; pass: number; fail: number; skip: number };
  exit: number;
  /** The CLI's own text of a stop: a host with no answer, or a usage error (Task 7 review I-7). */
  stopped: string | null;
}

/** The page of the check codes (the help of check): each code has its own anchor there. */
const CHECK_PAGE = (() => {
  const help = HELP.find((h) => h.command === "check");
  if (!help) throw new Error("the CLI has no help of check");
  return pageUrl(help);
})();

const CHECK_STATUSES: readonly string[] = ["pass", "fail", "skip"] satisfies CheckStatus[];

/** A value of a check document that is not one of the CLI's fixed values. */
class CheckShapeError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A code of the CLI's table, or null. Each other value is refused, so no text passes. */
function checkCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && ALL_CHECK_CODES.includes(value)) return value;
  throw new CheckShapeError();
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new CheckShapeError();
}

/** The stop text of the tool for each stop that it cannot tie to its own input. */
export const CHECK_STOPPED = "the check stopped; run authtempo check in the shell for the reason";

/** The usage error of --base-path (basePathOf of the CLI): a fixed text with no part of the input. */
const BASE_PATH_STOP =
  "--base-path starts with / and does not end with /, as basePath in the config";

/**
 * True when a stop text of the CLI names only the tool's own input. It
 * accepts the HostError texts of fetchWithin for each request of the run, and
 * the usage error of --base-path. The CLI puts the message of each thrown
 * error into stopped, so a text of another form can hold a text of the deployment.
 */
function ownStop(stopped: string, base: string, basePath: string): boolean {
  if (stopped === BASE_PATH_STOP) return true;
  const auth = `${base}${basePath}`;
  const requests = [
    `GET ${auth}/session`,
    `POST ${auth}/sign-out`,
    `GET ${auth}/jwks`,
    `GET ${base}/.well-known/openid-configuration`,
    `GET ${base}/.well-known/oauth-authorization-server`,
    `GET ${auth}/.well-known/openid-configuration`,
  ];
  return requests.some(
    (r) =>
      stopped.startsWith(r) &&
      /^(: no answer( in \d+ s)?| answered 3\d\d, a redirect: the CLI follows no redirect)$/.test(
        stopped.slice(r.length),
      ),
  );
}

/**
 * The answer of the check tool from the CLI's check document. The CLI puts
 * the deployment's cookie name, issuer, and cache-control into `detail` and
 * into the text of a warning (plan deviation 1). So the answer keeps each id,
 * status, and code only when it is a value of the CLI's tables. It adds the
 * link of each code, and throws CheckShapeError on each other value. A stop
 * text that ownStop refuses becomes CHECK_STOPPED.
 */
export function checkResult(
  report: Record<string, unknown>,
  base: string,
  basePath: string,
): McpCheckResult {
  const { checks, warnings, summary, exit, stopped } = report;
  if (!Array.isArray(checks) || !Array.isArray(warnings) || !isRecord(summary))
    throw new CheckShapeError();
  if (stopped !== null && typeof stopped !== "string") throw new CheckShapeError();
  return {
    base,
    checks: checks.map((c: unknown) => {
      if (!isRecord(c)) throw new CheckShapeError();
      const id = CHECK_IDS.find((i) => i === c.id);
      const status = CHECK_STATUSES.find((s) => s === c.status) as CheckStatus | undefined;
      if (id === undefined || status === undefined) throw new CheckShapeError();
      const code = checkCode(c.code);
      return { id, status, code, docs: code === null ? null : `${CHECK_PAGE}#${code}` };
    }),
    // A warning is "<code>: <text>"; the text can name the deployment's cookie.
    warnings: warnings.map((w: unknown) => {
      if (typeof w !== "string") throw new CheckShapeError();
      const code = checkCode(w.split(":")[0]);
      if (code === null) throw new CheckShapeError();
      return code;
    }),
    summary: {
      run: count(summary.run),
      pass: count(summary.pass),
      fail: count(summary.fail),
      skip: count(summary.skip),
    },
    exit: count(exit),
    stopped: stopped === null || ownStop(stopped, base, basePath) ? stopped : CHECK_STOPPED,
  };
}

/**
 * The Io of the check tool: the confined Io with fetch. Its fetch refuses
 * each URL of another origin than base_url, and follows no redirect. So
 * the tool's promise holds even if the CLI's checks change.
 */
export function checkIo(ctx: LocalContext, base: string): ConfinedIo {
  // check reads no variable without --target, and the tool passes none: no secret can reach it.
  const confined = confinedIo({ root: ctx.root, env: {}, allowFetch: true, readOnly: [] });
  const origin = new URL(base).origin;
  return {
    lines: confined.lines,
    io: {
      ...confined.io,
      fetch: (url, init) => {
        let to: string;
        try {
          to = new URL(url).origin;
        } catch {
          to = "";
        }
        if (to !== origin)
          return Promise.reject(new Error("the check tool fetches only the origin of base_url"));
        return confined.io.fetch(url, { ...init, redirect: "manual" });
      },
    },
  };
}

/** The local tool impls. createServer adds them for the local surface only. */
export function localTools(
  ctx: LocalContext,
  opts: { plans?: PlanStore; main?: CliMain } = {},
): ToolImpl[] {
  // One store per server: the plan of one connection is not a plan of another server.
  const plans = opts.plans ?? new PlanStore();
  const cli = opts.main ?? main;
  const scaffold: ToolImpl = {
    row: row("scaffold"),
    async call(input) {
      const dir = String(input.dir);
      const stack = String(input.stack);
      // The root rule before main runs: a refused path writes nothing.
      try {
        insideRoot(ctx.root, dir);
      } catch (e) {
        if (e instanceof RootError) return fault(e.message);
        throw e;
      }
      const io = confinedIo({
        root: ctx.root,
        env: ctx.env,
        allowFetch: false,
        readOnly: [CLI_TEMPLATES],
      });
      let run: Awaited<ReturnType<typeof runCli>>;
      try {
        run = await runCli(["init", dir, "--stack", stack, "--json"], io, cli);
      } catch (e) {
        return fault(e instanceof Error ? e.message : String(e));
      }
      // The CLI names each file that stops init on an exists: line of stderr.
      const exists = io.lines().err.filter((l) => l.startsWith("exists: "));
      return answer(run.json, exists);
    },
  };

  const planRow = row("migrate.plan");
  const migratePlan: ToolImpl = {
    row: planRow,
    async call(input) {
      const read = readExports(ctx.root, input);
      if (!("texts" in read)) return read;
      const against = input.against === "database" ? "database" : "empty";
      const target =
        against === "database"
          ? ["--target", "postgres", "--url-env", ctx.urlEnv]
          : ["--target", "memory"];
      const args = importArgs(planRow, input);
      let run: Awaited<ReturnType<typeof runCli>>;
      try {
        run = await runCli(
          ["import", ...args, ...target, ...(planRow.wraps?.fixed ?? [])],
          pinnedIo(ctx.root, ctx.env, read.texts),
          cli,
        );
      } catch (e) {
        return fault(e instanceof Error ? e.message : String(e));
      }
      // Only a plan against the database that did not stop gives an id (plan deviation 4).
      const planId =
        against === "database" && run.json.exit !== 2
          ? plans.hold(
              "import",
              cliInput(planRow, input),
              read.digests,
              run.json.report,
              databaseOf(ctx),
            )
          : null;
      // The command of the real run, for the shell: the same flags as migrate.run, with no --json.
      const next = ["authtempo", "import", ...args, "--target", "postgres", "--url-env", ctx.urlEnv]
        .map(shellWord)
        .join(" ");
      return answer({ ...run.json, against, plan_id: planId, next });
    },
  };

  const runRow = row("migrate.run");
  const migrateRun: ToolImpl = {
    row: runRow,
    async call(input) {
      // The plan is taken before any check, so each refusal uses it up (the
      // brief's rule). A refused confirm, a root refusal, and a read failure
      // use it up too.
      const read = readExports(ctx.root, input);
      const held = plans.take(
        "import",
        String(input.plan_id),
        cliInput(runRow, input),
        "texts" in read ? read.digests : {},
        databaseOf(ctx),
      );
      // The schema holds confirm to true. This check stays for a caller that skips the schema.
      if (input.confirm !== true) return fault("migrate.run needs confirm: true");
      if (!("texts" in read)) return read;
      if (isPlanError(held)) return fault(held.refused);
      let run: Awaited<ReturnType<typeof runCli>>;
      try {
        run = await runCli(
          [
            "import",
            ...importArgs(runRow, input),
            ...(runRow.wraps?.fixed ?? []),
            "--url-env",
            ctx.urlEnv,
          ],
          pinnedIo(ctx.root, ctx.env, read.texts),
          cli,
        );
      } catch (e) {
        return fault(e instanceof Error ? e.message : String(e));
      }
      return answer(run.json);
    },
  };
  const schemaRow = row("schema.migrate");
  /** One run of authtempo migrate on the server's database: a dry run, or the real run. */
  const migrate = (tables: string, dryRun: boolean) =>
    runCli(
      [
        "migrate",
        ...(schemaRow.wraps?.fixed ?? []),
        "--url-env",
        ctx.urlEnv,
        "--tables",
        tables,
        ...(dryRun ? ["--dry-run"] : []),
      ],
      confinedIo({ root: ctx.root, env: ctx.env, allowFetch: false, readOnly: [] }),
      cli,
    );
  const schemaMigrate: ToolImpl = {
    row: schemaRow,
    async call(input) {
      const dryRun = input.dry_run;
      const planId = input.plan_id;
      const planMode = dryRun === true && planId === undefined && input.confirm === undefined;
      const runMode = dryRun === undefined && typeof planId === "string" && input.confirm === true;
      if (!planMode && !runMode) return fault(SCHEMA_MODES);
      const tables = input.tables === "compat" ? "compat" : "core";
      const bound = cliInput(schemaRow, input);
      // The command of the real run, for the shell: the same flags with no --json.
      const next = [
        "authtempo",
        "migrate",
        "--target",
        "postgres",
        "--tables",
        tables,
        "--url-env",
        ctx.urlEnv,
      ]
        .map(shellWord)
        .join(" ");

      if (planMode) {
        let plan: Awaited<ReturnType<typeof runCli>>;
        try {
          plan = await migrate(tables, true);
        } catch (e) {
          return fault(e instanceof Error ? e.message : String(e));
        }
        // The version gate of the CLI stops a newer database with exit 2: no plan_id.
        const state = schemaState(plan.json);
        if (state === null) return answer({ ...plan.json, plan_id: null, next: null });
        const id = plans.hold("schema", bound, {}, state, databaseOf(ctx));
        return answer({ ...plan.json, plan_id: id, next });
      }

      const held = plans.take("schema", String(planId), bound, {}, databaseOf(ctx));
      if (isPlanError(held)) return fault(held.refused);
      const planned = held.report as SchemaState;
      // The dry run again, against the database as it is now. The gate runs in it first.
      let fresh: Awaited<ReturnType<typeof runCli>>;
      try {
        fresh = await migrate(tables, true);
      } catch (e) {
        return fault(e instanceof Error ? e.message : String(e));
      }
      const now = schemaState(fresh.json);
      if (now === null) return answer({ ...fresh.json, plan_id: null, next: null });
      if (JSON.stringify(now) !== JSON.stringify(planned)) return fault(SCHEMA_CHANGED);
      let run: Awaited<ReturnType<typeof runCli>>;
      try {
        run = await migrate(tables, false);
      } catch (e) {
        return fault(e instanceof Error ? e.message : String(e));
      }
      if (run.json.exit !== 2) return answer({ ...run.json, plan_id: null, next: null });
      return afterStop(run.json, tables, planned);
    },
  };

  /**
   * The answer of a real run that stopped. A stop document holds empty
   * values, also after a migration was applied (Task 7 review I-2). So the
   * tool reads the state from the database again with a dry run.
   */
  async function afterStop(
    stop: Record<string, unknown>,
    tables: string,
    planned: SchemaState,
  ): Promise<ToolResult> {
    const stopped = `stopped: ${String(stop.stopped)}`;
    let state: SchemaState | null = null;
    try {
      state = schemaState((await migrate(tables, true)).json);
    } catch {
      // The state stays unknown, and the answer says so.
    }
    if (state === null)
      return {
        structured: {
          ...stop,
          target: "postgres",
          tables,
          dryRun: false,
          before: planned.before,
          after: null,
          pending: null,
          applied: null,
          plan_id: null,
          next: null,
        },
        isError: true,
        text: `${stopped}\nthe state of the database after the stop is unknown: run schema.migrate with dry_run: true`,
      };
    const left = new Set(state.pending);
    return {
      structured: {
        ...stop,
        // The stop document holds the empty target and tables; the tool knows both.
        target: "postgres",
        tables,
        dryRun: false,
        before: planned.before,
        after: state.before,
        pending: planned.pending,
        applied: planned.pending.filter((n) => !left.has(n)),
        plan_id: null,
        next: null,
      },
      isError: true,
      text: `${stopped}\nafter the stop, the database is at version ${state.before ?? "none"} with ${state.pending.length} pending migration(s)`,
    };
  }

  const checkRow = row("check");
  const check: ToolImpl = {
    row: checkRow,
    async call(input) {
      // The origin that the CLI checks (baseOf of the CLI). The schema holds base_url to an origin.
      const base = new URL(String(input.base_url)).origin;
      const basePath = String(input.base_path);
      // The flags of the row's map: a true boolean is a bare flag; false passes nothing.
      const args = ["check", base];
      for (const [key, flag] of Object.entries(checkRow.wraps?.flags ?? {})) {
        const v = input[key];
        if (v === undefined || v === false) continue;
        args.push(`--${flag}`);
        if (v !== true) args.push(String(v));
      }
      let result: McpCheckResult;
      try {
        const run = await runCli(
          [...args, ...(checkRow.wraps?.fixed ?? [])],
          checkIo(ctx, base),
          cli,
        );
        result = checkResult(run.json, base, basePath);
      } catch (e) {
        // A fixed text: an error of the run can hold a text of the deployment.
        if (e instanceof CheckShapeError)
          return fault("the check document holds a value that is not a code of the CLI");
        return fault("the check run failed in the server; run authtempo check in the shell");
      }
      return answer({ ...result });
    },
  };
  return [scaffold, migratePlan, migrateRun, schemaMigrate, check];
}
