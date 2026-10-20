import { parseArgs } from "node:util";
import { COMMON_OPTIONS, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { SESSIONS_END_ALL_HELP, SESSIONS_END_HELP, SESSIONS_HELP } from "../help/sessions.js";
import type { SessionsEndAllJson, SessionsEndJson } from "../json.js";
import { readOperatorSecret } from "../operator-client.js";
import {
  ask,
  countOf,
  END_ALL_MAX,
  needYes,
  reasonOf,
  type ToolCall,
  type ToolTarget,
  toolCall,
  toolTarget,
  userIdOf,
  WRITE_OPTIONS,
} from "../operator-tools.js";
import { type Ctx, printJson } from "../output.js";
import { DEFAULT_MAX_CALLS, MAX_CALLS_MAX } from "../rewrap-limits.js";
import { runGroup } from "./users.js";

const END_OPTIONS = { ...WRITE_OPTIONS, "max-calls": { type: "string" } } as const;
const END_ALL_OPTIONS = {
  ...WRITE_OPTIONS,
  limit: { type: "string" },
  "max-calls": { type: "string" },
} as const;

/** One answer of an end route: `{ ended, more, auditId }` (spec 26 item 5). */
interface EndAnswer {
  ended: number;
  more: boolean;
  auditId: string;
}

/** The answer of an end call, or null when the body is not one. */
function endAnswer(body: unknown): EndAnswer | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.ended !== "number" || !Number.isSafeInteger(b.ended)) return null;
  if (typeof b.more !== "boolean" || typeof b.auditId !== "string") return null;
  return { ended: b.ended, more: b.more, auditId: b.auditId };
}

/** The sums of a run of end calls. */
interface Sums {
  calls: number;
  ended: number;
  more: boolean;
  auditIds: string[];
}

/**
 * The loop of an end command, as `secret rewrap` runs it: one call after
 * another while the answer has `more: true` and the calls stay under
 * `--max-calls`. One stderr line per call. A call that stops at the
 * statement budget of the deployment answers `more: true`; that is normal,
 * and the loop calls again (lead input of plan 12f Task 7). A stop after a
 * call that ran keeps the sums of the calls before it.
 */
async function endLoop(
  ctx: Ctx,
  t: ToolTarget & { secret: string },
  call: ToolCall,
  maxCalls: number,
): Promise<{ sums: Sums; stopped: string | null }> {
  const sums: Sums = { calls: 0, ended: 0, more: false, auditIds: [] };
  try {
    while (sums.calls < maxCalls) {
      const body = await toolCall(ctx, t, call);
      const answer = endAnswer(body);
      if (answer === null)
        throw new Stop(`POST ${t.base}${t.basePath}${call.path} answered 200 with no end answer`);
      sums.calls++;
      sums.ended += answer.ended;
      sums.more = answer.more;
      sums.auditIds.push(answer.auditId);
      ctx.err(`call ${sums.calls}: ended ${answer.ended}, more ${answer.more}`);
      if (!answer.more) break;
    }
  } catch (e) {
    if (!(e instanceof Stop) || sums.calls === 0) throw e;
    ctx.err(`stopped: ${e.message}`);
    return { sums, stopped: e.message };
  }
  return { sums, stopped: null };
}

/** The sums on stdout, and exit 1 with a warning when sessions are left after the last call. */
function finish(ctx: Ctx, json: boolean, sums: Sums, maxCalls: number): 0 | 1 {
  if (!json) ctx.out(`calls ${sums.calls}, ended ${sums.ended}, more ${sums.more}`);
  if (sums.more)
    ctx.err(`warning: the run reached --max-calls ${maxCalls} with sessions left; run it again`);
  return sums.more ? 1 : 0;
}

/**
 * `authtempo sessions end <base url> <user id>` (plan 12f Task 12, ASVS
 * 5.0.0 7.4.5): the end of every session of one user. A call ends one page
 * inside the budget of the deployment, so the loop calls again while
 * `more` is true. Each call writes its own audit row.
 */
