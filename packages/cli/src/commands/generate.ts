import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { COMMON_OPTIONS, oneOf, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { printDrizzle } from "../generate/drizzle.js";
import { DIALECTS, FORMATS, type GenerateFormat } from "../generate/header.js";
import { printPrisma } from "../generate/prisma.js";
import { printSql } from "../generate/sql.js";
import { GENERATE_HELP } from "../help/generate.js";
import type { GenerateJson } from "../json.js";
import { printJson } from "../output.js";
import { SCHEMA_VERSION } from "../version.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  format: { type: "string" },
  dialect: { type: "string" },
  out: { type: "string" },
} as const;

const PRINTERS: Readonly<Record<GenerateFormat, typeof printSql>> = {
  sql: printSql,
  drizzle: printDrizzle,
  prisma: printPrisma,
};

/**
 * `authtempo generate --format <format> --dialect <dialect> [--out <file>]`
 * (plan 12g Task 7). It prints the schema of core in one format. The text
 * comes from the schema object and from the migration lists of the bundled
 * adapters only. The command reads no database, no config, no variable, and
 * no network, so no output can hold a secret.
 */
export const generateCommand: Command = {
  help: GENERATE_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    const { values: v, positionals } = parseOrUsage(
      () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
      Object.keys(OPTIONS),
    );
    if (positionals.length > 0) throw new UsageError(`unexpected argument ${positionals[0]}`);
    if (v.dialect === "d1")
      throw new UsageError(
        "--dialect d1: use --dialect sqlite; a D1 app applies the files of @authtempo/adapter-d1 with wrangler",
      );
    const format = oneOf("format", v.format, FORMATS);
    const dialect = oneOf("dialect", v.dialect, DIALECTS);
    if (format === undefined)
      throw new UsageError("name a format: --format sql, drizzle, or prisma");
    if (dialect === undefined)
      throw new UsageError("name a dialect: --dialect sqlite, postgres, or mysql");
    const text = PRINTERS[format](dialect);
    const json = v.json === true;
    const out = v.out === undefined ? null : resolve(ctx.cwd, v.out);
    if (out !== null) {
      if (ctx.exists(out)) throw new Stop(`generate writes no file over a file; ${out} exists`);
      ctx.writeNew(out, text);
      ctx.err(`wrote ${out}`);
    } else if (!json) for (const line of text.replace(/\n$/, "").split("\n")) ctx.out(line);
    if (json)
      printJson(ctx, {
        format,
        dialect,
        schemaVersion: SCHEMA_VERSION,
        out,
        text: out === null ? text : null,
        exit: 0,
        stopped: null,
      } satisfies GenerateJson);
    return 0;
  },
};
