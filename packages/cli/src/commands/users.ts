import { parseArgs } from "node:util";
import { COMMON_OPTIONS, nearest, oneOf, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import {
  USERS_BAN_HELP,
  USERS_GET_HELP,
  USERS_HELP,
  USERS_LIST_HELP,
  USERS_PLATFORM_ROLE_HELP,
  USERS_SEARCH_HELP,
  USERS_SECOND_FACTOR_OFF_HELP,
  USERS_UNBAN_HELP,
} from "../help/users.js";
import type { OperatorUserJson, OperatorWriteJson, UserJson, UsersListJson } from "../json.js";
import { readOperatorSecret } from "../operator-client.js";
import {
  ask,
  auditIdOf,
  countOf,
  needYes,
  operatorUser,
  PAGE_MAX,
  PROOF_METHODS,
  reasonOf,
  TOOL_OPTIONS,
  type ToolTarget,
  tableLines,
  toolCall,
  toolTarget,
  USER_HEADER,
  userIdOf,
  userRow,
  usersPage,
  WRITE_OPTIONS,
} from "../operator-tools.js";
import { type Ctx, printJson } from "../output.js";

const PAGE_OPTIONS = {
  after: { type: "string" },
  limit: { type: "string" },
  all: { type: "boolean" },
} as const;

const LIST_OPTIONS = { ...TOOL_OPTIONS, ...PAGE_OPTIONS } as const;
const SEARCH_OPTIONS = {
  ...TOOL_OPTIONS,
  email: { type: "string" },
  "email-prefix": { type: "string" },
  id: { type: "string" },
  ...PAGE_OPTIONS,
} as const;
const GET_OPTIONS = TOOL_OPTIONS;
const BAN_OPTIONS = { ...WRITE_OPTIONS, until: { type: "string" } } as const;
const UNBAN_OPTIONS = WRITE_OPTIONS;
const ROLE_OPTIONS = {
  ...WRITE_OPTIONS,
  grant: { type: "boolean" },
  revoke: { type: "boolean" },
} as const;
const FACTOR_OPTIONS = {
  ...WRITE_OPTIONS,
  "proof-method": { type: "string" },
  "proof-reference": { type: "string" },
  "proof-checked-at": { type: "string" },
} as const;

type Options = Command["options"];

/** The parsed flags and positionals of one subcommand, with its usage errors. */
function parse<O extends Options>(argv: string[], options: O) {
  return parseOrUsage(
    () => parseArgs({ args: argv, options, allowPositionals: true, strict: true }),
    Object.keys(options),
  );
}

/** The base URL of a read: the one positional. */
function onePositional(positionals: readonly string[]): string | undefined {
  const [target, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
  return target;
}

/** The reading line of a call: the URL with no query, so no address reaches stderr. */
function reading(ctx: Ctx, t: ToolTarget, path: string): void {
  ctx.err(`reading ${t.base}${t.basePath}${path}`);
}

/**
 * The pages of a user read: one page, or with `--all` every page until
 * `next` is null. Each page goes through `toolCall`, so each call counts
 * on the limiter of 600 calls an hour.
 */
async function readUsers(
  ctx: Ctx,
  t: ToolTarget & { secret: string },
  path: string,
  query: Record<string, string>,
  values: { after?: string | undefined; limit?: string | undefined; all?: boolean | undefined },
): Promise<{ users: OperatorUserJson[]; next: string | null }> {
  const limit = countOf("limit", values.limit, PAGE_MAX);
  const users: OperatorUserJson[] = [];
  let after = values.after ?? null;
  for (;;) {
    const body = await toolCall(ctx, t, {
      path,
      method: "GET",
      query: {
        ...query,
        ...(after === null ? {} : { after }),
        ...(limit === undefined ? {} : { limit: String(limit) }),
      },
      scope: "users",
      invalid:
        "--email-prefix is 3 to 254 characters after the address rule, and --after is an id of the page before",
    });
    const page = usersPage(body);
    if (page === null)
      throw new Stop(`GET ${t.base}${t.basePath}${path} answered 200 with no user list`);
    users.push(...page.users);
    if (values.all !== true || page.next === null) return { users, next: page.next };
    after = page.next;
  }
}

/** The users as a table on stdout, or as one JSON document. A next page is a stderr line. */
function printUsers(
  ctx: Ctx,
  json: boolean,
  page: { users: OperatorUserJson[]; next: string | null },
) {
  if (json) {
    printJson(ctx, { ...page, exit: 0, stopped: null } satisfies UsersListJson);
    return;
  }
  for (const line of tableLines(USER_HEADER, page.users.map(userRow))) ctx.out(line);
  if (page.next !== null)
    ctx.err(`more users after ${page.next}: give --after ${page.next}, or give --all`);
}

/** `authtempo users list <base url>` (plan 12f Task 12): the users by id. */
async function runList(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, LIST_OPTIONS);
  const t = toolTarget(onePositional(positionals), values);
  countOf("limit", values.limit, PAGE_MAX);
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/users";
  reading(ctx, t, path);
  printUsers(ctx, values.json === true, await readUsers(ctx, { ...t, secret }, path, {}, values));
  return 0;
}

/**
 * `authtempo users search <base url>` (plan 12f Task 12): by exactly one
 * of an address, an address prefix, and an id. The address goes in the
 * query only, and the answer to stdout only: no stderr line names it.
 */
async function runSearch(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, SEARCH_OPTIONS);
  const t = toolTarget(onePositional(positionals), values);
  const keys = [
    ["email", values.email],
    ["emailPrefix", values["email-prefix"]],
    ["id", values.id],
  ].filter((k): k is [string, string] => k[1] !== undefined);
  if (keys.length !== 1)
    throw new UsageError("give exactly one of --email, --email-prefix, and --id");
  countOf("limit", values.limit, PAGE_MAX);
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/users/search";
  reading(ctx, t, path);
  const page = await readUsers(ctx, { ...t, secret }, path, Object.fromEntries(keys), values);
  printUsers(ctx, values.json === true, page);
  return 0;
}

