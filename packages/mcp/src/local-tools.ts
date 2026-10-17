// The local tools (plan 11e Task 7; Tasks 8 to 10 add rows). Each one runs
// the CLI's main in process through the confined Io, and reads the result
// from the one --json document, never from stderr. Only the local binary
// imports this file: it reads the CLI, so the remote Worker cannot load it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "@authtempo/cli/program";
import { type ConfinedIo, confinedIo, insideRoot, RootError } from "./cli-io.js";
import { isPlanError, PlanStore, sha256 } from "./plans.js";
import type { ToolImpl, ToolResult } from "./spec.js";
import { TOOLS, type ToolRow } from "./tools.js";

/** The facts of the server that a local tool reads. */
export interface LocalContext {
  /** The server root, resolved by realpath at the start. */
  root: string;
  env: Readonly<Record<string, string | undefined>>;
  /** The variable of the connection string (--url-env), for Tasks 8 to 10. */
  urlEnv: string;
}

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
): Promise<{ code: number; json: Record<string, unknown> }> {
  const code = await main(argv, io.io);
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

/** The file inputs of migrate.plan and migrate.run, in the CLI's order. */
const FILE_INPUTS = ["users", "identities", "csv", "hashes", "organizations", "authjs_tables"];

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
  for (const key of FILE_INPUTS) {
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
function pinnedIo(root: string, env: LocalContext["env"], texts: Map<string, string>): ConfinedIo {
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

/** The local tool impls. createServer adds them for the local surface only. */
export function localTools(ctx: LocalContext, opts: { plans?: PlanStore } = {}): ToolImpl[] {
  // One store per server: the plan of one connection is not a plan of another server.
  const plans = opts.plans ?? new PlanStore();
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
        run = await runCli(["init", dir, "--stack", stack, "--json"], io);
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
      // The schema holds confirm to true. This check stays for a caller that skips the schema.
      if (input.confirm !== true) return fault("migrate.run needs confirm: true");
      const read = readExports(ctx.root, input);
      if (!("texts" in read)) return read;
      const held = plans.take(
        "import",
        String(input.plan_id),
        cliInput(runRow, input),
        read.digests,
        databaseOf(ctx),
      );
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
        );
      } catch (e) {
        return fault(e instanceof Error ? e.message : String(e));
      }
      return answer(run.json);
    },
  };
  return [scaffold, migratePlan, migrateRun];
}
