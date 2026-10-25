import {
  isOperatorReason,
  OPERATOR_DELETE_PER_ACTOR,
  OPERATOR_USERS_PER_IP,
  REASON_MAX,
} from "@authtempo/core/operator-secret";
import { COMMON_OPTIONS } from "./args.js";
import { Stop, UsageError } from "./errors.js";
import type { AuditRowJson, OperatorUserJson } from "./json.js";
import { baseOf, basePathOf, timeoutOf } from "./net.js";
import {
  type OperatorScope,
  OperatorStop,
  type OperatorValues,
  operatorCall,
} from "./operator-client.js";
import type { Ctx } from "./output.js";
import { DEFAULT_MAX_CALLS, MAX_CALLS_MAX } from "./rewrap-limits.js";

/**
 * The shared parts of the commands of plan 12f Task 12: `users`, `sessions`,
 * `audit`, and `create-admin`. Each one calls the user, session, and audit
 * routes of core with a named operator secret (spec 26 items 7 and 11).
 */

/** The flags of each read: the four operator flags of `keys rotate`. */
export const TOOL_OPTIONS = {
  ...COMMON_OPTIONS,
  "base-path": { type: "string" },
  "token-env": { type: "string" },
  "token-file": { type: "string" },
  timeout: { type: "string" },
} as const;

/** The flags of each write: the reason of the audit row and the confirmation rule of `keys rotate`. */
export const WRITE_OPTIONS = {
  ...TOOL_OPTIONS,
  reason: { type: "string" },
  yes: { type: "boolean" },
  "no-input": { type: "boolean" },
} as const;

/**
 * The limit of every secret call to these routes: 600 per IP per hour
 * (spec 26 item 12). Core's limiter reads the same value, so the 429 text
 * and the help print the number that core counts.
 */
export const TOOL_CALLS_PER_HOUR = OPERATOR_USERS_PER_IP.max;

/**
 * The deletes of one actor in an hour: 100 (plan 12f2 Task 5, ruling 7).
 * Core's limiter reads the same value. Each call counts, also a refused one.
 */
export const DELETES_PER_HOUR = OPERATOR_DELETE_PER_ACTOR.max;

/** The 429 text of `users delete`: the route counts each IP and each actor. */
export const DELETE_LIMITS = `the operator routes allow ${TOOL_CALLS_PER_HOUR} calls per IP per hour, and ${DELETES_PER_HOUR} deletes per actor per hour`;

// The reason rule and the proof rules come from core (ruling 40 of plan 12f): one source.
export {
  PROOF_MAX_AGE_MS,
  PROOF_METHODS,
  REASON_MAX,
  REFERENCE_MAX,
} from "@authtempo/core/operator-secret";

/** The largest page of a read (the route contract: 1 to 100). */
export const PAGE_MAX = 100;

/** The largest page of `sessions end-all` (the route contract: 1 to 1000, default 500). */
export const END_ALL_MAX = 1000;

/**
 * The reason rule of core's `isOperatorReason` in words. The CLI error, the
 * help, and each docs copy say it, and a site test holds each copy to it
 * (ruling 65 of plan 12f). The words state the class of `hasRefusedChar`
 * exactly (ruling 66). It refuses Cc, Cs, Zl, Zp, and each Cf but U+200C and
 * U+200D. So a space and U+00A0 (Zs) pass. The length counts UTF-16 code units.
 */
export const REASON_RULE = `1 to ${REASON_MAX} UTF-16 code units with no control character, line or paragraph separator, lone surrogate, or format character except U+200C and U+200D`;

/**
 * Why core refuses a reason, or null. The rule is core's own
 * `isOperatorReason`, so the CLI and the engine cannot drift. The CLI
 * checks before any request, so a bad reason costs none of the 600 calls.
 */
export function reasonProblem(reason: string): string | null {
  if (isOperatorReason(reason)) return null;
  return `--reason is ${REASON_RULE}`;
}

/** The reason of a write, or a usage error. Each write needs one: core writes it in the audit row. */
export function reasonOf(value: string | undefined): string {
  if (value === undefined)
    throw new UsageError("give --reason <text>: each write needs a reason for its audit row");
  const problem = reasonProblem(value);
  if (problem !== null) throw new UsageError(problem);
  return value;
}

/** The base URL, the base path, and the time limit of a call. */
export interface ToolTarget {
  base: string;
  basePath: string;
  ms: number;
}

/**
 * The target of a call, before any read of the secret. The base is https,
 * or http on this machine only, because the request carries a secret.
 */
