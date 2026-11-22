import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoConfig } from "../src/config.js";
import { deleteAccount } from "../src/engine/account-delete.js";
import { resolveSession } from "../src/engine/sessions.js";
import { requireSsoManager } from "../src/engine/sso/guard.js";
import { createSetupLink, revokeSetupLink } from "../src/engine/sso/setup-links.js";
import {
  openSetupSession,
  requireSetupSession,
  SETUP_OPEN_PER_IP,
  SETUP_OPEN_PER_LINK,
  SETUP_SESSION_ABSOLUTE_MS,
  SETUP_SESSION_IDLE_MS,
} from "../src/engine/sso/setup-session.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { ROUTES } from "../src/http/route-list.js";
import { SETUP_SESSION_ROUTES } from "../src/http/routes/sso-setup.js";
import { SETUP_SESSION_COOKIE } from "../src/primitives/credentials.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { recordAddress, recordCredential } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { ssoAuth } from "./sso/helpers.js";
import { managerSession } from "./sso/manager-helpers.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const LOG_METHODS = ["error", "info", "warn", "log", "debug"] as const;
const IP = recordAddress("198.51.100.7");
const META = { ip: IP, userAgent: "setup-test" };
/** What a caller gets with no credential: the same value for each refusal of a setup route. */
const UNAUTHORIZED = { ok: false, code: "unauthorized", status: 401 };
const INVALID = { ok: false, code: "setup_link_invalid", status: 404 };

