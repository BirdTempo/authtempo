import { parseArgs } from "node:util";
import { COMMON_OPTIONS, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { AUDIT_HELP, AUDIT_LIST_HELP } from "../help/audit.js";
import type { AuditListJson, AuditRowJson } from "../json.js";
import { readOperatorSecret } from "../operator-client.js";
import {
  AUDIT_HEADER,
  auditLine,
  auditPage,
  countOf,
  PAGE_MAX,
  TOOL_OPTIONS,
  tableLines,
  toolCall,
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
} as const;

/**
 * `authtempo audit list <base url>` (plan 12f Task 12, spec 26 item 8):
 * the audit rows by id, one page, or with `--all` every page until `next`
 * is null. A row names a secret by its name, never by the secret.
 */
async function runList(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseOrUsage(
    () => parseArgs({ args: argv, options: LIST_OPTIONS, allowPositionals: true, strict: true }),
    Object.keys(LIST_OPTIONS),
  );
  const [target, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
  const t = toolTarget(target, values);
  const limit = countOf("limit", values.limit, PAGE_MAX);
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/audit";
  ctx.err(`reading ${t.base}${t.basePath}${path}`);
  const rows: AuditRowJson[] = [];
  let after = values.after ?? null;
  let next: string | null = null;
  for (;;) {
    const body = await toolCall(
      ctx,
      { ...t, secret },
      {
        path,
        method: "GET",
        query: {
          ...(values.user === undefined ? {} : { targetUserId: values.user }),
          ...(after === null ? {} : { after }),
          ...(limit === undefined ? {} : { limit: String(limit) }),
        },
        scope: "audit",
        invalid: "--user and --after are ids of at most 64 characters",
      },
    );
    const page = auditPage(body);
    if (page === null)
      throw new Stop(`GET ${t.base}${t.basePath}${path} answered 200 with no audit rows`);
    rows.push(...page.rows);
    next = page.next;
    if (values.all !== true || next === null) break;
    after = next;
  }
  if (values.json === true) {
    printJson(ctx, { rows, next, exit: 0, stopped: null } satisfies AuditListJson);
    return 0;
  }
  for (const line of tableLines(AUDIT_HEADER, rows.map(auditLine))) ctx.out(line);
  if (next !== null) ctx.err(`more rows after ${next}: give --after ${next}, or give --all`);
  return 0;
}

/** `authtempo audit` (plan 12f Task 12): the audit read through `Command.subcommands`, with one subcommand. */
export const auditCommand: Command = {
  help: AUDIT_HELP,
  options: COMMON_OPTIONS,
  subcommands: { list: { help: AUDIT_LIST_HELP, options: LIST_OPTIONS } },
  run: (argv, ctx) => runGroup("audit", argv, ctx, { list: runList }),
};
