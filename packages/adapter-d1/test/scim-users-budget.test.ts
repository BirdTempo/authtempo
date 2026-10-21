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
// the rest.

const API = "https://api.example.com";
const APP = { kind: "app", name: "budget" } as const;
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ADA = "ada@acme.example";

/** A view of `db` that counts each statement, and each statement of a batch. */
function counting(db: D1Database) {
  const c = { n: 0 };
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
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
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

/** A magic link sign-in of `email` on `auth`: the user. */
async function signIn(auth: ReturnType<typeof make>, email: string) {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return r.value.user;
}

/** The organization `acme` with its verified domain and a SCIM token. */
async function acme(auth: ReturnType<typeof make>) {
  const owner = await signIn(auth, "owner@acme.example");
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
  return { organizationId, token: token.value.token };
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
    const { token } = await acme(setup);
    const ada = await signIn(setup, ADA);
    for (let i = 1; i < 40; i++) await signIn(setup, ADA);
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
      sweeps,
      get: get.queries,
      list: list.queries,
      delete: gone.queries,
    };
    // Measured on the binding on 2026-10-22; see the ledger of plan 12d Task 10.
    expect(counts).toEqual(MEASURED);
    for (const n of [create, update, off, get, list, gone].map((r) => r.queries).concat(sweeps))
      expect(n).toBeLessThanOrEqual(50);
  }, 120_000);
});

/**
 * The counts of the run on the binding, 2026-10-22: the queries of each
 * route, the sessions that the deactivate ended in its call, and the queries
 * of each sweep. The deactivate takes the whole budget of 50: its page ends
 * 13 of the 40 sessions, one statement per session with the hook. The two
 * sweeps end the other 27.
 */
const MEASURED = {
  create: 20,
  update: 16,
  deactivate: 50,
  ended: 13,
  sweeps: [48, 26],
  get: 5,
  list: 5,
  delete: 13,
};