export function toolTarget(target: string | undefined, values: OperatorValues): ToolTarget {
  return {
    base: baseOf(target),
    basePath: basePathOf(values["base-path"]),
    ms: timeoutOf(values.timeout),
  };
}

/** The user id of a command that acts on one user: the positional after the base URL. */
export function userIdOf(id: string | undefined, extra: readonly string[]): string {
  if (id === undefined) throw new UsageError("name the user id after the base URL");
  if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
  return id;
}

/** A whole number flag from 1 to `max`, or undefined when absent, or a usage error. */
export function countOf(flag: string, value: string | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(n >= 1 && n <= max)) throw new UsageError(`--${flag} is a whole number from 1 to ${max}`);
  return n;
}

/** The flags of the confirmation rule. */
export interface ConfirmValues {
  yes?: boolean | undefined;
  "no-input"?: boolean | undefined;
  "token-file"?: string | undefined;
}

/**
 * The confirmation rule of `keys rotate`, before any read of the secret and
 * any request: a run that cannot ask must say yes. `--token-file -` reads
 * stdin to its end, so the question would read an ended stream.
 */
export function needYes(ctx: Ctx, values: ConfirmValues, command: string): void {
  if (values.yes === true) return;
  if (!ctx.stdinIsTTY || values["no-input"] === true)
    throw new UsageError(
      `${command} asks for a confirmation: give --yes when no person can answer`,
    );
  if (values["token-file"] === "-")
    throw new UsageError(
      "--token-file - reads the secret from stdin, so the command cannot ask: give --yes",
    );
}

/** The question of a write, unless `--yes`. `act` names what did not happen on a no. */
export async function ask(
  ctx: Ctx,
  values: ConfirmValues,
  question: string,
  act: string,
): Promise<void> {
  if (values.yes === true) return;
  if (!(await ctx.confirm(question))) throw new Stop(`no ${act}: the answer was not yes`);
}

/**
 * The typed question of an act that cannot be undone, unless `--yes`
 * (plan 12f2 Task 6). The answer must equal `expected`, the user id, so a
 * yes by habit does not act. `needYes` ran before, so a person can answer.
 */
export async function askTyped(
  ctx: Ctx,
  values: ConfirmValues,
  question: string,
  expected: string,
  act: string,
): Promise<void> {
  if (values.yes === true) return;
  if ((await ctx.prompt(question)).trim() !== expected)
    throw new Stop(`no ${act}: the answer was not the user id`);
}

/** One call of a route of the user tools. */
export interface ToolCall {
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  query?: Readonly<Record<string, string>>;
  scope: OperatorScope;
  /** The text after `invalid_body`: what the command checks. */
  invalid?: string;
  /** The user id of a command that acts on one user. A 404 then has two causes. */
  userId?: string;
  /** The 429 text of a route with a limit beside the limit per IP. */
  limits?: string;
}

/**
 * One call of a route of the user, session, and audit tools, with the 600
 * calls of an hour in its 429 text. A 404 of a command with a user id has
 * two causes: no user has the id, or the tools are off. One read of the
 * user list tells which, for one more call. A 404 there means that the
 * tools are off. Any other answer means that the route exists.
 */
export async function toolCall(
  ctx: Ctx,
  t: ToolTarget & { secret: string },
  call: ToolCall,
): Promise<unknown> {
  const { userId, ...rest } = call;
  try {
    return await operatorCall(ctx, { ...t, ...rest, perHour: TOOL_CALLS_PER_HOUR, tool: true });
  } catch (e) {
    if (!(e instanceof OperatorStop) || e.status !== 404 || userId === undefined) throw e;
    try {
      await operatorCall(ctx, {
        ...t,
        path: "/operator/users",
        method: "GET",
        query: { limit: "1" },
        perHour: TOOL_CALLS_PER_HOUR,
        tool: true,
        scope: "users",
      });
    } catch (probe) {
      if (!(probe instanceof OperatorStop)) throw probe;
      if (probe.status === 404) throw e;
    }
    throw new Stop(`no user has the id ${userId}`);
  }
}

const isString = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isNullableString = (v: unknown): v is string | null => v === null || isString(v);

