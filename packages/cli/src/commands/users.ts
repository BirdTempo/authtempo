import { parseArgs } from "node:util";
import { COMMON_OPTIONS, nearest, oneOf, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import {
  CREATE_INVALID,
  PROOF_DAYS,
  UPDATE_INVALID,
  USERS_BAN_HELP,
  USERS_CREATE_HELP,
  USERS_DELETE_HELP,
  USERS_GET_HELP,
  USERS_HELP,
  USERS_LIST_HELP,
  USERS_PLATFORM_ROLE_HELP,
  USERS_SEARCH_HELP,
  USERS_SECOND_FACTOR_OFF_HELP,
  USERS_UNBAN_HELP,
  USERS_UPDATE_HELP,
} from "../help/users.js";
import type {
  OperatorWriteJson,
  UserCreateJson,
  UserDeleteJson,
  UserJson,
  UsersListJson,
  UserUpdateJson,
} from "../json.js";
import { type OperatorScope, readOperatorSecret } from "../operator-client.js";
import {
  ask,
  askTyped,
  auditIdOf,
  bannedText,
  CREATE_LIMITS,
  DELETE_LIMITS,
  familyEndWarning,
  needYes,
  operatorUser,
  type PageRule,
  type PageValues,
  PROOF_METHODS,
  pageRule,
  pagesExit,
  readPages,
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
  writtenLine,
} from "../operator-tools.js";
import { type Ctx, printJson } from "../output.js";

const PAGE_OPTIONS = {
  after: { type: "string" },
  limit: { type: "string" },
  all: { type: "boolean" },
  "max-calls": { type: "string" },
} as const;

/** The text after `invalid_body` of each user read. Each text names the flags of its own command only. */
const LIST_INVALID = "--after is an id of at most 64 characters, from the page before";
const SEARCH_INVALID =
  "--email-prefix is 3 to 254 characters after the address rule, and --after is an id of the page before";

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
const CREATE_OPTIONS = {
  ...WRITE_OPTIONS,
  email: { type: "string" },
  phone: { type: "string" },
  name: { type: "string" },
  image: { type: "string" },
  verified: { type: "boolean" },
  "first-sign-in": { type: "string" },
} as const;
const UPDATE_OPTIONS = {
  ...WRITE_OPTIONS,
  name: { type: "string" },
  "no-name": { type: "boolean" },
  image: { type: "string" },
  "no-image": { type: "boolean" },
} as const;
const DELETE_OPTIONS = WRITE_OPTIONS;

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
 * The pages of a user read through `readPages`, then the table or the JSON
 * document. A stop after the first page prints the users read before it.
 */
async function listUsers(
  ctx: Ctx,
  t: ToolTarget & { secret: string },
  path: string,
  query: Record<string, string>,
  values: PageValues & { json?: boolean | undefined },
  rule: PageRule,
  invalid: string,
): Promise<number> {
  const read = await readPages(
    ctx,
    t,
    { path, method: "GET", query, scope: "users", invalid },
    values,
    rule,
    (body) => {
      const page = usersPage(body);
      return page === null ? null : { rows: page.users, next: page.next };
    },
    "user list",
  );
  const exit = pagesExit(ctx, read, rule, "users");
  if (values.json === true) {
    printJson(ctx, {
      users: read.rows,
      next: read.next,
      exit,
      stopped: read.stopped,
    } satisfies UsersListJson);
    return exit;
  }
  for (const line of tableLines(USER_HEADER, read.rows.map(userRow))) ctx.out(line);
  if (exit === 0 && read.next !== null)
    ctx.err(`more users after ${read.next}: give --after ${read.next}, or give --all`);
  return exit;
}

/** `authtempo users list <base url>` (plan 12f Task 12): the users by id. */
async function runList(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, LIST_OPTIONS);
  const t = toolTarget(onePositional(positionals), values);
  const rule = pageRule(values);
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/users";
  reading(ctx, t, path);
  return listUsers(ctx, { ...t, secret }, path, {}, values, rule, LIST_INVALID);
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
  const rule = pageRule(values);
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/users/search";
  reading(ctx, t, path);
  const query = Object.fromEntries(keys);
  return listUsers(ctx, { ...t, secret }, path, query, values, rule, SEARCH_INVALID);
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

/** One write on one user: its route, its body, and its question. */
interface UserPost {
  /** The words of the command, such as `users ban`, for the usage error of the confirmation rule. */
  command: string;
  path: string;
  body: Record<string, unknown>;
  question: string;
  /** What did not happen on a no: `no <act>: the answer was not yes`. */
  act: string;
  invalid?: string;
  /** The scope of the route. The default is `users`. */
  scope?: OperatorScope;
  /** True for an act that cannot be undone: the question needs the typed user id, not a yes. */
  typed?: boolean;
  /** The 429 text of a route with a limit beside the limit per IP. */
  limits?: string;
}

/** A write on one user with one result line, then the audit row id. */
interface UserWrite extends UserPost {
  done: string;
}

/** The flags of a write that `postUser` reads. */
interface WriteValues {
  json?: boolean | undefined;
  yes?: boolean | undefined;
  "no-input"?: boolean | undefined;
  "token-file"?: string | undefined;
  "token-env"?: string | undefined;
  "base-path"?: string | undefined;
  timeout?: string | undefined;
}

/**
 * The common steps of a write on one user. First the confirmation rule,
 * before the secret. Then the secret, the question, and one POST. It
 * answers the body of the answer and the request line, for the stop text
 * of a body with no audit row id.
 */
async function postUser(
  ctx: Ctx,
  values: WriteValues,
  t: ToolTarget,
  userId: string,
  w: UserPost,
): Promise<{ body: unknown; request: string }> {
  needYes(ctx, values, w.command);
  const secret = readOperatorSecret(ctx, values);
  ctx.err(`posting ${t.base}${t.basePath}${w.path}`);
  if (w.typed === true) await askTyped(ctx, values, w.question, userId, w.act);
  else await ask(ctx, values, w.question, w.act);
  const body = await toolCall(
    ctx,
    { ...t, secret },
    {
      path: w.path,
      method: "POST",
      body: { userId, ...w.body },
      scope: w.scope ?? "users",
      userId,
      ...(w.invalid === undefined ? {} : { invalid: w.invalid }),
      ...(w.limits === undefined ? {} : { limits: w.limits }),
    },
  );
  return { body, request: `POST ${t.base}${t.basePath}${w.path}` };
}

/**
 * A write on one user with `postUser`. Last the audit row id, on stdout or
 * in the JSON document. An answer with `familyEndFailed: true` adds the
 * warning and exit 1, so a script sees it.
 */
async function writeUser(
  ctx: Ctx,
  values: WriteValues,
  t: ToolTarget,
  userId: string,
  w: UserWrite,
): Promise<number> {
  const { body, request } = await postUser(ctx, values, t, userId, w);
  const auditId = auditIdOf(body, request);
  const exit = (body as { familyEndFailed?: unknown }).familyEndFailed === true ? 1 : 0;
  if (values.json === true)
    printJson(ctx, { auditId, exit, stopped: null } satisfies OperatorWriteJson);
  else ctx.out(writtenLine(w.done, auditId));
  if (exit === 1) ctx.err(familyEndWarning(userId));
  return exit;
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
    question: `Ban the user ${userId}, and end the sessions of the user?`,
    act: "ban",
    done: bannedText(userId),
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
      : `Revoke the platform role of the user ${userId}, and end the sessions of the user?`,
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
    invalid: `--proof-checked-at must be a date and time with a zone, at most ${PROOF_DAYS} days old, and not later than the clock of the deployment`,
  });
}

