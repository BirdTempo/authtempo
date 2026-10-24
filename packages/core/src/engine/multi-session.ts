import type { ResolvedConfig } from "../config.js";
import { sha256Hex } from "../primitives/crypto.js";
import { fail, ok, type Result } from "../result.js";
import type { SessionRow } from "../schema.js";
import type { SessionEndReason } from "./hooks.js";
import { deliverLogouts } from "./oauth-logout.js";
import { endSessionById } from "./oauth-outbox.js";
import { impersonationStops } from "./operator/audit.js";
import {
  destroySession,
  isSessionTokenForm,
  type ResolvedSession,
  resolveSession,
  type SessionReadMode,
  sessionIsLive,
  sessionsEnded,
} from "./sessions.js";

/**
 * Multi-session (plan 12i Task 11, spec 32 item 11). One browser keeps the
 * sessions of several users. The active token stays in the session cookie.
 * The other tokens live in one HttpOnly bag cookie, joined by `.`. The bag
 * holds tokens in clear, as the session cookie does. A token in the bag is
 * no credential of a request: only the active token signs a request in. A
 * multi-session route resolves each bag token through `resolveSession`, so
 * a revoked, expired, or banned session leaves the bag at that read.
 *
 * The rules: one session per user, so a second sign-in of a user ends the
 * first with `sign_out`. An impersonation session never enters the bag:
 * the actor cookie keeps the operator's token. An anonymous user's session
 * never enters the bag. A full bag ends its oldest session with `displaced`.
 */

/** The limit of the three multi-session routes, per IP. */
export const MULTI_SESSION_PER_IP = { seconds: 900, max: 60 };

/**
 * The longest bag cookie value that core reads. Ten sessions are nine bag
 * tokens of 46 characters and eight dots: 422 characters. A longer value
 * is no bag of core, so core reads none of it.
 */
const BAG_VALUE_MAX = 512;

/** One live session of the bag, with its token. The token never leaves the server in an answer. */
export interface BagEntry {
  token: string;
  resolved: ResolvedSession;
}

/**
 * The tokens of a bag cookie value: each of the session token form, each
 * once, and at most `max - 1`. Empty with multi-session off or no cookie.
 */
export function bagTokens(config: ResolvedConfig, value: string | null): string[] {
  const ms = config.multiSession;
  if (!ms || value === null || value.length > BAG_VALUE_MAX) return [];
  const tokens = [...new Set(value.split(".").filter(isSessionTokenForm))];
  return tokens.slice(0, ms.max - 1);
}

/**
 * The bag after a browser sign-in (the router calls it), or null for no
 * change. `previous` is the token of the request's session cookie, `token`
 * the token of the new session cookie. One read finds every row by its
 * token hash. The previous session moves into the bag when it is live and
 * of another user, and when that user is not anonymous. A session of the
 * signed-in user ends with `sign_out`. A bag past `max - 1` ends its oldest
 * session with `displaced`. An impersonation start keeps the bag as it is.
 */
export async function bagAtSignIn(
  config: ResolvedConfig,
  input: { previous: string | null; token: string; bag: readonly string[] },
): Promise<string[] | null> {
  const ms = config.multiSession;
  if (!ms || !isSessionTokenForm(input.token)) return null;
  const { token } = input;
  const previous = input.previous !== token ? input.previous : null;
  const all = [token, ...(previous === null ? [] : [previous]), ...input.bag];
  const hashOf = new Map<string, string>();
  for (const t of all) if (isSessionTokenForm(t)) hashOf.set(t, await sha256Hex(t));
  const rows = await config.storage.findMany("session", [
    { field: "tokenHash", op: "in", value: [...new Set(hashOf.values())] },
  ]);
  const byHash = new Map(rows.map((r) => [r.tokenHash, r]));
  const rowOf = (t: string) => {
    const hash = hashOf.get(t);
    return hash === undefined ? undefined : byHash.get(hash);
  };
  const current = rowOf(token);
  if (!current || current.actorId !== null) return null;
  const now = config.clock.now();
  const live = (t: string): SessionRow | null => {
    const row = rowOf(t);
    return row && row.actorId === null && sessionIsLive(config, row, now) ? row : null;
  };
  const kept: { token: string; row: SessionRow }[] = [];
  const replaced: SessionRow[] = [];
  const users = new Set([current.userId]);
  const keep = (t: string, row: SessionRow) => {
    if (row.userId === current.userId) replaced.push(row);
    else if (!users.has(row.userId)) {
      users.add(row.userId);
      kept.push({ token: t, row });
    }
  };
  for (const t of input.bag) {
    const row = t === token ? null : live(t);
    if (row) keep(t, row);
  }
  const before = previous === null ? null : live(previous);
  if (previous !== null && before) {
    // An anonymous session never enters the bag (plan 12i Task 6 owns its end).
    const user =
      before.userId === current.userId
        ? null
        : await config.storage.findOne("user", [{ field: "id", op: "eq", value: before.userId }]);
    if (before.userId === current.userId || (user && !user.isAnonymous)) keep(previous, before);
  }
  const displaced: SessionRow[] = [];
  while (kept.length > ms.max - 1) {
    let oldest = 0;
    kept.forEach((k, i) => {
      if (k.row.createdAt.getTime() < (kept[oldest]?.row.createdAt.getTime() ?? 0)) oldest = i;
    });
    const [gone] = kept.splice(oldest, 1);
    if (gone) displaced.push(gone.row);
  }
  await endRows(config, replaced, "sign_out");
  await endRows(config, displaced, "displaced");
  return kept.map((k) => k.token);
}