/** One user of an answer, with the keys of `OperatorUserJson` only, or null when it is not one. */
export function operatorUser(v: unknown): OperatorUserJson | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  const ban = u.ban as Record<string, unknown> | null | undefined;
  if (
    !isString(u.id) ||
    // A user may have no address (plan 12i Task 1): a phone or an anonymous sign-in.
    !isNullableString(u.email) ||
    typeof u.emailVerified !== "boolean" ||
    !isNullableString(u.name) ||
    !isString(u.createdAt) ||
    typeof u.platformOperator !== "boolean" ||
    !isStrings(u.secondFactor) ||
    !isCount(u.sessions) ||
    !isStrings(u.identities)
  )
    return null;
  if (ban === undefined || (ban !== null && typeof ban !== "object")) return null;
  if (
    ban !== null &&
    (!isString(ban.at) || !isNullableString(ban.reason) || !isNullableString(ban.until))
  )
    return null;
  return {
    id: u.id,
    email: u.email,
    emailVerified: u.emailVerified,
    name: u.name,
    createdAt: u.createdAt,
    ban:
      ban === null
        ? null
        : {
            at: ban.at as string,
            reason: ban.reason as string | null,
            until: ban.until as string | null,
          },
    platformOperator: u.platformOperator,
    secondFactor: u.secondFactor,
    sessions: u.sessions,
    identities: u.identities,
  };
}

/** One page of users, or null when the body is not one. */
export function usersPage(
  body: unknown,
): { users: OperatorUserJson[]; next: string | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.users) || !isNullableString(b.next)) return null;
  const users: OperatorUserJson[] = [];
  for (const raw of b.users) {
    const user = operatorUser(raw);
    if (user === null) return null;
    users.push(user);
  }
  return { users, next: b.next };
}

/** One audit row of an answer, with the keys of `AuditRowJson` only, or null. */
function auditRow(v: unknown): AuditRowJson | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (
    !isString(r.id) ||
    !isString(r.createdAt) ||
    !isString(r.updatedAt) ||
    !isString(r.actorKind) ||
    !isString(r.actorId) ||
    !isString(r.action) ||
    !isNullableString(r.targetUserId) ||
    !isString(r.reason) ||
    !isNullableString(r.ip) ||
    !isNullableString(r.userAgent)
  )
    return null;
  if (r.data !== null && (typeof r.data !== "object" || Array.isArray(r.data))) return null;
  return {
    id: r.id,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    actorKind: r.actorKind,
    actorId: r.actorId,
    action: r.action,
    targetUserId: r.targetUserId,
    reason: r.reason,
    data: r.data as Record<string, unknown> | null,
    ip: r.ip,
    userAgent: r.userAgent,
  };
}

/** One page of audit rows, or null when the body is not one. */
export function auditPage(body: unknown): { rows: AuditRowJson[]; next: string | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.rows) || !isNullableString(b.next)) return null;
  const rows: AuditRowJson[] = [];
  for (const raw of b.rows) {
    const row = auditRow(raw);
    if (row === null) return null;
    rows.push(row);
  }
  return { rows, next: b.next };
}

/** The flags of a paged read. */
export interface PageValues {
  after?: string | undefined;
  limit?: string | undefined;
  all?: boolean | undefined;
  "max-calls"?: string | undefined;
}

/** The page size and the call bound of a paged read, or a usage error. */
export interface PageRule {
  /** The `limit` of each call. With `--all` and no `--limit`, `PAGE_MAX`, so a long read costs fewer calls. */
  limit: number | undefined;
  maxCalls: number;
}

/**
 * The rule of a paged read, before any read of the secret. `--max-calls`
 * goes with `--all` only: a read of one page makes one call.
 */
export function pageRule(values: PageValues): PageRule {
  const limit = countOf("limit", values.limit, PAGE_MAX);
  const maxCalls = countOf("max-calls", values["max-calls"], MAX_CALLS_MAX);
  if (maxCalls !== undefined && values.all !== true)
    throw new UsageError("--max-calls goes with --all");
  return {
    limit: limit ?? (values.all === true ? PAGE_MAX : undefined),
    maxCalls: maxCalls ?? DEFAULT_MAX_CALLS,
  };
}

/** The rows of a paged read, the cursor after them, and how the read ended. */
export interface PagesRead<R> {
  rows: R[];
  next: string | null;
  /** The text of a stop after the first page, or null. */
  stopped: string | null;
  /** True when `--all` reached `--max-calls` with a next page. */
  cut: boolean;
}

/**
 * The pages of a read: one page, or with `--all` each page until `next` is
 * null. Each call counts on the limiter of 600 calls an hour (review of
 * plan 12f Task 12). So the loop stops at `--max-calls`, and it stops when
 * `next` equals the `after` of its call, because that loop never ends. A
 * stop of the first call throws. A stop after it keeps the rows read, so
 * the command prints them with exit 2.
 */