/** The first sign-in of a user with an address (plan 12f2 Task 2). */
const FIRST_SIGN_INS = ["invite", "reset", "none"] as const;

/** The first sign-in of a create, or `phone` for a user with no address. */
type CreateKind = (typeof FIRST_SIGN_INS)[number] | "phone";

/** The question of a create. It names no address and no phone number. */
const CREATE_QUESTIONS: Readonly<Record<CreateKind, string>> = {
  invite: "Create a user, and mail the invitation link to the address?",
  reset: "Create a user, and mail a reset link to the address?",
  none: "Create a user with the address, and mail nothing?",
  phone: "Create a user with the phone number? No SMS goes out now.",
};

/** The last stderr line of a create: how the person signs in first. */
const CREATE_NEXT: Readonly<Record<CreateKind, string>> = {
  invite: "Next: the person signs in with the mailed link.",
  reset: "Next: the person sets a password with the mailed reset link.",
  none: "Next: the person signs in by any proof of the address.",
  phone: "Next: the person signs in with a phone code.",
};

/** The warning of a create that answers `mailed: null` for a link: core keeps the user. */
const CREATE_MAIL_WARNING =
  "warning: the user exists, but the mail of the link failed; read operator.create_mail_failed in the log of the deployment. The person can sign in by any other proof of the address.";

