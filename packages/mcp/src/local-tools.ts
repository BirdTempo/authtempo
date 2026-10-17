// The local tools (plan 11e Task 7; Tasks 8 to 10 add rows). Each one runs
// the CLI's main in process through the confined Io, and reads the result
// from the one --json document, never from stderr. Only the local binary
// imports this file: it reads the CLI, so the remote Worker cannot load it.
import { fileURLToPath } from "node:url";
import { main } from "@authtempo/cli/program";
import { type ConfinedIo, confinedIo, insideRoot, RootError } from "./cli-io.js";
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
 * The dist folder of the CLI. init reads its templates.json there, so the
 * confined Io may read this folder; it writes nothing there.
 */
const CLI_DIST = fileURLToPath(new URL(".", import.meta.resolve("@authtempo/cli/program")));

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

/** The local tool impls. createServer adds them for the local surface only. */
export function localTools(ctx: LocalContext): ToolImpl[] {
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
        readOnly: [CLI_DIST],
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
  return [scaffold];
}
