import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { ConfigError } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { passwordSignUp, verifyPasswordEmail } from "../src/engine/password.js";
import type { SessionRow } from "../src/schema.js";
import { APP_ORIGIN, BASE_URL, get, post } from "./helpers.js";
import { FAST, pwHandle } from "./password-helpers.js";

const DAY = 86_400_000;
const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";

/**
 * A verified password user with one session, on `pwHandle`. The session
 * comes from the verify link, as a real sign-up opens it. `session` is the
 * config's session key; `undefined` leaves the key out.
 */
async function signedIn(session: AuthConfig["session"]) {
  const h = pwHandle({ hash: FAST }, session ? { session } : {});
  const up = await passwordSignUp(h.config, {
    email: EMAIL,
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });
  if (!up.ok) throw new Error(up.code);
  const mail = h.mails.findLast((m) => m.to === EMAIL && m.subject.startsWith("Confirm"));
  const v = await verifyPasswordEmail(h.config, {
    token: mail?.token ?? "",
    ip: null,
    userAgent: null,
  });
  if (!v.ok || !v.value.signedIn) throw new Error("the verify link did not sign in");
  const token = v.value.signedIn.token;
  const cookie = { cookie: `${h.config.cookieName}=${token}` };
  /** The one session row, as the store holds it now. */
  const row = async (): Promise<SessionRow> => {
    const rows = await h.storage.findMany("session", []);
    if (rows.length !== 1 || !rows[0])
      throw new Error(`expected one session row, found ${rows.length}`);
    return rows[0];
  };
  return { ...h, token, cookie, row };
}

/** The three time fields that a read must not change, and that a refresh changes in part. */
function times(r: SessionRow) {
  return {
    freshAt: r.freshAt?.getTime() ?? null,
    expiresAt: r.expiresAt.getTime(),
    lastSeenAt: r.lastSeenAt.getTime(),
  };
}