/**
 * `authtempo users create <base url>` (plan 12f2 Task 6, spec 26): a user
 * for a person, with an address or with a phone number only. The CLI
 * checks each flag rule that it can before any request, so a wrong run
 * costs none of the creates of the actor. Core mails the invitation or
 * the reset link to the person; the answer holds no token and no link.
 * stdout holds the user id only, so a script can read it. No line holds
 * the address or the phone number.
 */
async function runCreate(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, CREATE_OPTIONS);
  const t = toolTarget(onePositional(positionals), values);
  const { email, phone } = values;
  if ((email === undefined) === (phone === undefined))
    throw new UsageError("give exactly one of --email and --phone");
  const first = oneOf("first-sign-in", values["first-sign-in"], FIRST_SIGN_INS);
  // Core refuses each of these with invalid_body: a user with no address has no link to open.
  if (phone !== undefined && (values.verified === true || (first ?? "none") !== "none"))
    throw new UsageError(
      "--verified and --first-sign-in invite or reset need --email: a user with no address signs in with a phone code",
    );
  const reason = reasonOf(values.reason);
  // Core's default first sign-in is invite for a user with an address.
  const kind: CreateKind = phone !== undefined ? "phone" : (first ?? "invite");
  const body = {
    // The address is required and may be null: a phone user states it on purpose.
    email: email ?? null,
    ...(phone === undefined ? {} : { phone }),
    ...(values.verified === true ? { emailVerified: true } : {}),
    ...(values.name === undefined ? {} : { name: values.name }),
    ...(values.image === undefined ? {} : { image: values.image }),
    ...(first === undefined ? {} : { firstSignIn: first }),
    reason,
  };
  needYes(ctx, values, "users create");
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/users/create";
  const request = `POST ${t.base}${t.basePath}${path}`;
  ctx.err(`posting ${t.base}${t.basePath}${path}`);
  await ask(ctx, values, CREATE_QUESTIONS[kind], "create");
  // No user id: a 404 means that the tools are off.
  const answer = await toolCall(
    ctx,
    { ...t, secret },
    { path, method: "POST", body, scope: "users", invalid: CREATE_INVALID, limits: CREATE_LIMITS },
  );
  const auditId = auditIdOf(answer, request);
  const { userId, mailed } = answer as { userId?: unknown; mailed?: unknown };
  if (typeof userId !== "string" || !(mailed === null || mailed === "invite" || mailed === "reset"))
    throw new Stop(`${request} answered 200 with no user id`);
  // A link that core did not mail: the user exists, so exit 1 and a warning, not a stop.
  const exit = (kind === "invite" || kind === "reset") && mailed === null ? 1 : 0;
  if (values.json === true)
    printJson(ctx, { userId, mailed, auditId, exit, stopped: null } satisfies UserCreateJson);
  else ctx.out(userId);
  ctx.err(writtenLine(`created the user ${userId}`, auditId));
  ctx.err(exit === 1 ? CREATE_MAIL_WARNING : CREATE_NEXT[kind]);
  return exit;
}

/** The fields of an update in words, such as `the name and the image`. */
function fieldWords(fields: readonly string[]): string {
  return fields.map((f) => `the ${f}`).join(" and ");
}

