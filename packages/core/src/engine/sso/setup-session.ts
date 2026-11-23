import type { ResolvedConfig } from "../../config.js";
import { readCookie, sessionCookie } from "../../http/cookies.js";
import { ipKey } from "../../limiter/ip-key.js";
import { limit } from "../../limiter/limit.js";
import {
  SETUP_LINK_PREFIX,
  SETUP_SESSION_COOKIE,
  SETUP_SESSION_PREFIX,
} from "../../primitives/credentials.js";
import { randomToken, sha256Hex } from "../../primitives/crypto.js";
import { newId } from "../../primitives/ids.js";
import { fail, ok, type Result } from "../../result.js";
import type { OperatorAuditRow, SsoSetupLinkRow, SsoSetupSessionRow } from "../../schema.js";
import { writeAuditIn } from "../operator/audit.js";
import { afterAudit, type SsoActMeta } from "./domains.js";
import { ssoDraft } from "./guard.js";
import { setupOpened, setupRefused } from "./setup-events.js";
import { lockSetupRows } from "./setup-live.js";

/**
 * The setup session (plan 13a, spec 6.1 items 5 and 6). The IT admin opens a
 * setup link with a POST, and core answers with a cookie that names one
 * session row. The cookie is the only credential of the routes in
 * `SETUP_SESSION_ROUTES`. It is not a user session: it names no user, and no
 * other route reads it. Core stores the SHA-256 hex of its value only.
 * Each refusal of `requireSetupSession` is one value, so a caller cannot
 * tell a missing cookie from an ended session, a revoked link, or an
 * expired one.
 */

/** A session ends 60 minutes after its last request (spec 6.1 item 6). */
export const SETUP_SESSION_IDLE_MS = 60 * 60_000;
/** A session ends 8 hours after its open, however active (spec 6.1 item 6). */
export const SETUP_SESSION_ABSOLUTE_MS = 8 * 3_600_000;
/**
 * The live opens of one link: 20 per hour (pre-flight C11 of plan 13a). An
 * IT admin opens a link a few times, once for each browser. A count past 20
 * means a link that more than one person tries.
 */
export const SETUP_OPEN_PER_LINK = { seconds: 3600, max: 20 };
/**
 * The tries to open of one IP, a refused token too: 60 per hour. A refused
 * token costs one hash. The key of the link counts live links only, so a
 * guess of tokens is bounded here. A token holds 256 random bits, so no
 * count makes a guess likely.
 */
export const SETUP_OPEN_PER_IP = { seconds: 3600, max: 60 };
/**
 * The loads of the confirm page `GET /sso/setup` by one IP: 60 per hour, on the key `setup-page:ip`.
 * The page reads no row, but each view costs a render. It has its own key, so a person who reloads
 * the page spends none of the opens of an office address (`SETUP_OPEN_PER_IP`).
 */
export const SETUP_PAGE_PER_IP = { seconds: 3600, max: 60 };
/**
 * The loads of the setup page `GET /sso/setup/status` by one IP: 600 per hour, on the key
 * `setup-status:ip`. A page that polls a run is one load each. The count runs before the cookie check.
 */
export const SETUP_STATUS_PER_IP = { seconds: 3600, max: 600 };

/** The actor of the open: nobody is signed in. The link id goes in `data` (pre-flight C5). */
const OPEN_ACTOR = { kind: "app", name: "setup-link" } as const;
/** The form of a link token and of a session token, so a text of another form costs no hash. */
const LINK_TOKEN_RE = new RegExp(`^${SETUP_LINK_PREFIX}[A-Za-z0-9_-]{43}$`);
const SESSION_TOKEN_RE = new RegExp(`^${SETUP_SESSION_PREFIX}[A-Za-z0-9_-]{43}$`);

/**
 * True when the organization row of a link exists (ruling R17 of plan 13a).
 * The act of an account delete deletes the organization row, and the sweep
 * deletes the setup links and setup sessions later (`deleteOrganizationsRest`).
 * So each request reads the organization row: a session of a deleted
 * organization opens no route before the sweep. The read costs one query
 * here, and the act of the delete sends no setup delete. The open reads the
 * row in its transaction (`openSetupSession`).
 */
async function organizationExists(config: ResolvedConfig, id: string): Promise<boolean> {
  return (
    (await config.storage.findOne("organization", [{ field: "id", op: "eq", value: id }])) !== null
  );
}

/**
 * Opens a setup session for the link of `token`. The checks, in this order:
 * `sso.setup` is on, else `not_found`. One count on `setup-open:ip`, else
 * `rate_limited`. The token has the form of a link token and names a link
 * that is not revoked, not ended, and not expired, else
 * `setup_link_invalid` (one answer for each cause). One count on
 * `setup-open:link`, else `rate_limited`. One transaction then reads and
 * locks the organization row, and sets the first `openedAt` of the link
 * where the link is still live (`lockSetupRows`). An organization that is
 * gone and a link that is not live answer `setup_link_invalid`. It ends each
 * live session of the link, writes the new session, and writes the
 * `sso_setup_link_open` audit row. So a revoke in parallel fails the open or
 * ends its session. The answer holds the value of the `Set-Cookie` header.
 * The session ends at the earlier of 8 hours and the end of the link.
 */
