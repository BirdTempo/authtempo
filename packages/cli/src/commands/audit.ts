import { parseArgs } from "node:util";
import { COMMON_OPTIONS, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { UsageError } from "../errors.js";
import { AUDIT_EXPORT_HELP, AUDIT_HELP, AUDIT_LIST_HELP, EXPORT_NOTE } from "../help/audit.js";
import type { AuditListJson } from "../json.js";
import { readOperatorSecret } from "../operator-client.js";
import {
  AUDIT_CSV_COLUMNS,
  AUDIT_HEADER,
  auditCsvRecord,
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

/**
 * The flags of `audit export`: the flags of `audit list` but `--user`,
 * `--all`, and `--json`. The export reads each page. Stdout holds the
 * export, so a JSON document there would break the file.
 */
const EXPORT_OPTIONS = {
  help: COMMON_OPTIONS.help,
  "base-path": TOOL_OPTIONS["base-path"],
  "token-env": TOOL_OPTIONS["token-env"],
  "token-file": TOOL_OPTIONS["token-file"],
  timeout: TOOL_OPTIONS.timeout,
  organization: { type: "string" },
  format: { type: "string" },
  after: { type: "string" },
  limit: { type: "string" },
  "max-calls": { type: "string" },
} as const;

const FORMATS = ["ndjson", "csv"] as const;

/**
 * An id that core takes: 1 to 64 characters (`operatorId` of the core
 * operator contract, which core does not export). This rule is stricter: it
 * takes visible ASCII only. When each id has this shape, the likely cause of
 * an `invalid_body` is a deployment before schema version 18: its audit query
 * has no `organizationId`. So the stop message names the schema version, not
 * an id.
 */
const ID_SHAPE = /^[\x21-\x7e]{1,64}$/;

/**
 * `authtempo audit export <base url>` (plan 13b Task 8). It reads every
 * page of `GET /operator/audit?organizationId=<id>` with the operator
 * secret (decision 3: spec 29 item 17 keeps tokens out of
 * `/organizations`), up to `--max-calls`. It writes one row per line: a
 * JSON object, or a CSV record after one header line. A CSV cell with a
 * line break spans two lines inside its quotes.
 */
async function runExport(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseOrUsage(
    () => parseArgs({ args: argv, options: EXPORT_OPTIONS, allowPositionals: true, strict: true }),
    Object.keys(EXPORT_OPTIONS),
  );
  const [target, ...extra] = positionals;
  noExtra(extra, "the base URL");
  const t = toolTarget(target, values);
  const format = FORMATS.find((f) => f === values.format);
  if (format === undefined) throw new UsageError("give --format ndjson or --format csv");
  const organizationId = values.organization;
  if (organizationId === undefined || organizationId === "")
    throw new UsageError("give --organization <id>: the export reads one organization");
  const all = { ...values, all: true };
  const rule = pageRule(all);
  const secret = readOperatorSecret(ctx, values);
  ctx.err(EXPORT_NOTE);
  const read = await readPages(
    ctx,
    { ...t, secret },
    {
      path: "/operator/audit",
      method: "GET",
      query: { organizationId },
      scope: "audit",
      invalid: [organizationId, values.after].every((id) => id === undefined || ID_SHAPE.test(id))
        ? "the deployment can be at a schema version before 18, where the organization audit starts"
        : "--organization and --after are ids of at most 64 characters",
    },
    all,
    rule,
    auditPage,
    "audit rows",
  );
  const exit = pagesExit(ctx, read, rule, "rows");
  if (format === "ndjson") for (const row of read.rows) ctx.out(JSON.stringify(row));
  else {
    ctx.out(AUDIT_CSV_COLUMNS.join(","));
    // Each output line passes the scrub, which turns a line break into "?". So a record with
    // a line break in a quoted cell goes out as two lines, and the reader joins them again.
    for (const row of read.rows) for (const line of auditCsvRecord(row).split("\n")) ctx.out(line);
  }
  return exit;
}

/** `authtempo audit` (plan 12f Task 12): the audit read through `Command.subcommands`. */
export const auditCommand: Command = {
  help: AUDIT_HELP,
  options: COMMON_OPTIONS,
  subcommands: {
    list: { help: AUDIT_LIST_HELP, options: LIST_OPTIONS },
    export: { help: AUDIT_EXPORT_HELP, options: EXPORT_OPTIONS },
  },
  run: (argv, ctx) => runGroup("audit", argv, ctx, { list: runList, export: runExport }),
};