describe("session.deferRefresh (plan 12a Task 17)", () => {
  it("refuses a deferRefresh that is not a boolean at construction", () => {
    for (const bad of ["true", 1, null])
      expect(() =>
        createAuth({
          baseURL: BASE_URL,
          secret: "0123456789abcdef0123456789abcdef",
          trustedOrigins: [APP_ORIGIN],
          storage: pwHandle({ hash: FAST }).storage,
          mail: { send: async () => {} },
          session: { deferRefresh: bad as unknown as boolean },
        }),
      ).toThrow(new ConfigError("session.deferRefresh must be a boolean"));
  });

  it("writes nothing on a GET past the refresh age, and answers needsRefresh: true", async () => {
    const s = await signedIn({ deferRefresh: true });
    // Before the refresh age the answer says no refresh is due.
    const early = await s.auth.handle(get("/auth/session", s.cookie));
    expect(early.status).toBe(200);
    expect(((await early.json()) as { needsRefresh: unknown }).needsRefresh).toBe(false);
    const before = times(await s.row());
    expect(before.freshAt).not.toBeNull();
    s.clock.advance(8 * DAY);
    const res = await s.auth.handle(get("/auth/session", s.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { needsRefresh: unknown; user: { email: string } };
    expect(body.needsRefresh).toBe(true);
    expect(body.user.email).toBe(EMAIL);
    expect(times(await s.row())).toEqual(before);
    // Every GET reads in the same mode: the session list and auth.session too.
    const list = await s.auth.handle(get("/auth/sessions", s.cookie));
    expect(list.status).toBe(200);
    expect(list.headers.get("set-cookie")).toBeNull();
    const read = await s.auth.session(get("/auth/anything", s.cookie));
    expect(read?.needsRefresh).toBe(true);
    const caller = await s.auth.caller(get("/auth/anything", s.cookie));
    expect(caller?.kind).toBe("session");
    // The bearer path of auth.caller reads in the same mode (review L2).
    const bearer = await s.auth.caller(
      get("/auth/anything", { authorization: `Bearer ${s.token}` }),
    );
    expect(bearer?.kind).toBe("session");
    expect(times(await s.row())).toEqual(before);
  });

  it("moves the expiry at POST /session/refresh and renews the cookie", async () => {
    const s = await signedIn({ deferRefresh: true });
    const before = times(await s.row());
    s.clock.advance(8 * DAY);
    const res = await s.auth.handle(post("/auth/session/refresh", {}, s.cookie));
    expect(res.status).toBe(200);
    const now = s.clock.now().getTime();
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.startsWith(`${s.config.cookieName}=${s.token};`)).toBe(true);
    expect(setCookie).toContain(`Max-Age=${30 * 86_400}`);
    const body = (await res.json()) as Record<string, unknown>;
    // The POST answers the public session, with no needsRefresh field.
    expect(Object.keys(body).sort()).toEqual(["session", "user"]);
    expect(times(await s.row())).toEqual({
      freshAt: before.freshAt,
      expiresAt: now + 30 * DAY,
      lastSeenAt: now,
    });
    // The refresh is done, so the next GET says no refresh is due.
    const next = await s.auth.handle(get("/auth/session", s.cookie));
    expect(((await next.json()) as { needsRefresh: unknown }).needsRefresh).toBe(false);
  });

  it("keeps the absolute cap at POST /session/refresh", async () => {
    const s = await signedIn({ deferRefresh: true, absoluteDays: 10 });
    const created = (await s.row()).createdAt.getTime();
    s.clock.advance(8 * DAY);
    const res = await s.auth.handle(post("/auth/session/refresh", {}, s.cookie));
    expect(res.status).toBe(200);
    const r = times(await s.row());
    expect(r.expiresAt).toBe(created + 10 * DAY);
    expect(r.lastSeenAt).toBe(s.clock.now().getTime());
  });

  it("answers 401 to the refresh with no live session", async () => {
    const s = await signedIn({ deferRefresh: true });
    expect((await s.auth.handle(post("/auth/session/refresh", {}))).status).toBe(401);
    const res = await s.auth.handle(
      post("/auth/session/refresh", {}, { cookie: `${s.config.cookieName}=st_unknown` }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("answers 401 to a GET of an expired session and keeps the row for the sweep", async () => {
    const s = await signedIn({ deferRefresh: true });
    const before = times(await s.row());
    s.clock.advance(31 * DAY);
    const res = await s.auth.handle(get("/auth/session", s.cookie));
    expect(res.status).toBe(401);
    expect(times(await s.row())).toEqual(before);
    // The POST is the write mode: it deletes the ended row, as a GET does with the key off.
    expect((await s.auth.handle(post("/auth/session/refresh", {}, s.cookie))).status).toBe(401);
    expect(await s.storage.findMany("session", [])).toHaveLength(0);
  });

  it("refreshes on a GET as before with the key off, with no needsRefresh field", async () => {
    const s = await signedIn(undefined);
    expect(s.config.session.deferRefresh).toBe(false);
    const before = times(await s.row());
    s.clock.advance(8 * DAY);
    const res = await s.auth.handle(get("/auth/session", s.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")?.startsWith(`${s.config.cookieName}=${s.token};`)).toBe(
      true,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["session", "user"]);
    const now = s.clock.now().getTime();
    expect(times(await s.row())).toEqual({
      freshAt: before.freshAt,
      expiresAt: now + 30 * DAY,
      lastSeenAt: now,
    });
  });

  it("refreshes by api.session.refresh, and auth.session with refresh false stays read-only", async () => {
    const s = await signedIn({ deferRefresh: true });
    const before = times(await s.row());
    s.clock.advance(8 * DAY);
    // A POST request with refresh: false is still a read with no write (plan 11d ruling 8).
    const peek = await s.auth.session(post("/auth/anything", {}, s.cookie), { refresh: false });
    expect(peek?.needsRefresh).toBe(true);
    expect(times(await s.row())).toEqual(before);
    const r = await s.auth.api.session.refresh(s.token);
    expect(r?.refreshed).toBe(true);
    const now = s.clock.now().getTime();
    expect(times(await s.row())).toEqual({
      freshAt: before.freshAt,
      expiresAt: now + 30 * DAY,
      lastSeenAt: now,
    });
    expect(await s.auth.api.session.refresh("st_unknown")).toBeNull();
  });
});