export async function openSetupSession(
  config: ResolvedConfig,
  token: string,
  meta: SsoActMeta = {},
): Promise<Result<{ cookie: string; linkId: string }>> {
  if (!config.sso || !config.sso.setup) return fail("not_found");
  if (!(await limit(config, "setup-open:ip", ipKey(meta.ip ?? null), SETUP_OPEN_PER_IP))) {
    setupRefused(config, "open_ip_limit");
    return fail("rate_limited");
  }
  if (!LINK_TOKEN_RE.test(token)) {
    setupRefused(config, "open_token_form");
    return fail("setup_link_invalid");
  }
  const link = await config.storage.findOne("ssoSetupLink", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
    { field: "revokedAt", op: "eq", value: null },
    { field: "endedAt", op: "eq", value: null },
    { field: "expiresAt", op: "gt", value: config.clock.now() },
  ]);
  if (!link) {
    setupRefused(config, "open_link_invalid");
    return fail("setup_link_invalid");
  }
  if (!(await limit(config, "setup-open:link", link.id, SETUP_OPEN_PER_LINK))) {
    setupRefused(config, "open_link_limit");
    return fail("rate_limited");
  }
  const draft = ssoDraft(OPEN_ACTOR, "sso_setup_link_open", link.organizationId, {
    targetUserId: null,
    data: { organizationId: link.organizationId, linkId: link.id },
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  if (!draft.ok) return draft;
  const now = config.clock.now();
  const clear = randomToken(SETUP_SESSION_PREFIX);
  const expiresAt = new Date(
    Math.min(now.getTime() + SETUP_SESSION_ABSOLUTE_MS, link.expiresAt.getTime()),
  );
  const row: SsoSetupSessionRow = {
    id: newId(now),
    createdAt: now,
    updatedAt: now,
    linkId: link.id,
    organizationId: link.organizationId,
    tokenHash: await sha256Hex(clear),
    lastSeenAt: now,
    expiresAt,
    endedAt: null,
  };
  const opened = await config.storage.transaction(async (tx): Promise<OperatorAuditRow | null> => {
    // Ruling R22 of plan 13a: the organization row, then the link row, then the session rows, in
    // the order of each setup write and of the organization delete. A delete that holds the
    // organization row refuses the open after its commit. A later delete waits for this commit,
    // and deletes this session with the link. So no session row outlives its link (ruling R17).
    // The where of the link holds it live again: a revoke or an end since the read above fails
    // the open.
    const held = await lockSetupRows(tx, link.organizationId, {
      id: link.id,
      now,
      set: { openedAt: link.openedAt ?? now },
    });
    if (!held.ok) return null;
    await tx.update(
      "ssoSetupSession",
      [
        { field: "linkId", op: "eq", value: link.id },
        { field: "endedAt", op: "eq", value: null },
      ],
      { endedAt: now, updatedAt: now },
    );
    await tx.create("ssoSetupSession", row);
    return writeAuditIn(tx, draft.value, now);
  });
  if (!opened) {
    setupRefused(config, "open_lost");
    return fail("setup_link_invalid");
  }
  await afterAudit(config, opened);
  setupOpened(config, link.id, link.organizationId);
  const seconds = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
  // Lax, never None: the SAML ACS is a cross-site POST, and the browser must not send this cookie there (pre-flight C9).
  return ok({
    cookie: sessionCookie(SETUP_SESSION_COOKIE, clear, seconds, "Lax"),
    linkId: link.id,
  });
}

/** What `requireSetupSession` answers: the live link and its live session row. */
export type SetupSession = { link: SsoSetupLinkRow; session: SsoSetupSessionRow };

/**
 * The setup session of a request, or `unauthorized`. Every refusal is the
 * same value: no cookie, a value of the wrong form, an unknown value, an
 * ended session, an idle session, an absolute end, a link that is revoked
 * or ended, and an organization that is gone. The row of the link is the
 * second guard: the revoke and
 * the end of a link end their sessions in their own transaction, and this
 * read refuses a row that they missed. A pass moves `lastSeenAt` by one
 * conditional update, so a session that ended in parallel passes no request.
 */
export async function requireSetupSession(
  config: ResolvedConfig,
  request: Pick<Request, "headers">,
): Promise<Result<SetupSession>> {
  const cookie = readCookie(request, SETUP_SESSION_COOKIE);
  if (cookie === null || !SESSION_TOKEN_RE.test(cookie)) {
    setupRefused(config, "session_cookie");
    return fail("unauthorized");
  }
  const now = config.clock.now();
  const session = await config.storage.findOne("ssoSetupSession", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(cookie) },
    { field: "endedAt", op: "eq", value: null },
    { field: "expiresAt", op: "gt", value: now },
    { field: "lastSeenAt", op: "gt", value: new Date(now.getTime() - SETUP_SESSION_IDLE_MS) },
  ]);
  if (!session) {
    setupRefused(config, "session_ended");
    return fail("unauthorized");
  }
  const link = await config.storage.findOne("ssoSetupLink", [
    { field: "id", op: "eq", value: session.linkId },
    { field: "revokedAt", op: "eq", value: null },
    { field: "endedAt", op: "eq", value: null },
  ]);
  if (!link || !(await organizationExists(config, link.organizationId))) {
    setupRefused(config, "session_link");
    return fail("unauthorized");
  }
  const touched = await config.storage.update(
    "ssoSetupSession",
    [
      { field: "id", op: "eq", value: session.id },
      { field: "endedAt", op: "eq", value: null },
    ],
    { lastSeenAt: now, updatedAt: now },
  );
  if (touched === 0) {
    // The session ended between the read and the touch: the same cause as an ended session.
    setupRefused(config, "session_ended");
    return fail("unauthorized");
  }
  return ok({ link, session: { ...session, lastSeenAt: now, updatedAt: now } });
}