/**
 * `authtempo users update <base url> <user id>` (plan 12f2 Task 6, spec 26):
 * the name or the image of a user, or both. A `--no-` flag sends null, so
 * the field goes. No flag sends an address or a password: the route
 * refuses each other key.
 */
async function runUpdate(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, UPDATE_OPTIONS);
  const [target, id, ...extra] = positionals;
  const t = toolTarget(target, values);
  const userId = userIdOf(id, extra);
  const body: { name?: string | null; image?: string | null } = {};
  for (const field of ["name", "image"] as const) {
    const value = values[field];
    const none = values[`no-${field}`] === true;
    if (value !== undefined && none)
      throw new UsageError(`give one of --${field} and --no-${field}`);
    if (value !== undefined) body[field] = value;
    else if (none) body[field] = null;
  }
  const fields = Object.keys(body);
  if (fields.length === 0)
    throw new UsageError("give at least one of --name, --no-name, --image, and --no-image");
  const reason = reasonOf(values.reason);
  const { body: answer, request } = await postUser(ctx, values, t, userId, {
    command: "users update",
    path: "/operator/users/update",
    body: { ...body, reason },
    question: `Change ${fieldWords(fields)} of the user ${userId}?`,
    act: "change",
    invalid: UPDATE_INVALID,
  });
  const auditId = auditIdOf(answer, request);
  const user = operatorUser((answer as { user?: unknown }).user);
  if (user === null) throw new Stop(`${request} answered 200 with no user`);
  if (values.json === true)
    printJson(ctx, { user, auditId, exit: 0, stopped: null } satisfies UserUpdateJson);
  else ctx.out(writtenLine(`changed ${fieldWords(fields)} of ${userId}`, auditId));
  return 0;
}

/**
 * `authtempo users delete <base url> <user id>` (plan 12f2 Task 6, spec 26
 * and 8.15). The act cannot be undone, so the question asks for the typed
 * user id, not a yes. The secret needs the `delete` scope. The organizations
 * that the user alone held go with the account; the command prints each id.
 */
async function runDelete(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parse(argv, DELETE_OPTIONS);
  const [target, id, ...extra] = positionals;
  const t = toolTarget(target, values);
  const userId = userIdOf(id, extra);
  const reason = reasonOf(values.reason);
  const { body, request } = await postUser(ctx, values, t, userId, {
    command: "users delete",
    path: "/operator/users/delete",
    body: { reason },
    question: `Delete the account ${userId}? This cannot be undone. Type the user id to confirm:`,
    act: "delete",
    scope: "delete",
    typed: true,
    limits: DELETE_LIMITS,
  });
  const auditId = auditIdOf(body, request);
  const organizations = (body as { organizations?: unknown }).organizations;
  if (!Array.isArray(organizations) || !organizations.every((o) => typeof o === "string"))
    throw new Stop(`${request} answered 200 with no list of organizations`);
  if (values.json === true)
    printJson(ctx, { organizations, auditId, exit: 0, stopped: null } satisfies UserDeleteJson);
  else {
    ctx.out(writtenLine(`deleted ${userId}`, auditId));
    for (const org of organizations) ctx.out(`deleted the organization ${org}`);
  }
  return 0;
}

const SUBCOMMANDS: Readonly<Record<string, (argv: string[], ctx: Ctx) => Promise<number>>> = {
  list: runList,
  search: runSearch,
  get: runGet,
  ban: runBan,
  unban: runUnban,
  "platform-role": runPlatformRole,
  "second-factor-off": runFactorOff,
  create: runCreate,
  update: runUpdate,
  delete: runDelete,
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
    create: { help: USERS_CREATE_HELP, options: CREATE_OPTIONS },
    update: { help: USERS_UPDATE_HELP, options: UPDATE_OPTIONS },
    delete: { help: USERS_DELETE_HELP, options: DELETE_OPTIONS },
  },
  run: (argv, ctx) => runGroup("users", argv, ctx, SUBCOMMANDS),
};

/**
 * The run of a command with subcommands: the first word chooses one. With
 * no word, or a flag first, the parser of the command's own flags runs. So
 * an unknown flag gets its usage error. Then the run names the subcommands.
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
