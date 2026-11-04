import { env } from "cloudflare:test";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
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
    // The token create takes the session (plan 12p): the first sign-in's own.
    const adaSession = await setup.api.getSession(first);
    if (!adaSession || adaSession.user.id !== ada.id) throw new Error("no session");
    for (const name of ["one", "two", "three"]) {
      const t = await setup.api.tokens.create({ session: adaSession, name });
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
    // Measured on the binding on 2026-10-24; see the ledger of plan 12d Task 11.
    expect(counts).toEqual(MEASURED);
    const routes = [create, update, off, get, list, gone, fresh, older, live, mint, read];
    for (const n of routes.map((r) => r.queries).concat(sweeps)) expect(n).toBeLessThanOrEqual(50);
  }, 120_000);
});

/**
 * The counts of the run on the binding, 2026-10-24: the queries of each
 * route, the sessions that the deactivate ended in its call, and the queries
 * of each sweep. The deactivate takes 49 of the budget of 50: its page ends
 * 10 of the 40 sessions, one statement per session with the hook. It keeps 2
 * statements for the write of `user.updatedAt` (the undo read and the
 * update), 1 for the audit row (ruling 50 of plan 12d), and 1 for the second
 * group read of the answer, which a user in no group does not make (ruling
 * 63 M1). The read of the member row under the user hold costs 1 more
 * (ruling 63 M2). The organization tokens go in one delete, not two (ruling
 * 66), so the page ends one more session. One session read ends one more
 * session, and the two sweeps end the other 29.
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
  deactivate: 49,
  ended: 10,
  doors: {
    fresh: [3, 0],
    older: [4, 1],
    live: [4, 1],
    mint: [4, 1],
    read: [6, 1],
  },
  sweeps: [48, 28],
  get: 5,
  list: 5,
  delete: 13,
};

/** A password sign-up that stays unverified, so a SCIM create claims it (plan 12o). */
const CLAIMANT: Partial<AuthConfig> = {
  password: {
    hash: createPbkdf2PasswordHash({ iterations: 1000 }),
    requireVerified: false,
    uniformSignUp: false,
  },
};

/**
 * The count of a SCIM create that claims an unverified user with no race,
 * on the binding, 2026-11-04 (decision 2 of plan 12o). The claimant signed
 * up by password and holds one session. The claim reads the sessions when
 * its flow collects the ended sessions. `scimCreateUser` always collects
 * them, with or without the session.afterEnd hook. So the claim reads that
 * session and deletes it by id. The create also writes the email identity,
 * the member row, the scimUser row, and the audit row. It sent 32 queries.
 * The create of the first case links a verified user and claims nothing: 20
 * queries (`MEASURED`).
 */
const MEASURED_CLAIM = { create: 32 };