/** `authtempo users get <base url> <user id>` (plan 12f Task 12): one user. */
async function runGet(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, GET_OPTIONS);
  const [target, id, ...extra] = positionals;
  const t = toolTarget(target, values);
  const userId = userIdOf(id, extra);
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/users/get";
  reading(ctx, t, path);
  const body = await toolCall(
    ctx,
    { ...t, secret },
    { path, method: "GET", query: { userId }, scope: "users", userId },
  );
  const user = operatorUser((body as { user?: unknown } | null)?.user);
  if (user === null) throw new Stop(`GET ${t.base}${t.basePath}${path} answered 200 with no user`);
  if (values.json === true) printJson(ctx, { user, exit: 0, stopped: null } satisfies UserJson);
  else for (const line of tableLines(USER_HEADER, [userRow(user)])) ctx.out(line);
  return 0;
}

/** One write on one user: its route, its body, its question, and its result line. */
interface UserWrite {
  /** The words of the command, such as `users ban`, for the usage error of the confirmation rule. */
  command: string;
  path: string;
  body: Record<string, unknown>;
  question: string;
  /** What did not happen on a no: `no <act>: the answer was not yes`. */
  act: string;
  /** The result line, with the audit row id after it. */
  done: string;
  invalid?: string;
}

/**
 * The common steps of a write on one user: the confirmation rule before
 * the secret, the secret, the question, one POST, and the audit row id on
 * stdout or in the JSON document.
 */
async function writeUser(
  ctx: Ctx,
  values: {
    json?: boolean | undefined;
    yes?: boolean | undefined;
    "no-input"?: boolean | undefined;
    "token-file"?: string | undefined;
    "token-env"?: string | undefined;
    "base-path"?: string | undefined;
    timeout?: string | undefined;
  },
  t: ToolTarget,
  userId: string,
  w: UserWrite,
): Promise<number> {
  needYes(ctx, values, w.command);
  const secret = readOperatorSecret(ctx, values);
  ctx.err(`posting ${t.base}${t.basePath}${w.path}`);
  await ask(ctx, values, w.question, w.act);
  const body = await toolCall(
    ctx,
    { ...t, secret },
    {
      path: w.path,
      method: "POST",
      body: { userId, ...w.body },
      scope: "users",
      userId,
      ...(w.invalid === undefined ? {} : { invalid: w.invalid }),
    },
  );
  const auditId = auditIdOf(body, `POST ${t.base}${t.basePath}${w.path}`);
  if (values.json === true)
    printJson(ctx, { auditId, exit: 0, stopped: null } satisfies OperatorWriteJson);
  else ctx.out(`${w.done}; audit row ${auditId}`);
  return 0;
}

/** `authtempo users ban <base url> <user id>` (plan 12f Task 12, spec 26 items 5 and 6). */
async function runBan(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, BAN_OPTIONS);
  const [target, id, ...extra] = positionals;
  const t = toolTarget(target, values);
  const userId = userIdOf(id, extra);
  const reason = reasonOf(values.reason);
  return writeUser(ctx, values, t, userId, {
    command: "users ban",
    path: "/operator/users/ban",
    body: { reason, ...(values.until === undefined ? {} : { until: values.until }) },
    question: `Ban the user ${userId}, and end every session of the user?`,
    act: "ban",
    done: `banned ${userId}`,
    invalid: "--until must be a date and time with a zone, from 1 minute to 3650 days after now",
  });
}

/** `authtempo users unban <base url> <user id>` (plan 12f Task 12). */
async function runUnban(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, UNBAN_OPTIONS);
  const [target, id, ...extra] = positionals;
  const t = toolTarget(target, values);
  const userId = userIdOf(id, extra);
  const reason = reasonOf(values.reason);
  return writeUser(ctx, values, t, userId, {
    command: "users unban",
    path: "/operator/users/unban",
    body: { reason },
    question: `Lift the ban of the user ${userId}?`,
    act: "unban",
    done: `unbanned ${userId}`,
  });
}

