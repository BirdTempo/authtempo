import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { COMMON_OPTIONS, oneOf, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { INIT_HELP } from "../help/init.js";
import type { InitJson } from "../json.js";
import { printJson, sayer } from "../output.js";
import {
  STACK_INFO,
  STACKS,
  type Stack,
  type TemplateFile,
  UNPUBLISHED,
  UNPUBLISHED_NOTE,
} from "../templates.js";

const OPTIONS = { ...COMMON_OPTIONS, stack: { type: "string" } } as const;

/** dist/templates.json: the build renders it from the 11a examples (scripts/copy-templates.mjs). */
const TEMPLATES = fileURLToPath(new URL("../templates.json", import.meta.url));

/** A path as a shell reads it: in single quotes when it holds a space or a character of the shell. */
export function shellPath(path: string): string {
  return /^[A-Za-z0-9_./,:@%+=-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * `authtempo init [dir] --stack <stack>` (spec 19, owner decision 3): it
 * writes the files of the stack and prints the install command and the
 * next steps. It runs no install, needs no network, and writes no secret.
 * A folder that holds any of its files stops the run before the first write.
 * The stack list and the steps come from src/templates.ts, the one source
 * that the build renders from; the files come from dist/templates.json.
 */
export const initCommand: Command = {
  help: INIT_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    const { values, positionals } = parseOrUsage(
      () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
      Object.keys(OPTIONS),
    );
    if (positionals.length > 1)
      throw new UsageError(`init takes one folder; got ${positionals.length}`);
    const stack = oneOf("stack", values.stack, STACKS);
    if (stack === undefined)
      throw new UsageError(
        "name a stack: --stack workers-d1, workers-postgres, node, bun, or mcp-server",
      );
    const given = positionals[0] ?? ".";
    const dir = resolve(ctx.cwd, given);
    const all = JSON.parse(ctx.readFile(TEMPLATES)) as Record<Stack, TemplateFile[]>;
    const files = all[stack];
    const taken = files.filter((f) => ctx.exists(join(dir, f.path)));
    if (taken.length > 0) {
      for (const f of taken) ctx.err(`exists: ${join(dir, f.path)}`);
      throw new Stop(
        `init writes no file over a file; the folder ${dir} holds ${taken.length} of its files`,
      );
    }
    const json = values.json === true;
    const say = sayer(ctx, json);
    ctx.err(`writing ${files.length} files to ${dir}`);
    for (const f of files) {
      ctx.writeNew(join(dir, f.path), f.text);
      say(`wrote ${f.path}`);
    }
    const next = [
      ...(given === "." ? [] : [`cd ${shellPath(given)}`]),
      "pnpm install",
      ...STACK_INFO[stack].next,
    ];
    say("");
    say("Next:");
    for (const step of next) say(`  ${step}`);
    say(`Docs: https://authtempo.com/docs/start/${STACK_INFO[stack].page}/`);
    // On stderr, so stdout and the --json document stay the same at publication.
    if (UNPUBLISHED) ctx.err(UNPUBLISHED_NOTE);
    if (json)
      printJson(ctx, {
        stack,
        dir,
        files: files.map((f) => f.path),
        next,
        exit: 0,
        stopped: null,
      } satisfies InitJson);
    return 0;
  },
};