export async function readPages<R>(
  ctx: Ctx,
  t: ToolTarget & { secret: string },
  call: ToolCall,
  values: PageValues,
  rule: PageRule,
  pageOf: (body: unknown) => { rows: R[]; next: string | null } | null,
  what: string,
): Promise<PagesRead<R>> {
  const request = `GET ${t.base}${t.basePath}${call.path}`;
  const rows: R[] = [];
  let after = values.after ?? null;
  let calls = 0;
  try {
    for (;;) {
      const body = await toolCall(ctx, t, {
        ...call,
        query: {
          ...call.query,
          ...(after === null ? {} : { after }),
          ...(rule.limit === undefined ? {} : { limit: String(rule.limit) }),
        },
      });
      const page = pageOf(body);
      if (page === null) throw new Stop(`${request} answered 200 with no ${what}`);
      if (values.all === true && page.next !== null && page.next === after)
        throw new Stop(`${request} answered the cursor of its own call as next: the read stops`);
      calls++;
      rows.push(...page.rows);
      if (values.all !== true || page.next === null)
        return { rows, next: page.next, stopped: null, cut: false };
      after = page.next;
      if (calls >= rule.maxCalls) return { rows, next: after, stopped: null, cut: true };
    }
  } catch (e) {
    if (!(e instanceof Stop) || calls === 0) throw e;
    ctx.err(`stopped: ${e.message}`);
    return { rows, next: after, stopped: e.message, cut: false };
  }
}

/** The exit of a paged read: 2 after a stop, 1 with a warning when `--max-calls` cut it, else 0. */
export function pagesExit(
  ctx: Ctx,
  read: PagesRead<unknown>,
  rule: PageRule,
  what: string,
): 0 | 1 | 2 {
  if (read.stopped !== null) return 2;
  if (!read.cut) return 0;
  ctx.err(
    `warning: the read reached --max-calls ${rule.maxCalls} with more ${what}; give --after ${read.next} to read on`,
  );
  return 1;
}

/** The `auditId` of a write's answer, or a stop that names the request. */
export function auditIdOf(body: unknown, request: string): string {
  const id = (body as { auditId?: unknown } | null)?.auditId;
  if (typeof body !== "object" || body === null || !isString(id))
    throw new Stop(`${request} answered 200 with no audit row id`);
  return id;
}

/**
 * The lines of a table: one header line, then one line per row. Each
 * column is as wide as its widest cell, with two spaces between columns.
 * So a person reads the columns, and a script splits on spaces. Only the
 * last column can hold a space.
 */
export function tableLines(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

/**
 * The warning of a ban or a revoke that answers `familyEndFailed: true`
 * (ruling 37 of plan 12f). The act committed, and the end of the OAuth
 * refresh families after the commit failed. `sessions end` reads the
 * refresh tokens of the user again, and ends each family. The runbooks
 * quote it, and a site test holds them to it (ruling 62 m7).
 */
export function familyEndWarning(userId: string): string {
  return `warning: the act ran, but the end of the OAuth refresh families failed (familyEndFailed); run authtempo sessions end <base url> ${userId} with a secret of the sessions scope`;
}

/** The stdout line of a write on one user: its result, then the audit row id. */
export function writtenLine(done: string, auditId: string): string {
  return `${done}; audit row ${auditId}`;
}

/** The stdout line of `secret --operator` with the hash for an entry of `operator.secrets`. */
export function secretHashLine(hash: string): string {
  return `secretHash: ${hash}`;
}

/** The result of a ban, before the audit row id. */
export function bannedText(userId: string): string {
  return `banned ${userId}`;
}

/** The header of a user table. */
export const USER_HEADER = [
  "ID",
  "EMAIL",
  "VERIFIED",
  "BAN",
  "OPERATOR",
  "FACTORS",
  "SESSIONS",
  "CREATED",
] as const;

/** One user as a table row: no name, so no cell holds a space. */
export function userRow(u: OperatorUserJson): string[] {
  const ban = u.ban === null ? "-" : (u.ban.until ?? "no-end");
  return [
    u.id,
    u.email ?? "-",
    u.emailVerified ? "yes" : "no",
    ban,
    u.platformOperator ? "yes" : "no",
    u.secondFactor.length > 0 ? u.secondFactor.join(",") : "-",
    String(u.sessions),
    u.createdAt,
  ];
}

/** The header of an audit table. The reason is last: it can hold spaces. */
export const AUDIT_HEADER = ["ID", "CREATED", "ACTOR", "ACTION", "TARGET", "REASON"] as const;

/** One audit row as a table row. */
export function auditLine(r: AuditRowJson): string[] {
  return [
    r.id,
    r.createdAt,
    `${r.actorKind}:${r.actorId}`,
    r.action,
    r.targetUserId ?? "-",
    r.reason,
  ];
}
