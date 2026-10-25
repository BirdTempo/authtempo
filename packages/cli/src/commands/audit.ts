import { parseArgs } from "node:util";
import { COMMON_OPTIONS, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { AUDIT_HELP, AUDIT_LIST_HELP } from "../help/audit.js";
import type { AuditListJson } from "../json.js";
import { readOperatorSecret } from "../operator-client.js";
import {
  AUDIT_HEADER,
  auditLine,
  auditPage,
  noExtra,
  pageRule,
  pagesExit,
  readPages,
  TOOL_OPTIONS,
  tableLines,
  toolTarget,
} from "../operator-tools.js";
import { type Ctx, printJson } from "../output.js";
import { runGroup } from "./users.js";

const LIST_OPTIONS = {
  ...TOOL_OPTIONS,
  user: { type: "string" },
  after: { type: "string" },
  limit: { type: "string" },
  all: { type: "boolean" },
  "max-calls": { type: "string" },
} as const;

/**
 * `authtempo audit list <base url>` (plan 12f Task 12, spec 26 item 8).
 * It prints the audit rows by id, one page. With `--all` it reads every
 * page until `next` is null, up to `--max-calls`. A row names a secret by
 * its name, never by the secret.
 */
async function runList(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseOrUsage(
    () => parseArgs({ args: argv, options: LIST_OPTIONS, allowPositionals: true, strict: true }),
    Object.keys(LIST_OPTIONS),
  );
  const [target, ...extra] = positionals;
  noExtra(extra, "the base URL");
  const t = toolTarget(target, values);
  const rule = pageRule(values);
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/audit";
  ctx.err(`reading ${t.base}${t.basePath}${path}`);
  const read = await readPages(
    ctx,
    { ...t, secret },
    {
      path,
      method: "GET",
      query: values.user === undefined ? {} : { targetUserId: values.user },
      scope: "audit",
      invalid: "--user and --after are ids of at most 64 characters",
    },
    values,
    rule,
    auditPage,
    "audit rows",
  );
  const exit = pagesExit(ctx, read, rule, "rows");
  if (values.json === true) {
    printJson(ctx, {
      rows: read.rows,
      next: read.next,
      exit,
      stopped: read.stopped,
    } satisfies AuditListJson);
    return exit;
  }
  for (const line of tableLines(AUDIT_HEADER, read.rows.map(auditLine))) ctx.out(line);
  if (exit === 0 && read.next !== null)
    ctx.err(`more rows after ${read.next}: give --after ${read.next}, or give --all`);
  return exit;
}

/** `authtempo audit` (plan 12f Task 12): the audit read through `Command.subcommands`, with one subcommand. */
export const auditCommand: Command = {
  help: AUDIT_HELP,
  options: COMMON_OPTIONS,
  subcommands: { list: { help: AUDIT_LIST_HELP, options: LIST_OPTIONS } },
  run: (argv, ctx) => runGroup("audit", argv, ctx, { list: runList }),
};