/**
 * Ends each row by id with its outbox rows, fires the end hooks with
 * `reason`, then delivers the back-channel logouts of each user.
 */
async function endRows(
  config: ResolvedConfig,
  rows: readonly SessionRow[],
  reason: SessionEndReason,
): Promise<void> {
  if (rows.length === 0) return;
  const now = config.clock.now();
  const ended: SessionRow[] = [];
  for (const row of rows)
    if ((await endSessionById(config.storage, row, now, null)) === 1) ended.push(row);
  await sessionsEnded(config, ended, reason, null, ended.length);
  for (const userId of new Set(ended.map((r) => r.userId))) await deliverLogouts(config, userId);
}

/**
 * The live sessions of the bag, each through `resolveSession` (plan 12i).
 * A token that resolves to nothing, to an impersonation session, to an
 * anonymous user, or to a user that the active session or an earlier entry
 * holds leaves the bag. The caller writes the bag again from the answer.
 */
export async function listBrowserSessions(
  config: ResolvedConfig,
  input: { active: ResolvedSession; bag: readonly string[]; mode: SessionReadMode },
): Promise<BagEntry[]> {
  const users = new Set([input.active.user.id]);
  const entries: BagEntry[] = [];
  for (const token of input.bag) {
    const resolved = await resolveSession(config, token, input.mode);
    if (!resolved || resolved.session.actorId !== null || resolved.user.isAnonymous) continue;
    if (users.has(resolved.user.id)) continue;
    users.add(resolved.user.id);
    entries.push({ token, resolved });
  }
  return entries;
}

/**
 * Makes the bag session `sessionId` the active one (plan 12i). Every bag
 * token resolves first. The old active session moves into the bag, unless
 * its user is anonymous. A switch writes no `freshAt`: each session keeps
 * its own. `not_found` when no live bag session has the id.
 */
export async function switchSession(
  config: ResolvedConfig,
  input: {
    active: ResolvedSession;
    activeToken: string;
    bag: readonly string[];
    sessionId: string;
    mode: SessionReadMode;
  },
): Promise<Result<{ active: BagEntry; bag: string[] }>> {
  const entries = await listBrowserSessions(config, input);
  const tokens = entries.map((e) => e.token);
  if (input.sessionId === input.active.session.id)
    return ok({ active: { token: input.activeToken, resolved: input.active }, bag: tokens });
  const target = entries.find((e) => e.resolved.session.id === input.sessionId);
  if (!target) return fail("not_found");
  const rest = tokens.filter((t) => t !== target.token);
  return ok({
    active: target,
    bag: input.active.user.isAnonymous ? rest : [...rest, input.activeToken],
  });
}

/**
 * Ends one session of the browser (plan 12i, owner decision 4): the active
 * one or one of the bag. When the active one ends, the first live bag
 * session becomes active, or none. `not_found` when no live session of the
 * browser has the id.
 */
export async function signOutOne(
  config: ResolvedConfig,
  input: {
    active: ResolvedSession;
    activeToken: string;
    bag: readonly string[];
    sessionId: string;
    mode: SessionReadMode;
  },
): Promise<
  Result<
    { ended: "active"; next: BagEntry | null; bag: string[] } | { ended: "bag"; bag: string[] }
  >
> {
  const entries = await listBrowserSessions(config, input);
  if (input.sessionId === input.active.session.id) {
    await endOne(config, input.activeToken);
    const [next, ...rest] = entries;
    return ok({ ended: "active", next: next ?? null, bag: rest.map((e) => e.token) });
  }
  const target = entries.find((e) => e.resolved.session.id === input.sessionId);
  if (!target) return fail("not_found");
  await endOne(config, target.token);
  return ok({ ended: "bag", bag: entries.filter((e) => e !== target).map((e) => e.token) });
}

/** The sign-out of one token, then the back-channel logouts of its user. */
async function endOne(config: ResolvedConfig, token: string): Promise<void> {
  const ended = await destroySession(config, token);
  if (ended) await deliverLogouts(config, ended.userId);
}

/**
 * Ends every session of the bag (plan 12i, owner decision 4): `POST
 * /sign-out` calls it beside the end of the active session. One read finds
 * the rows by their token hash. Each ends by id with `sign_out`.
 */
export async function signOutBrowser(
  config: ResolvedConfig,
  bag: readonly string[],
): Promise<void> {
  const tokens = bag.filter(isSessionTokenForm);
  if (tokens.length === 0) return;
  const hashes = await Promise.all(tokens.map((t) => sha256Hex(t)));
  const rows = await config.storage.findMany("session", [
    { field: "tokenHash", op: "in", value: hashes },
  ]);
  // The bag holds no impersonation session, but a stop row costs nothing when none ends.
  const stops = impersonationStops(config, "sign_out");
  const now = config.clock.now();
  const ended: SessionRow[] = [];
  for (const row of rows)
    if ((await endSessionById(config.storage, row, now, stops)) === 1) {
      ended.push(row);
      config.observe.emit({
        name: "sign_out",
        outcome: "success",
        userId: row.userId,
        sessionId: row.id,
      });
    }
  await sessionsEnded(config, ended, "sign_out", stops, ended.length);
  for (const userId of new Set(ended.map((r) => r.userId))) await deliverLogouts(config, userId);
}
