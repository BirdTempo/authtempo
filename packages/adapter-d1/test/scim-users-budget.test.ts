import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, type MailMessage } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of the SCIM Users routes on the D1 binding (plan 12d Task 10,
// ruling 25 N1). D1 Free allows 50 queries per invocation (D1 limits page
// updated 21 April 2026, read 2026-10-21). Each request runs as the
// worker-d1 setup serves it: the D1 limiter and the D1 adapter on one
// counting view of the binding, so the count holds the whole invocation.
// The deactivate of a user with 40 sessions and a session.afterEnd hook is
// the worst case: its page ends the sessions that fit, and the sweep ends
// the rest. Until the sweep, each door refuses them (ruling 50 of plan 12d).

const API = "https://api.example.com";
const APP = { kind: "app", name: "budget" } as const;
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ADA = "ada@acme.example";

/** A view of `db` that counts each statement, and each statement of a batch. `sql` holds each text. */
function counting(db: D1Database) {
  const c = { n: 0, sql: [] as string[] };
  const hit = (b: PropertyKey) => b === "run" || b === "all" || b === "first" || b === "raw";
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(a, b) {
        if (b === "bind") return (...v: unknown[]) => wrap(a.bind(...v));
        if (hit(b)) c.n++;
        const x = Reflect.get(a, b);
        return typeof x === "function" ? x.bind(a) : x;
      },
    });
  const counted = new Proxy(db, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          c.sql.push(sql);
          return wrap(t.prepare(sql));
        };
      if (k === "batch")
        return (st: D1PreparedStatement[]) => {
          c.n += st.length;
          return t.batch(st);
        };
      const x = Reflect.get(t, k);
      return typeof x === "function" ? x.bind(t) : x;
    },
  });
  return { db: counted as D1Database, c };
}

/** The JWT mint, so the door calls have `api.jwt`. */
const MINT: Partial<AuthConfig> = { jwtMint: { audience: ["https://rs.example.com"] } };

const sent: MailMessage[] = [];
const txt: Record<string, string[]> = {};

/** The engine on `db`. `limited` serves it with the D1 limiter, as worker-d1 does. */
function make(db: D1Database, limited: boolean, extra: Partial<AuthConfig> = {}) {
  return createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    limiter: limited ? createD1Limiter(db) : { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    organizations: {},
    sso: { dns: [{ name: "a", txt: async (name) => txt[name] ?? [] }] },
    scim: {},
    // A session.afterEnd hook makes the end read each row: the worst case of the page.
    hooks: { session: { afterEnd: () => {} } },
    ...extra,
  });
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  sent.length = 0;
});

/** A magic link sign-in of `email` on `auth`: the user and the session token. */
async function signIn(auth: ReturnType<typeof make>, email: string) {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return { user: r.value.user, token: r.value.token };
}

/** The organization `acme` with its verified domain and a SCIM token. */
async function acme(auth: ReturnType<typeof make>) {
  const { user: owner, token: ownerToken } = await signIn(auth, "owner@acme.example");
  const made = await auth.api.createOrganization({ user: owner, slug: "acme", name: "Acme" });
  if (!made.ok) throw new Error(made.code);
  const organizationId = made.value.organization.id;
  const sso = auth.api.sso;
  const scim = auth.api.scim;
  if (!sso || !scim) throw new Error("no sso or scim api");
  const domain = await sso.domains.add({ actor: APP, organizationId, domain: "acme.example" });
  if (!domain.ok || domain.value.record === null) throw new Error("no domain");
  txt[domain.value.record.name] = [domain.value.record.value];
  if (!(await sso.domains.verify({ actor: APP, id: domain.value.id })).ok)
    throw new Error("no proof");
  const token = await scim.tokens.create({ actor: APP, organizationId, name: "directory" });
  if (!token.ok) throw new Error(token.code);
  return { organizationId, token: token.value.token, ownerToken };
}