/** `authtempo users platform-role <base url> <user id> --grant | --revoke` (plan 12f Task 12). */
async function runPlatformRole(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, ROLE_OPTIONS);
  const [target, id, ...extra] = positionals;
  const t = toolTarget(target, values);
  const userId = userIdOf(id, extra);
  if ((values.grant === true) === (values.revoke === true))
    throw new UsageError("give exactly one of --grant and --revoke");
  const grant = values.grant === true;
  const reason = reasonOf(values.reason);
  return writeUser(ctx, values, t, userId, {
    command: "users platform-role",
    path: "/operator/users/platform-role",
    body: { grant, reason },
    question: grant
      ? `Grant the platform role to the user ${userId}?`
      : `Revoke the platform role of the user ${userId}, and end every session of the user?`,
    act: grant ? "grant" : "revoke",
    done: grant
      ? `granted the platform role to ${userId}`
      : `revoked the platform role of ${userId}`,
  });
}

/**
 * `authtempo users second-factor-off <base url> <user id>` (plan 12f Task
 * 12, ASVS 5.0.0 6.4.4): the disable after a check of the identity. The
 * deployment reads `--proof-checked-at` against its own clock, so a time
 * from a clock ahead of it answers `invalid_body` (ruling 32 of plan 12f).
 */
async function runFactorOff(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, FACTOR_OPTIONS);
  const [target, id, ...extra] = positionals;
  const t = toolTarget(target, values);
  const userId = userIdOf(id, extra);
  const reason = reasonOf(values.reason);
  const method = oneOf("proof-method", values["proof-method"], PROOF_METHODS);
  const reference = values["proof-reference"];
  const checkedAt = values["proof-checked-at"];
  if (method === undefined || reference === undefined || checkedAt === undefined)
    throw new UsageError(
      "give --proof-method, --proof-reference, and --proof-checked-at: the proof of the identity check",
    );
  return writeUser(ctx, values, t, userId, {
    command: "users second-factor-off",
    path: "/operator/users/second-factor/disable",
    body: { reason, proof: { method, reference, checkedAt } },
    question: `Turn every second factor of the user ${userId} off?`,
    act: "change",
    done: `turned the second factor of ${userId} off`,
    invalid:
      "--proof-checked-at must be a date and time with a zone, at most 7 days old, and not later than the clock of the deployment",
  });
}

const SUBCOMMANDS: Readonly<Record<string, (argv: string[], ctx: Ctx) => Promise<number>>> = {
  list: runList,
  search: runSearch,
  get: runGet,
  ban: runBan,
  unban: runUnban,
  "platform-role": runPlatformRole,
  "second-factor-off": runFactorOff,
};

/**
 * `authtempo users` (plan 12f Task 12, spec 26 item 11): the user tools
 * through `Command.subcommands` of 11c2. The first word chooses the
 * subcommand; no word or another word is a usage error.
 */
export const usersCommand: Command = {
  help: USERS_HELP,
  options: COMMON_OPTIONS,
  subcommands: {
    list: { help: USERS_LIST_HELP, options: LIST_OPTIONS },
    search: { help: USERS_SEARCH_HELP, options: SEARCH_OPTIONS },
    get: { help: USERS_GET_HELP, options: GET_OPTIONS },
    ban: { help: USERS_BAN_HELP, options: BAN_OPTIONS },
    unban: { help: USERS_UNBAN_HELP, options: UNBAN_OPTIONS },
    "platform-role": { help: USERS_PLATFORM_ROLE_HELP, options: ROLE_OPTIONS },
    "second-factor-off": { help: USERS_SECOND_FACTOR_OFF_HELP, options: FACTOR_OPTIONS },
  },
  run: (argv, ctx) => runGroup("users", argv, ctx, SUBCOMMANDS),
};

/**
 * The run of a command with subcommands: the first word chooses one. With
 * no word, or a flag first, the parser of the command's own flags runs, so
 * an unknown flag gets its usage error; then the run names the subcommands.
 */
export async function runGroup(
  name: string,
  argv: string[],
  ctx: Ctx,
  subs: Readonly<Record<string, (argv: string[], ctx: Ctx) => Promise<number>>>,
): Promise<number> {
  const [first, ...rest] = argv;
  const sub = first !== undefined && Object.hasOwn(subs, first) ? subs[first] : undefined;
  if (sub) return sub(rest, ctx);
  if (first === undefined || first.startsWith("-")) {
    parseOrUsage(
      () =>
        parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true, strict: true }),
      Object.keys(COMMON_OPTIONS),
    );
    throw new UsageError(subcommandError(name, undefined, Object.keys(subs)));
  }
  throw new UsageError(subcommandError(name, first, Object.keys(subs)));
}

/** The usage error of a command with subcommands: no word, or a word one edit from a subcommand. */
export function subcommandError(name: string, word: string | undefined, subs: readonly string[]) {
  const list =
    subs.length === 1 ? (subs[0] ?? "") : `${subs.slice(0, -1).join(", ")}, and ${subs.at(-1)}`;
  if (word === undefined) return `name a subcommand of ${name}: ${list}`;
  const near = nearest(word, subs);
  return near
    ? `${name} has no subcommand ${word}. Did you mean ${near}?`
    : `${name} has no subcommand ${word}; it has ${list}`;
}