beforeEach(() => {
  for (const m of LOG_METHODS) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** A memory engine with `sso.setup` on, an owner of acme, and one live link. */
async function world(ttlHours?: number) {
  const w = ssoAuth({
    sso: { oidc: true, setup: {} } as SsoConfig,
    password: { hash: FAST, uniformSignUp: false },
  });
  const owner = await managerSession(w, "owner@acme.example", "acme");
  const resolved = await resolveSession(w.config, owner.token);
  if (!resolved) throw new Error("the session ended");
  const guard = await requireSsoManager(w.config, resolved, owner.org);
  if (!guard.ok) throw new Error(guard.code);
  const actor = guard.value;
  const mint = async () => {
    const made = await createSetupLink(w.config, actor, {
      organizationId: owner.org,
      steps: ["domain", "connection"],
      kinds: ["oidc"],
      ttlHours,
      note: "Ada at Acme IT",
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    return made.value;
  };
  return { w, actor, owner, org: owner.org, mint };
}

type W = Awaited<ReturnType<typeof world>>["w"];

/** The request of a browser that holds the cookie of `setCookie` (the value of a `Set-Cookie` header). */
function withCookie(setCookie: string): Request {
  const pair = setCookie.split(";")[0] ?? "";
  return new Request("https://auth.example/auth/sso/setup/status", { headers: { cookie: pair } });
}

/** Opens a setup session through the real open. Throws when the open refuses. */
async function open(w: W, token: string) {
  const r = await openSetupSession(w.config, token, META);
  if (!r.ok) throw new Error(r.code);
  recordCredential(r.value.cookie.split(";")[0]?.split("=")[1] ?? "");
  return r.value;
}

const sessions = (w: W) => w.storage.findMany("ssoSetupSession", []);
const audits = (w: W) =>
  w.storage.findMany("operatorAudit", [
    { field: "action", op: "eq", value: "sso_setup_link_open" },
  ]);

describe("the setup session (plan 13a Task 3)", () => {
  it("answers 404 not_found to an open while sso.setup is off, and writes no row", async () => {
    const w = ssoAuth({ sso: { oidc: true } as SsoConfig, password: { hash: FAST } });
    const r = await openSetupSession(w.config, `sl_${"A".repeat(43)}`, META);
    expect(r).toEqual({ ok: false, code: "not_found", status: 404 });
    expect(await sessions(w)).toEqual([]);
  });

  it("opens with a __Host-tempo_setup cookie that is HttpOnly, Secure, SameSite=Lax, and Path=/", async () => {
    const { w, mint, org } = await world();
    const made = await mint();
    const opened = await open(w, made.token);
    expect(opened.linkId).toBe(made.id);
    const parts = opened.cookie.split("; ");
    expect(parts[0]).toMatch(new RegExp(`^${SETUP_SESSION_COOKIE}=ss_[A-Za-z0-9_-]{43}$`));
    // Lax, never None: the SAML ACS is a cross-site POST, so the browser must not send this cookie there (C9).
    expect(parts.slice(1)).toEqual([
      "Path=/",
      `Max-Age=${SETUP_SESSION_ABSOLUTE_MS / 1000}`,
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
    ]);
    const rows = await sessions(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      linkId: made.id,
      organizationId: org,
      endedAt: null,
      lastSeenAt: w.clock.now(),
      expiresAt: new Date(w.clock.now().getTime() + SETUP_SESSION_ABSOLUTE_MS),
    });
    const clear = opened.cookie.split(";")[0]?.split("=")[1] ?? "";
    expect(rows[0]?.tokenHash).toBe(await sha256Hex(clear));
    const link = await w.storage.findOne("ssoSetupLink", [
      { field: "id", op: "eq", value: made.id },
    ]);
    expect(link?.openedAt).toEqual(w.clock.now());
  });

  it("writes one sso_setup_link_open audit row with no token, no hash, and no cookie value", async () => {
    const { w, mint, org } = await world();
    const made = await mint();
    const opened = await open(w, made.token);
    const rows = await audits(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: "app",
      actorId: "setup-link",
      targetUserId: null,
      data: { linkId: made.id, organizationId: org },
    });
    const text = JSON.stringify(await w.storage.findMany("operatorAudit", []));
    const value = opened.cookie.split(";")[0]?.split("=")[1] ?? "";
    for (const secret of [made.token, value, await sha256Hex(made.token), await sha256Hex(value)])
      expect(text).not.toContain(secret);
    for (const m of LOG_METHODS)
      for (const call of vi.mocked(console[m]).mock.calls)
        expect(JSON.stringify(call)).not.toContain(value);
  });

  it("answers 404 setup_link_invalid with equal bodies for an unknown, expired, revoked, and ended link, and writes nothing", async () => {
    const { w, mint, actor } = await world();
    const expired = await mint();
    const revoked = await mint();
    expect(await revokeSetupLink(w.config, actor, revoked.id)).toEqual({
      ok: true,
      value: undefined,
    });
    const ended = await mint();
    // The end of a link is the hand back of Task 8: set `endedAt` through storage as that task does.
    await w.storage.update("ssoSetupLink", [{ field: "id", op: "eq", value: ended.id }], {
      endedAt: w.clock.now(),
    });
    w.clock.advance(73 * HOUR_MS);
    const answers = [
      await openSetupSession(w.config, `sl_${"A".repeat(43)}`, META),
      await openSetupSession(w.config, expired.token, META),
      await openSetupSession(w.config, revoked.token, META),
      await openSetupSession(w.config, ended.token, META),
      await openSetupSession(w.config, "not-a-link-token", META),
    ];
    // Equal values, so equal bodies: no answer tells which of the four causes holds.
    for (const a of answers) expect(a).toEqual(INVALID);
    expect(await sessions(w)).toEqual([]);
    expect(await audits(w)).toEqual([]);
  });

  it("ends the first session when the link opens again, and keeps the second live", async () => {
    const { w, mint } = await world();
    const made = await mint();
    const first = await open(w, made.token);
    w.clock.advance(MINUTE_MS);
    const second = await open(w, made.token);
    const rows = await sessions(w);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.endedAt === null)).toHaveLength(1);
    expect(rows.find((r) => r.endedAt !== null)?.endedAt).toEqual(w.clock.now());
    expect(await requireSetupSession(w.config, withCookie(first.cookie))).toEqual(UNAUTHORIZED);
    const live = await requireSetupSession(w.config, withCookie(second.cookie));
    expect(live.ok).toBe(true);
    expect(await audits(w)).toHaveLength(2);
  });

  it("gives the link and the session row to a live session", async () => {
    const { w, mint, org } = await world();
    const made = await mint();
    const opened = await open(w, made.token);
    const r = await requireSetupSession(w.config, withCookie(opened.cookie));
    if (!r.ok) throw new Error(r.code);
    expect(r.value.link).toMatchObject({
      id: made.id,
      organizationId: org,
      steps: ["domain", "connection"],
    });
    expect(r.value.session).toMatchObject({ linkId: made.id, organizationId: org });
  });

  it("answers as for no credential for no cookie, an empty cookie, and a cookie of no session", async () => {
    const { w, mint } = await world();
    const made = await mint();
    await open(w, made.token);
    const bare = new Request("https://auth.example/auth/sso/setup/status");
    const empty = new Request("https://auth.example/auth/sso/setup/status", {
      headers: { cookie: `${SETUP_SESSION_COOKIE}=` },
    });
    const unknown = new Request("https://auth.example/auth/sso/setup/status", {
      headers: { cookie: `${SETUP_SESSION_COOKIE}=ss_${"A".repeat(43)}` },
    });
    // The link token is no session token: a stolen link token alone opens no route.
    const linkToken = new Request("https://auth.example/auth/sso/setup/status", {
      headers: { cookie: `${SETUP_SESSION_COOKIE}=${made.token}` },
    });
    for (const request of [bare, empty, unknown, linkToken])
      expect(await requireSetupSession(w.config, request)).toEqual(UNAUTHORIZED);
  });

  it("ends a session after 60 minutes with no request, and moves the idle end with each request", async () => {
    const { w, mint } = await world();
    const made = await mint();
    const opened = await open(w, made.token);
    const request = withCookie(opened.cookie);
    // Each request inside the idle time moves the end: 3 x 59 minutes is past 60 in total.
    for (let i = 0; i < 3; i++) {
      w.clock.advance(SETUP_SESSION_IDLE_MS - MINUTE_MS);
      expect((await requireSetupSession(w.config, request)).ok).toBe(true);
    }
    w.clock.advance(SETUP_SESSION_IDLE_MS + MINUTE_MS);
    expect(await requireSetupSession(w.config, request)).toEqual(UNAUTHORIZED);
  });

  it("ends a session 8 hours after the open, however active, and not before", async () => {
    const { w, mint } = await world();
    const made = await mint();
    const opened = await open(w, made.token);
    const request = withCookie(opened.cookie);
    for (let i = 0; i < 15; i++) {
      w.clock.advance(30 * MINUTE_MS);
      expect((await requireSetupSession(w.config, request)).ok).toBe(true);
    }
    w.clock.advance(29 * MINUTE_MS);
    expect((await requireSetupSession(w.config, request)).ok).toBe(true);
    // 8 h 1 min after the open, and 2 min after the last request: only the absolute end refuses it.
    w.clock.advance(2 * MINUTE_MS);
    expect(await requireSetupSession(w.config, request)).toEqual(UNAUTHORIZED);
  });

  it("never lets a session outlive its link, and sets its end to the end of the link", async () => {
    const { w, mint } = await world(1);
    const made = await mint();
    const opened = await open(w, made.token);
    const request = withCookie(opened.cookie);
    expect((await sessions(w))[0]?.expiresAt).toEqual(made.expiresAt);
    expect(opened.cookie).toContain("Max-Age=3600;");
    w.clock.advance(59 * MINUTE_MS);
    expect((await requireSetupSession(w.config, request)).ok).toBe(true);
    w.clock.advance(2 * MINUTE_MS);
    expect(await requireSetupSession(w.config, request)).toEqual(UNAUTHORIZED);
  });

  it("opens again after the session ended, until the link expires", async () => {
    const { w, mint } = await world(2);
    const made = await mint();
    const first = await open(w, made.token);
    w.clock.advance(SETUP_SESSION_IDLE_MS + MINUTE_MS);
    expect(await requireSetupSession(w.config, withCookie(first.cookie))).toEqual(UNAUTHORIZED);
    const again = await open(w, made.token);
    expect((await requireSetupSession(w.config, withCookie(again.cookie))).ok).toBe(true);
    w.clock.advance(HOUR_MS);
    expect(await openSetupSession(w.config, made.token, META)).toEqual(INVALID);
    expect(await sessions(w)).toHaveLength(2);
  });

  it("answers as for no credential at the next request after a revoke", async () => {
    const { w, mint, actor } = await world();
    const made = await mint();
    const opened = await open(w, made.token);
    const request = withCookie(opened.cookie);
    expect((await requireSetupSession(w.config, request)).ok).toBe(true);
    expect(await revokeSetupLink(w.config, actor, made.id)).toEqual({ ok: true, value: undefined });
    expect(await requireSetupSession(w.config, request)).toEqual(UNAUTHORIZED);
  });

  it("refuses a live session row of a link that is revoked or ended: the link read is the second guard", async () => {
    const { w, mint } = await world();
    // The revoke of Task 2 and the hand back of Task 8 end the sessions in their own transaction.
    // A row that they missed must still open no route, so the link read refuses it.
    for (const field of ["revokedAt", "endedAt"] as const) {
      const made = await mint();
      const opened = await open(w, made.token);
      await w.storage.update("ssoSetupLink", [{ field: "id", op: "eq", value: made.id }], {
        [field]: w.clock.now(),
      });
      expect(await requireSetupSession(w.config, withCookie(opened.cookie))).toEqual(UNAUTHORIZED);
    }
  });

  it("refuses the open and each session request of an organization that an account delete took, before the sweep", async () => {
    const { w, mint, owner } = await world();
    const opened = await open(w, (await mint()).token);
    const idle = await mint();
    const session = await resolveSession(w.config, owner.token);
    if (!session) throw new Error("the session ended");
    const done = await deleteAccount(w.config, { session, ip: null, userAgent: null });
    expect(done).toEqual({ ok: true, value: { ok: true } });
    // Ruling R17: the act deletes the organization row, and the sweep deletes the setup rows.
    // Until the sweep, the organization read of the open and of each request refuses them.
    expect(await w.storage.findMany("organization", [])).toEqual([]);
    expect(await w.storage.findMany("ssoSetupLink", [])).toHaveLength(2);
    expect(await sessions(w)).toHaveLength(1);
    expect(await requireSetupSession(w.config, withCookie(opened.cookie))).toEqual(UNAUTHORIZED);
    expect(await openSetupSession(w.config, idle.token, META)).toEqual(INVALID);
    expect(await sessions(w)).toHaveLength(1);
    expect(await audits(w)).toHaveLength(1);
    await sweepExpired(w.config);
    expect(await w.storage.findMany("ssoSetupLink", [])).toEqual([]);
    expect(await sessions(w)).toEqual([]);
  });

  it("writes no session row when an account delete takes the organization after the link read of the open", async () => {
    const { w, mint, owner } = await world();
    const made = await mint();
    const session = await resolveSession(w.config, owner.token);
    if (!session) throw new Error("the session ended");
    const storage = w.config.storage;
    const findOne = storage.findOne.bind(storage);
    const transaction = storage.transaction.bind(storage);
    // The seam: the link read of the open arms it, and the next transaction first runs the act
    // of the delete to its commit. So the act lands between the read and the insert of the open.
    let armed = false;
    storage.findOne = (async (model, where) => {
      const row = await findOne(model, where);
      if (model === "ssoSetupLink" && where.some((w) => w.field === "tokenHash")) armed = true;
      return row;
    }) as typeof storage.findOne;
    storage.transaction = (async (fn) => {
      if (armed) {
        armed = false;
        storage.transaction = transaction;
        const done = await deleteAccount(w.config, { session, ip: null, userAgent: null });
        expect(done).toEqual({ ok: true, value: { ok: true } });
      }
      return transaction(fn);
    }) as typeof storage.transaction;
    expect(await openSetupSession(w.config, made.token, META)).toEqual(INVALID);
    storage.findOne = findOne;
    storage.transaction = transaction;
    expect(await w.storage.findMany("organization", [])).toEqual([]);
    // Minor 1 of the Task 2b review: an orphan session row here outlives the sweep of its link.
    expect(await sessions(w)).toEqual([]);
    expect(await audits(w)).toEqual([]);
    await sweepExpired(w.config);
    expect(await w.storage.findMany("ssoSetupLink", [])).toEqual([]);
    expect(await sessions(w)).toEqual([]);
  });

  it("counts 20 opens of one link in an hour, then answers 429 rate_limited and opens no session", async () => {
    const { w, mint } = await world();
    const made = await mint();
    expect(SETUP_OPEN_PER_LINK).toEqual({ seconds: 3600, max: 20 });
    // Each open comes from another IP, so only the key of the link counts.
    for (let i = 0; i < SETUP_OPEN_PER_LINK.max; i++) {
      const r = await openSetupSession(w.config, made.token, {
        ip: `203.0.113.${i + 1}`,
        userAgent: null,
      });
      expect(r.ok).toBe(true);
    }
    const refused = await openSetupSession(w.config, made.token, {
      ip: "203.0.113.200",
      userAgent: null,
    });
    expect(refused).toEqual({ ok: false, code: "rate_limited", status: 429 });
    expect(await sessions(w)).toHaveLength(SETUP_OPEN_PER_LINK.max);
    expect(await audits(w)).toHaveLength(SETUP_OPEN_PER_LINK.max);
    w.clock.advance(HOUR_MS);
    expect((await openSetupSession(w.config, made.token, META)).ok).toBe(true);
  });

  it("counts each open of one IP, a refused token too, and does not count another IP", async () => {
    const { w, mint } = await world();
    const made = await mint();
    expect(SETUP_OPEN_PER_IP).toEqual({ seconds: 3600, max: 60 });
    for (let i = 0; i < SETUP_OPEN_PER_IP.max; i++)
      expect(await openSetupSession(w.config, `sl_bad-${i}`, META)).toEqual(INVALID);
    expect(await openSetupSession(w.config, made.token, META)).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
    expect(
      (await openSetupSession(w.config, made.token, { ip: "203.0.113.9", userAgent: null })).ok,
    ).toBe(true);
    // A refused token never counts against the key of a link.
    expect(await sessions(w)).toHaveLength(1);
  });

  it("lists the closed route list: each route of the setup session, and the test start", () => {
    const entries = ROUTES.filter((r) =>
      (r.auth as readonly string[]).includes("setupSession"),
    ).map((r) => `${r.method} ${r.path}`);
    expect(entries).toHaveLength(6);
    expect([...SETUP_SESSION_ROUTES].sort()).toEqual(
      [...entries, "GET /sso/:connectionId/start?test=1"].sort(),
    );
    // No route of the manager, the member, or the live connection is on the list.
    for (const key of SETUP_SESSION_ROUTES)
      expect(key).toMatch(/^(GET|POST) \/sso\/(setup\/|:connectionId\/start\?test=1$)/);
  });
});