describe("the SCIM create that claims an unverified user on D1 (decision 2 of plan 12o)", () => {
  it("claims the user inside 50 queries", async () => {
    const setup = make(env.DB, false, CLAIMANT);
    const { token } = await acme(setup);
    const up = await setup.api.password?.signUp({
      email: ADA,
      password: "a claimant's password",
      ip: null,
      userAgent: null,
    });
    if (!up?.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    expect(await sessions()).toBe(1);
    const create = await counted(token, "POST", "/Users", { schemas: [USER_URN], userName: ADA });
    expect(create.status).toBe(201);
    // The claim verified the user and ended the claimant's session.
    expect(
      await env.DB.prepare("SELECT email_verified AS v FROM ta_user WHERE email = ?")
        .bind(ADA)
        .first("v"),
    ).toBe(1);
    expect(await sessions()).toBe(0);
    expect({ create: create.queries }).toEqual(MEASURED_CLAIM);
    expect(create.queries).toBeLessThanOrEqual(50);
  });
});

const APP_ORIGIN = "https://app.example.com";
const REDIRECT = "https://client.example.com/callback";

/** The options of the OAuth provider. */
const OAUTH_OPTIONS = {
  resources: [`${API}/mcp`],
  scopes: { "mcp:read": "Read" },
  registration: { cimd: false, dynamic: true },
};

/** The OAuth provider, so a user can hold refresh families (ruling 55 of plan 12d). */
const OAUTH: Partial<AuthConfig> = { trustedOrigins: [APP_ORIGIN], oauth: OAUTH_OPTIONS };

const base64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** `n` refresh families of the session of `token` through the code flow: the client and each refresh token. */
async function families(auth: ReturnType<typeof make>, token: string, n: number) {
  const reg = await auth.handle(
    new Request(`${API}/auth/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    }),
  );
  if (reg.status !== 201) throw new Error(`register answered ${reg.status}`);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const cookie = `__Host-tempo_session=${token}`;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const challenge = base64Url(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read offline_access",
      resource: `${API}/mcp`,
      state: "st-1",
    });
    const page = await auth.handle(
      new Request(`${API}/auth/oauth/authorize?${query}`, { headers: { cookie } }),
    );
    let location = page.headers.get("location");
    if (page.status === 200) {
      const id = /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
      const done = await auth.handle(
        new Request(`${API}/auth/oauth/authorize`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: API,
            cookie,
          },
          body: new URLSearchParams({ request_id: id ?? "", decision: "allow" }).toString(),
        }),
      );
      location = done.headers.get("location");
    }
    const code = new URL(location ?? "").searchParams.get("code");
    if (!code) throw new Error("no code");
    const res = await auth.handle(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: `${API}/mcp`,
      }),
    );
    if (res.status !== 200) throw new Error(`token answered ${res.status}`);
    out.push(((await res.json()) as { refresh_token: string }).refresh_token);
  }
  return { clientId, tokens: out };
}

const tokenRequest = (body: Record<string, string>, path = "/token") =>
  new Request(`${API}/auth/oauth${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

/** The refresh of each token: each status. */
async function refreshes(auth: ReturnType<typeof make>, clientId: string, tokens: string[]) {
  const out: number[] = [];
  for (const t of tokens)
    out.push(
      (
        await auth.handle(
          tokenRequest({ grant_type: "refresh_token", refresh_token: t, client_id: clientId }),
        )
      ).status,
    );
  return out;
}

const pendingRows = async () =>
  Number(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM ta_verification WHERE purpose = 'session-end'",
    ).first("n"),
  );

/** The end marks of the refresh families: one per family that ended. */
const familyMarks = async () =>
  Number(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM ta_verification WHERE purpose = 'oauth-family-end'",
    ).first("n"),
  );

describe("the OAuth families of a SCIM deactivate on D1 (ruling 55 of plan 12d)", () => {
  for (const k of [0, 7, 20])
    it(`deactivates a user with 40 sessions and ${k} families in 50 queries, and refuses each family at once`, async () => {
      const setup = make(env.DB, false, OAUTH);
      const { token } = await acme(setup);
      const { token: first } = await signIn(setup, ADA);
      for (let i = 1; i < 40; i++) await signIn(setup, ADA);
      const create = await counted(token, "POST", "/Users", { schemas: [USER_URN], userName: ADA });
      expect(create.status).toBe(201);
      const id = String(create.body.id);
      const { clientId, tokens } = await families(setup, first, k);
      const { db, c } = counting(env.DB);
      const res = await make(db, true, OAUTH).handle(
        new Request(`${API}/auth/scim/v2/Users/${id}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/scim+json",
          },
          body: JSON.stringify({
            schemas: [PATCH_URN],
            Operations: [{ op: "replace", path: "active", value: false }],
          }),
        }),
      );
      expect(res.status).toBe(200);
      const off = c.n;
      const ended = 40 - (await sessions());
      const marked = await familyMarks();
      // Each family is refused at once, before any sweep.
      expect(await refreshes(make(env.DB, false, OAUTH), clientId, tokens)).toEqual(
        Array(k).fill(400),
      );
      const sweeps: number[] = [];
      while ((await pendingRows()) > 0) {
        const { db: sdb, c: sc } = counting(env.DB);
        await make(sdb, true, OAUTH).api.sweepExpired();
        sweeps.push(sc.n);
        if (sweeps.length > 10) throw new Error("the sweep makes no progress");
      }
      expect(await sessions()).toBe(0);
      // Every family has its end mark after the sweep.
      expect(await familyMarks()).toBe(k);
      // Measured on the binding on 2026-10-24; see the ledger of plan 12d Task 11.
      expect([off, ended, marked, sweeps]).toEqual(FAMILY_COUNTS[k]);
      for (const n of [off, ...sweeps]) expect(n).toBeLessThanOrEqual(50);
    }, 120_000);
});

/**
 * The counts of the deactivate of a user with 40 sessions, a session.afterEnd
 * hook, and k OAuth refresh families, on the binding, 2026-10-24: the
 * queries of the deactivate, the sessions it ended, the families it ended
 * with their marks, and the queries of each sweep (ruling 55 of plan 12d).
 * The families come first in the budget, and a page of one session stays.
 * The pending-end row names the families that do not fit, and the sweep
 * ends them with 2 queries each.
 */
const FAMILY_COUNTS: Record<number, [number, number, number, number[]]> = {
  0: [49, 10, 0, [48, 29]],
  7: [49, 2, 4, [48, 43]],
  20: [49, 2, 4, [48, 49, 43]],
};

const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";

describe("the deactivate of a User in groups on D1 (ruling 63 M1 of plan 12d)", () => {
  for (const g of [1, 2])
    for (const k of [0, 20])
      it(`deactivates a user in ${g} groups with 40 sessions and ${k} families in 50 queries`, async () => {
        const setup = make(env.DB, false, OAUTH);
        const { token } = await acme(setup);
        const { token: first } = await signIn(setup, ADA);
        for (let i = 1; i < 40; i++) await signIn(setup, ADA);
        const create = await counted(token, "POST", "/Users", {
          schemas: [USER_URN],
          userName: ADA,
        });
        expect(create.status).toBe(201);
        const id = String(create.body.id);
        for (let i = 0; i < g; i++) {
          const group = await counted(token, "POST", "/Groups", {
            schemas: [GROUP_URN],
            displayName: `Group ${i}`,
            members: [{ value: id }],
          });
          expect(group.status).toBe(201);
        }
        await families(setup, first, k);
        const { db, c } = counting(env.DB);
        const res = await make(db, true, OAUTH).handle(
          new Request(`${API}/auth/scim/v2/Users/${id}`, {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/scim+json",
            },
            body: JSON.stringify({
              schemas: [PATCH_URN],
              Operations: [{ op: "replace", path: "active", value: false }],
            }),
          }),
        );
        expect(res.status).toBe(200);
        // The answer reads the groups after the commit, inside the budget.
        const body = (await res.json()) as { groups?: unknown[] };
        expect(body.groups?.length).toBe(g);
        const off = c.n;
        const ended = 40 - (await sessions());
        // Measured on the binding on 2026-10-24; see the ledger of plan 12d Task 11.
        expect([off, ended, await familyMarks()]).toEqual(GROUPED_COUNTS[`${g}/${k}`]);
        expect(off).toBeLessThanOrEqual(50);
      }, 120_000);
});

/**
 * The counts of the deactivate of a user in g groups, with 40 sessions, a
 * session.afterEnd hook, and k OAuth refresh families, on the binding,
 * 2026-10-24: the queries, the sessions that the deactivate ended, and the
 * families that it ended with their marks. The answer reads the
 * scimGroupMember rows and the scimGroup rows after the commit. The page
 * keeps a call for that read (ruling 63 M1 of plan 12d).
 */
const GROUPED_COUNTS: Record<string, [number, number, number]> = {
  "1/0": [50, 10, 0],
  "1/20": [50, 2, 4],
  "2/0": [50, 10, 0],
  "2/20": [50, 2, 4],
};

/** One refresh on a counting view of the binding: its status, queries, and reads of ta_verification. */
async function countedRefresh(clientId: string, refreshToken: string) {
  const { db, c } = counting(env.DB);
  const res = await make(db, true, OAUTH).handle(
    tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  );
  const pending = c.sql.filter((q) => /purpose"?\s+IN/i.test(q)).length;
  return { status: res.status, queries: c.n, pending };
}

/**
 * Writes a refresh row of a race: a copy of `row` with a new id, token, and
 * family. On Postgres such a row commits after the token delete of the act
 * began (core test/scim/users.test.ts writes it inside the transaction). D1
 * sends the act as one batch, so the row comes after it here. The door reads
 * the same rows, so the count is the count of the door. Answers the token.
 */
async function raceRow(row: Record<string, unknown>, mark: string, familyId: unknown) {
  const token = `or_${base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer)}`;
  const copy: Record<string, unknown> = {
    ...row,
    id: `${String(row.id).slice(0, 10)}${mark.repeat(16)}`,
    token_hash: await sha256Hex(token),
    family_id: familyId,
    used_at: null,
    parent_id: null,
  };
  const keys = Object.keys(copy);
  await env.DB.prepare(
    `INSERT INTO ta_oauth_token (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
  )
    .bind(...keys.map((k) => copy[k]))
    .run();
  return token;
}

describe("the family door of a SCIM deactivate on D1 (ruling 56 of plan 12d)", () => {
  it("refuses a family that the act did not delete, on the pending-end row and on the record", async () => {
    const setup = make(env.DB, false, OAUTH);
    const { token } = await acme(setup);
    const { token: first } = await signIn(setup, ADA);
    for (let i = 1; i < 40; i++) await signIn(setup, ADA);
    const create = await counted(token, "POST", "/Users", { schemas: [USER_URN], userName: ADA });
    expect(create.status).toBe(201);
    const id = String(create.body.id);
    const { clientId, tokens } = await families(setup, first, 20);
    const last = await env.DB.prepare(
      "SELECT * FROM ta_oauth_token WHERE user_id = (SELECT id FROM ta_user WHERE email = ?) ORDER BY id DESC LIMIT 1",
    )
      .bind(ADA)
      .first<Record<string, unknown>>();
    if (!last) throw new Error("no refresh row");
    // A family that began after the last write of its user reads no row.
    const fresh = await countedRefresh(clientId, tokens[0] ?? "");
    expect(fresh.status).toBe(200);
    const off = await make(env.DB, false, OAUTH).handle(
      new Request(`${API}/auth/scim/v2/Users/${id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
        body: JSON.stringify({
          schemas: [PATCH_URN],
          Operations: [{ op: "replace", path: "active", value: false }],
        }),
      }),
    );
    expect(off.status).toBe(200);
    // A race row of a family that the pending-end row names: the act did not delete it.
    const row = await env.DB.prepare(
      "SELECT data FROM ta_verification WHERE purpose = 'session-end'",
    ).first<{ data: string }>();
    expect(JSON.parse(row?.data ?? "{}").families).toContain(last.family_id);
    const named = await countedRefresh(clientId, await raceRow(last, "Z", last.family_id));
    while ((await pendingRows()) > 0) {
      await make(env.DB, false, OAUTH).api.sweepExpired();
    }
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM ta_verification WHERE purpose = 'session-end-record'",
      ).first("n"),
    ).toBe(1);
    // After every sweep, a race row of a family that no row names: the record refuses it.
    const family = `${String(last.family_id).slice(0, 10)}${"Y".repeat(16)}`;
    const record = await countedRefresh(clientId, await raceRow(last, "Y", family));
    expect([fresh, named, record].map((r) => [r.status, r.queries, r.pending])).toEqual(
      DOOR_COUNTS,
    );
    for (const r of [fresh, named, record]) expect(r.queries).toBeLessThanOrEqual(50);
  }, 120_000);
});

/**
 * The refresh grant on the binding, 2026-10-22 (ruling 56 of plan 12d): the
 * status, the queries, and the reads of the pending-end rows and records.
 * A family that began after the last write of its user reads no row: 11
 * queries with the new tokens (`fresh`). A family from before that write
 * reads the rows once, +1 query (`familyRevoked`). The refused refresh then
 * ends the family with its mark and its delete, in 9 queries in all. That
 * holds for a family on the pending-end row (`named`) and for a family that
 * only the record covers after every sweep (`record`).
 */
const DOOR_COUNTS = [
  [200, 11, 0],
  [400, 9, 1],
  [400, 9, 1],
];

/** An OIDC connection, so the role map applies (ruling 63 M2 of plan 12d). */
const MAPPED: Partial<AuthConfig> = {
  sso: {
    oidc: true,
    dns: [{ name: "a", txt: async (name) => txt[name] ?? [] }],
    fetch: async () => Response.json({}),
  },
};

/** One SCIM request on `auth`: its status and body. */
async function scimOn(
  auth: ReturnType<typeof make>,
  token: string,
  method: string,
  path: string,
  body: unknown,
) {
  const res = await auth.handle(
    new Request(`${API}/auth/scim/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    body: (text === "" ? null : JSON.parse(text)) as Record<string, unknown>,
  };
}

/** The role of the member row of a user, or null. */
const roleOf = async (userId: string) =>
  (
    await env.DB.prepare("SELECT role FROM ta_member WHERE user_id = ?")
      .bind(userId)
      .first<{ role: string }>()
  )?.role ?? null;

/** The sessions of a user, by id: an address move keeps them. */
const sessionsOf = async (userId: string) =>
  Number(
    await env.DB.prepare("SELECT count(*) AS n FROM ta_session WHERE user_id = ?")
      .bind(userId)
      .first("n"),
  );

/** The user row of ada. */
const adaUser = () =>
  env.DB.prepare("SELECT id FROM ta_user WHERE email = ?").bind(ADA).first<{ id: string }>();

/** The challenges and handoff codes of a user. */
const codesOf = async (userId: string) =>
  Number(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM ta_verification WHERE identifier = ? AND purpose IN ('two-factor', 'handoff-code')",
    )
      .bind(userId)
      .first("n"),
  );

/** The role map, the OAuth provider with the device grant, and the JWT mint: every door of a race test. */
const RACED: Partial<AuthConfig> = {
  ...OAUTH,
  oauth: { ...OAUTH_OPTIONS, device: {} },
  ...MAPPED,
  ...MINT,
};

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * An OAuth code that is not yet exchanged, and an approved device row that
 * no poll spent yet, of the session of `token` (ruling 69 of plan 12d):
 * the requests that would give each its tokens.
 */
async function waitingGrants(auth: ReturnType<typeof make>, token: string) {
  const reg = await auth.handle(
    new Request(`${API}/auth/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
      }),
    }),
  );
  if (reg.status !== 201) throw new Error(`register answered ${reg.status}`);
  const clientId = ((await reg.json()) as { client_id: string }).client_id;
  const cookie = `__Host-tempo_session=${token}`;
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const challenge = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp:read offline_access",
    resource: `${API}/mcp`,
    state: "st-1",
  });
  const page = await auth.handle(
    new Request(`${API}/auth/oauth/authorize?${query}`, { headers: { cookie } }),
  );
  let location = page.headers.get("location");
  if (page.status === 200) {
    const id = /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
    const done = await auth.handle(
      new Request(`${API}/auth/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: API, cookie },
        body: new URLSearchParams({ request_id: id ?? "", decision: "allow" }).toString(),
      }),
    );
    location = done.headers.get("location");
  }
  const code = new URL(location ?? "").searchParams.get("code");
  if (!code) throw new Error("no code");
  const started = await auth.handle(
    tokenRequest(
      { client_id: clientId, scope: "mcp:read", resource: `${API}/mcp` },
      "/device_authorization",
    ),
  );
  if (started.status !== 200) throw new Error(`device_authorization answered ${started.status}`);
  const { device_code, user_code } = (await started.json()) as {
    device_code: string;
    user_code: string;
  };
  const approved = await auth.handle(
    new Request(`${API}/auth/oauth/device`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: API, cookie },
      body: new URLSearchParams({ user_code, decision: "allow" }).toString(),
    }),
  );
  if (!(await approved.text()).includes("The device is connected.")) throw new Error("no approval");
  return {
    exchange: () =>
      tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: `${API}/mcp`,
      }),
    poll: () => tokenRequest({ grant_type: DEVICE_GRANT, device_code, client_id: clientId }),
  };
}

/** One token request on a counting view of the binding: its status, queries, and pending-end reads. */
async function countedToken(request: Request) {
  const { db, c } = counting(env.DB);
  const res = await make(db, true, RACED).handle(request);
  await res.text();
  const pending = c.sql.filter((q) => /FROM\s+"?ta_verification/i.test(q) && /purpose/i.test(q));
  return [res.status, c.n, pending.filter((q) => /IN\s*\(/i.test(q)).length];
}

describe("a deprovision that races a mapped group write on D1 (rulings 63 M2 and 66 of plan 12d)", () => {
  // A group write changes ada's role before each of the first `races` member reads under
  // the user hold. The before hook of that round saw the old role, so the round runs again.
  // At `delete`, the group write comes after that read, before the member delete: D1 has no
  // lock, so the delete matches no row. A round that does not fit the budget is small: it
  // ends no session and no family, and its pending-end row covers them all (ruling 66).
  // A PATCH with `move` also moves the address, and with `name` it fills the empty name of
  // the user too. With `fill` it fills the name only. Each round then runs more calls
  // (ruling 69 of plan 12d).
  const cases: [string, number, "PATCH" | "DELETE", "" | "move" | "name" | "fill"][] = [
    ["findOne", 1, "PATCH", ""],
    ["findOne", 2, "PATCH", ""],
    ["findOne", 3, "PATCH", ""],
    ["findOne", 3, "DELETE", ""],
    ["delete", 1, "PATCH", ""],
    ["delete", 1, "DELETE", ""],
    ["delete", 2, "DELETE", ""],
    ["findOne", 4, "PATCH", ""],
    ["findOne", 1, "PATCH", "move"],
    ["findOne", 2, "PATCH", "move"],
    ["findOne", 1, "PATCH", "name"],
    ["findOne", 2, "PATCH", "name"],
    ["findOne", 4, "DELETE", ""],
    ["delete", 2, "PATCH", ""],
    ["delete", 1, "PATCH", "move"],
    ["findOne", 2, "PATCH", "fill"],
    ["findOne", 3, "PATCH", "fill"],
  ];
  const opsOf = {
    "": [],
    move: [{ op: "replace", path: "userName", value: "ada.new@acme.example" }],
    name: [
      { op: "replace", path: "userName", value: "ada.new@acme.example" },
      { op: "replace", path: "displayName", value: "Ada Lovelace" },
    ],
    fill: [{ op: "replace", path: "displayName", value: "Ada Lovelace" }],
  };
  const withOps = {
    fill: " with a name fill",
    "": "",
    move: " with an address move",
    name: " with an address move and a name fill",
  };
  for (const [at, races, method, ops] of cases)
    it(`answers a ${method}${withOps[ops]} inside 50 queries when ${races} group writes race it at ${at}`, async () => {
      const setup = make(env.DB, false, RACED);
      const { organizationId, token } = await acme(setup);
      const sso = setup.api.sso;
      const scim = setup.api.scim;
      if (!sso || !scim) throw new Error("no sso or scim api");
      const connection = await sso.connections.create({
        actor: APP,
        organizationId,
        kind: "oidc",
        label: "Acme IdP",
        issuer: "https://login.acme-idp.example",
        clientId: "acme-client",
        clientSecret: "acme-secret-0123456789",
        endpoints: {
          authorizeUrl: "https://login.acme-idp.example/authorize",
          tokenUrl: "https://login.acme-idp.example/token",
          jwksUrl: "https://login.acme-idp.example/keys",
        },
      });
      if (!connection.ok) throw new Error(connection.code);
      const map = await scim.setRoleMap({ actor: APP, organizationId, map: { Admins: "admin" } });
      if (!map.ok) throw new Error(map.code);
      const tokens: string[] = [];
      for (let i = 0; i < 40; i++) tokens.push((await signIn(setup, ADA)).token);
      const create = await scimOn(setup, token, "POST", "/Users", {
        schemas: [USER_URN],
        userName: ADA,
      });
      expect(create.status).toBe(201);
      const id = String(create.body.id);
      const group = await scimOn(setup, token, "POST", "/Groups", {
        schemas: [GROUP_URN],
        displayName: "Admins",
        members: [{ value: id }],
      });
      expect(group.status).toBe(201);
      const userId = String((await adaUser())?.id);
      expect(await roleOf(userId)).toBe("admin");
      const gid = String(group.body.id);
      const fams = await families(setup, tokens[0] ?? "", 3);
      // A code and a device row from before the act, which a small round keeps (ruling 69).
      const waiting = await waitingGrants(setup, tokens[0] ?? "");
      // A challenge and a handoff code of ada: each one can make a session after the act.
      for (const purpose of ["two-factor", "handoff-code"] as const) {
        const made = new Date();
        await createD1Adapter(env.DB).create("verification", {
          id: `${purpose}-of-ada`,
          purpose,
          identifier: userId,
          valueHash: await sha256Hex(purpose),
          expiresAt: new Date(made.getTime() + 600_000),
          consumedAt: null,
          data: null,
          secretVersion: 1,
          createdAt: made,
          updatedAt: made,
        });
      }
      let lost = 0;
      const { db, c } = counting(env.DB);
      const base = createD1Adapter(db);
      // The group write runs on the binding itself, so its queries do not count. It runs
      // before each member read under the user hold, so that read sees a new role.
      const race = async () => {
        lost++;
        const op =
          (await roleOf(userId)) === "admin"
            ? { op: "remove", path: `members[value eq "${id}"]` }
            : { op: "add", path: "members", value: [{ value: id }] };
        const r = await scimOn(make(env.DB, false, RACED), token, "PATCH", `/Groups/${gid}`, {
          schemas: [PATCH_URN],
          Operations: [op],
        });
        if (r.status !== 204) throw new Error(`the group write answered ${r.status}`);
      };
      const member = (args: unknown[]) => args[0] === "member" && lost < races;
      const inTx = (tx: StorageAdapter): StorageAdapter =>
        new Proxy(tx, {
          get(t, k) {
            const v = Reflect.get(t, k);
            if (typeof v !== "function") return v;
            if (k !== at) return v.bind(t);
            return async (...args: unknown[]) => {
              if (member(args)) await race();
              return v.apply(t, args);
            };
          },
        });
      const tapped = new Proxy(base, {
        get(t, k) {
          if (k === "transaction")
            return <R>(fn: (tx: StorageAdapter) => Promise<R>) =>
              t.transaction((tx) => fn(inTx(tx)));
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as StorageAdapter;
      const res = await scimOn(
        make(db, true, { ...RACED, storage: tapped }),
        token,
        method,
        `/Users/${id}`,
        method === "DELETE"
          ? undefined
          : {
              schemas: [PATCH_URN],
              Operations: [{ op: "replace", path: "active", value: false }, ...opsOf[ops]],
            },
      );
      const queries = c.n;
      const key = `${method}${ops ? ` ${ops}` : ""} ${at}/${races}`;
      const ended = 40 - (await sessionsOf(userId));
      const marked = await familyMarks();
      const role = await roleOf(userId);
      // Every family that the act did not end is named on its pending-end row, for the sweep.
      const rows = await env.DB.prepare(
        "SELECT data FROM ta_verification WHERE purpose = 'session-end'",
      ).all<{ data: string }>();
      const named = rows.results.flatMap((r) => JSON.parse(r.data).families ?? []).length;
      expect(marked + named).toBe(res.status === 409 ? 0 : 3);
      // Each session and each family is refused at once, before any sweep, unless the
      // answer is 409: then nothing changed.
      const after = make(env.DB, false, RACED);
      const live: boolean[] = [];
      for (const t of tokens) live.push((await after.api.getSession(t)) !== null);
      const refreshed = await refreshes(after, fams.clientId, fams.tokens);
      const done = res.status !== 409;
      expect(live).toEqual(Array(40).fill(!done));
      expect(refreshed).toEqual(Array(3).fill(done ? 400 : 200));
      expect(await codesOf(userId)).toBe(done ? 0 : 2);
      // The code and the device row from before the act give no token after it (ruling 69).
      const grants = [await countedToken(waiting.exchange()), await countedToken(waiting.poll())];
      expect(grants.map((g) => g[0])).toEqual(done ? [400, 400] : [200, 200]);
      for (const g of grants) expect(g[1]).toBeLessThanOrEqual(50);
      expect(grants).toEqual(GRANT_COUNTS[key]);
      // The sweep ends the sessions and the families that stay, each family with its mark.
      if (done) {
        for (let i = 0; (await pendingRows()) > 0; i++) {
          if (i > 10) throw new Error("the sweep makes no progress");
          await make(env.DB, false, RACED).api.sweepExpired();
        }
        expect([await sessionsOf(userId), await familyMarks()]).toEqual([0, 3]);
      }
      // Measured on the binding on 2026-10-24; see the ledger of plan 12d Task 11.
      expect([res.status, queries, lost, ended, marked, role]).toEqual(RACE_COUNTS[key]);
      expect(queries).toBeLessThanOrEqual(50);
    }, 120_000);
});

/**
 * A deprovision of a user in a mapped group, with 40 sessions, a
 * session.afterEnd hook, and 3 OAuth refresh families, when a group write
 * changes the role before the member read under the user hold, on the
 * binding, 2026-10-24: the status, the queries, the lost rounds, the ended
 * sessions, the families ended with their marks, and the role that stays.
 * A lost round costs 5 queries. After one, a full round fits and ends a
 * page. After two, the next round is small (ruling 66 of plan 12d): it
 * ends no session and no family, and its pending-end row covers them all,
 * so each door refuses them at once. A PATCH lost at the member delete
 * costs more, with its undo, so a small round follows. After three lost
 * rounds no round fits, and the answer is 409 with no change. Before ruling
 * 74 item 16 that took four: the small round now reads the newest OAuth
 * code and approved device row, 2 queries more (measured 2026-10-24).
 *
 * An address move adds `MOVE_CALLS` 7 to each guard, and a name fill
 * `NAME_CALLS` 2 (ruling 69 of plan 12d). So after one lost round at the
 * member read no small round of a move fits, and the answer is 409. A move
 * with a name fill answers 409 after one lost round too, so each case of
 * two races loses one round only. A name fill alone answers 409 after
 * three. At the member delete, a deactivate with no move answers 409 after
 * two lost rounds, and a move after one. A DELETE answers 409 after three
 * at the member read. In a 409 the role is the one of the
 * last group write: member when it took the admin role. The deprovision
 * wrote nothing. The move of a deactivate runs after its member delete, so
 * a round lost there undoes no move. With the move first, that case made
 * 71 queries: its undo wrote back 40 proofs of the old address.
 *
 * A DELETE at `delete` drops the scimGroupMember rows of the User first,
 * and D1 commits each statement at once. So the group write that the test
 * runs there changes no role: `lost` counts that write, but no round is
 * lost, and a full round ends a page. With 2 races the second write never
 * comes, so the answer is the one of 1 race (ruling 74 item 15, measured
 * 2026-10-24). A write of another mapped group can still change the role
 * there. Then a DELETE meets the guard of the PATCH at `delete/2`: after
 * 2 lost rounds at the member delete, no small round fits, and the answer
 * is 409. The routes page states that case.
 */
const RACE_COUNTS: Record<string, [number, number, number, number, number, string | null]> = {
  "PATCH findOne/1": [200, 49, 1, 1, 2, null],
  "PATCH findOne/2": [200, 46, 2, 0, 0, null],
  "PATCH findOne/3": [409, 23, 3, 0, 0, "member"],
  "DELETE findOne/3": [409, 23, 3, 0, 0, "member"],
  "PATCH delete/1": [200, 48, 1, 0, 0, null],
  "DELETE delete/1": [204, 48, 1, 4, 3, null],
  "DELETE delete/2": [204, 48, 1, 4, 3, null],
  "PATCH findOne/4": [409, 23, 3, 0, 0, "member"],
  "PATCH move findOne/1": [409, 16, 1, 0, 0, "member"],
  "PATCH move findOne/2": [409, 16, 1, 0, 0, "member"],
  "PATCH name findOne/1": [409, 16, 1, 0, 0, "member"],
  "PATCH name findOne/2": [409, 16, 1, 0, 0, "member"],
  "DELETE findOne/4": [409, 23, 3, 0, 0, "member"],
  "PATCH delete/2": [409, 34, 2, 0, 0, "admin"],
  "PATCH move delete/1": [409, 24, 1, 0, 0, "member"],
  "PATCH fill findOne/2": [200, 48, 2, 0, 0, null],
  "PATCH fill findOne/3": [409, 23, 3, 0, 0, "member"],
};

/**
 * The code exchange and the device poll of a code and a device row from
 * before the act, after it, on the binding, 2026-10-24 (ruling 69 of plan
 * 12d): the status, the queries, and the reads of the pending-end rows. A
 * full round deletes both, so each answers 400 in 5 queries with no read.
 * A small round keeps both. The door then reads the pending-end rows once
 * (`familyRevoked`, +1 query) and refuses: the exchange in 7 queries, the
 * poll in 9. After a 409 each gives its tokens: the exchange in 12 queries,
 * the poll in 11, and neither reads the rows, as each started after the
 * last write of the user.
 */
const REFUSED_SMALL = [
  [400, 7, 1],
  [400, 9, 1],
];
const REFUSED_FULL = [
  [400, 5, 0],
  [400, 5, 0],
];
const GRANTED = [
  [200, 12, 0],
  [200, 11, 0],
];
const GRANT_COUNTS: Record<string, number[][]> = {
  "PATCH findOne/1": REFUSED_FULL,
  "PATCH findOne/2": REFUSED_SMALL,
  "PATCH findOne/3": GRANTED,
  "DELETE findOne/3": GRANTED,
  "PATCH delete/1": REFUSED_SMALL,
  "DELETE delete/1": REFUSED_FULL,
  "DELETE delete/2": REFUSED_FULL,
  "PATCH findOne/4": GRANTED,
  "PATCH move findOne/1": GRANTED,
  "PATCH move findOne/2": GRANTED,
  "PATCH name findOne/1": GRANTED,
  "PATCH name findOne/2": GRANTED,
  "DELETE findOne/4": GRANTED,
  "PATCH delete/2": GRANTED,
  "PATCH move delete/1": GRANTED,
  "PATCH fill findOne/2": REFUSED_SMALL,
  "PATCH fill findOne/3": GRANTED,
};