/** One SCIM request on a counting view of the binding: its status, body, and queries. */
async function counted(token: string, method: string, path: string, body?: unknown) {
  const { db, c } = counting(env.DB);
  const res = await make(db, true).handle(
    new Request(`${API}/auth/scim/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    body: (text === "" ? null : JSON.parse(text)) as Record<string, unknown>,
    queries: c.n,
  };
}

/** The hex SHA-256 of a session token, as core stores it. */
async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One door call on a counting view of the binding, with the JWT mint on:
 * its answer, its queries, and its reads of the pending-end rows.
 */
async function door<T>(call: (auth: ReturnType<typeof make>) => Promise<T>) {
  const { db, c } = counting(env.DB);
  const value = await call(make(db, true, MINT));
  const pending = c.sql.filter((q) => /FROM\s+"?ta_verification/i.test(q)).length;
  return { value, queries: c.n, pending };
}

const sessions = async () =>
  Number(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM ta_session WHERE user_id = (SELECT id FROM ta_user WHERE email = ?)",
    )
      .bind(ADA)
      .first("n"),
  );

describe("the SCIM Users on D1 (plan 12d Task 10, ruling 25 N1)", () => {
  it("keeps each route inside 50 queries, and the sweep ends the sessions past the page", async () => {
    const setup = make(env.DB, false);
    const { token, ownerToken } = await acme(setup);
    const { user: ada, token: first } = await signIn(setup, ADA);
    const tokens = [first];
    for (let i = 1; i < 40; i++) tokens.push((await signIn(setup, ADA)).token);
    for (const name of ["one", "two", "three"]) {
      const t = await setup.api.tokens.create({ user: ada, name });
      if (!t.ok) throw new Error(t.code);
    }
    expect(await sessions()).toBe(40);
    const create = await counted(token, "POST", "/Users", { schemas: [USER_URN], userName: ADA });
    expect(create.status).toBe(201);
    const id = String(create.body.id);
    const update = await counted(token, "PATCH", `/Users/${id}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "replace", path: "displayName", value: "Ada" }],
    });
    expect(update.status).toBe(200);
    // A session from after the last write of its user reads no pending-end row: +0.
    const fresh = await door(async (auth) => auth.api.getSession(ownerToken));
    expect(fresh.value).not.toBeNull();
    expect(fresh.pending).toBe(0);
    // The SCIM link wrote the user of Ada after her sessions began: one read, and no refusal.
    const older = await door(async (auth) => auth.api.getSession(tokens[39] ?? ""));
    expect(older.value).not.toBeNull();
    expect(older.pending).toBe(1);
    const off = await counted(token, "PATCH", `/Users/${id}`, {
      schemas: [PATCH_URN],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect(off.status).toBe(200);
    const left = await sessions();
    // The page ended part of the sessions in the call; a pending-end row holds the rest.
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(40);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM ta_api_token WHERE user_id = ?")
        .bind(ada.id)
        .first("n"),
    ).toBe(0);
    // Each door refuses the sessions that stay at once, before any sweep (ruling 50 of plan 12d).
    const stay = (
      await env.DB.prepare("SELECT id FROM ta_session WHERE user_id = ? ORDER BY id")
        .bind(ada.id)
        .all<{ id: string }>()
    ).results.map((r) => r.id);
    for (const sid of stay)
      expect(await make(env.DB, false, MINT).api.jwt?.sessionLive({ sid }), sid).toBe(false);
    const sid = stay[0] ?? "";
    const live = await door(async (auth) => auth.api.jwt?.sessionLive({ sid }));
    const mint = await door(async (auth) => auth.api.jwt?.mint({ userId: ada.id, sessionId: sid }));
    expect([live.value, mint.value]).toEqual([
      false,
      { ok: false, code: "unauthorized", status: 401 },
    ]);
    const tokenOf = new Map<string, string>();
    for (const t of tokens) {
      const row = await env.DB.prepare("SELECT id FROM ta_session WHERE token_hash = ?")
        .bind(await sha256Hex(t))
        .first<{ id: string }>();
      if (row) tokenOf.set(row.id, t);
    }
    const read = await door(async (auth) => auth.api.getSession(tokenOf.get(sid) ?? ""));
    expect(read.value).toBeNull();
    // The write mode ended the row by id.
    expect(await sessions()).toBe(left - 1);
    const sweeps: number[] = [];
    while ((await sessions()) > 0) {
      const { db, c } = counting(env.DB);
      await make(db, true).api.sweepExpired();
      sweeps.push(c.n);
      if (sweeps.length > 10) throw new Error("the sweep makes no progress");
    }
    const get = await counted(token, "GET", `/Users/${id}`);
    const list = await counted(token, "GET", "/Users");
    const gone = await counted(token, "DELETE", `/Users/${id}`);
    expect(gone.status).toBe(204);
    const counts = {
      create: create.queries,
      update: update.queries,
      deactivate: off.queries,
      ended: 40 - left,
      doors: {
        fresh: [fresh.queries, fresh.pending],
        older: [older.queries, older.pending],
        live: [live.queries, live.pending],
        mint: [mint.queries, mint.pending],
        read: [read.queries, read.pending],
      },
      sweeps,
      get: get.queries,
      list: list.queries,
      delete: gone.queries,
    };
    // Measured on the binding on 2026-10-22; see the ledger of plan 12d Task 10.
    expect(counts).toEqual(MEASURED);
    const routes = [create, update, off, get, list, gone, fresh, older, live, mint, read];
    for (const n of routes.map((r) => r.queries).concat(sweeps)) expect(n).toBeLessThanOrEqual(50);
  }, 120_000);
});

/**
 * The counts of the run on the binding, 2026-10-22: the queries of each
 * route, the sessions that the deactivate ended in its call, and the queries
 * of each sweep. The deactivate takes the whole budget of 50: its page ends
 * 11 of the 40 sessions, one statement per session with the hook. It keeps 2
 * statements for the write of `user.updatedAt` (the undo read and the
 * update) and 1 for the audit row (ruling 50 of plan 12d). One session read
 * ends one more session, and the two sweeps end the other 28.
 *
 * `doors` holds the queries and the pending-end reads of each door. A session
 * from after the last write of its user reads 3 queries and no pending-end
 * row (`fresh`). A session from before it reads one more (`older`). The
 * refused session reads 4 at `sessionLive` and at the mint, and 6 at the
 * session read in write mode, which ends the row by id.
 */
const MEASURED = {
  create: 20,
  update: 16,
  deactivate: 50,
  ended: 11,
  doors: {
    fresh: [3, 0],
    older: [4, 1],
    live: [4, 1],
    mint: [4, 1],
    read: [6, 1],
  },
  sweeps: [48, 27],
  get: 5,
  list: 5,
  delete: 13,
};