async function runEnd(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseOrUsage(
    () => parseArgs({ args: argv, options: END_OPTIONS, allowPositionals: true, strict: true }),
    Object.keys(END_OPTIONS),
  );
  const [target, id, ...extra] = positionals;
  const t = toolTarget(target, values);
  const userId = userIdOf(id, extra);
  const reason = reasonOf(values.reason);
  const maxCalls = countOf("max-calls", values["max-calls"], MAX_CALLS_MAX) ?? DEFAULT_MAX_CALLS;
  const json = values.json === true;
  needYes(ctx, values, "sessions end");
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/sessions/end-user";
  ctx.err(`posting ${t.base}${t.basePath}${path}`);
  await ask(ctx, values, `End every session of the user ${userId}?`, "end");
  const { sums, stopped } = await endLoop(
    ctx,
    { ...t, secret },
    { path, method: "POST", body: { userId, reason }, scope: "sessions", userId },
    maxCalls,
  );
  if (stopped !== null) {
    if (json) printJson(ctx, { ...sums, exit: 2, stopped } satisfies SessionsEndJson);
    return 2;
  }
  const exit = finish(ctx, json, sums, maxCalls);
  if (json) printJson(ctx, { ...sums, exit, stopped: null } satisfies SessionsEndJson);
  return exit;
}

/**
 * `authtempo sessions end-all <base url>` (plan 12f Task 12, ASVS 5.0.0
 * 7.4.5): the end of the sessions of every user, up to `--limit` a call.
 * The loop calls again while `more` is true, up to `--max-calls`.
 */
async function runEndAll(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseOrUsage(
    () => parseArgs({ args: argv, options: END_ALL_OPTIONS, allowPositionals: true, strict: true }),
    Object.keys(END_ALL_OPTIONS),
  );
  const [target, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
  const t = toolTarget(target, values);
  const reason = reasonOf(values.reason);
  const limit = countOf("limit", values.limit, END_ALL_MAX);
  const maxCalls = countOf("max-calls", values["max-calls"], MAX_CALLS_MAX) ?? DEFAULT_MAX_CALLS;
  const json = values.json === true;
  needYes(ctx, values, "sessions end-all");
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/sessions/end-all";
  ctx.err(`posting ${t.base}${t.basePath}${path}`);
  await ask(ctx, values, "End the sessions of every user?", "end");
  const { sums, stopped } = await endLoop(
    ctx,
    { ...t, secret },
    {
      path,
      method: "POST",
      body: { reason, ...(limit === undefined ? {} : { limit }) },
      scope: "sessions",
    },
    maxCalls,
  );
  const { auditIds: _ids, ...counts } = sums;
  if (stopped !== null) {
    if (json) printJson(ctx, { ...counts, exit: 2, stopped } satisfies SessionsEndAllJson);
    return 2;
  }
  const exit = finish(ctx, json, sums, maxCalls);
  if (json) printJson(ctx, { ...counts, exit, stopped: null } satisfies SessionsEndAllJson);
  return exit;
}

const SUBCOMMANDS: Readonly<Record<string, (argv: string[], ctx: Ctx) => Promise<number>>> = {
  end: runEnd,
  "end-all": runEndAll,
};

/** `authtempo sessions` (plan 12f Task 12, spec 26 item 11): the session tools through `Command.subcommands`. */
export const sessionsCommand: Command = {
  help: SESSIONS_HELP,
  options: COMMON_OPTIONS,
  subcommands: {
    end: { help: SESSIONS_END_HELP, options: END_OPTIONS },
    "end-all": { help: SESSIONS_END_ALL_HELP, options: END_ALL_OPTIONS },
  },
  run: (argv, ctx) => runGroup("sessions", argv, ctx, SUBCOMMANDS),
};
