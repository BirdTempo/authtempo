import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, hookRefusal } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The queries of one SSO callback on the D1 binding (plan 12d Task 5, Task
// 4b question Q2). D1 Free allows 50 queries per invocation (D1 limits page
// updated 21 April 2026, read 2026-10-21). The callback is one request, so
// it is one invocation. The start is another request. The fake IdP answers
// the code exchange, the one subrequest of a connection with endpoints. The
// jwt seam is a fake too, so no JWKS fetch runs here.

const BASE = "https://api.example.com";
const APP = { kind: "app", name: "sso-budget" } as const;

/**
 * A view of `db` that counts each statement, and each statement of a batch.
 * `sql` keeps the text of each prepared statement.
 */
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

/**
 * The engine on `db`, with organizations, OIDC connections, the fake DNS,
 * and the fake IdP. `extra` replaces a top key of the config.
 */
function make(
  db: D1Database,
  txt: Record<string, string[]>,
  idTokens: Record<string, object>,
  mail: string[] = [],
  extra: Partial<AuthConfig> = {},
) {
  return createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    limiter: { allow: async () => true },
    mail: { send: async (m) => void mail.push(m.text) },
    password: {},
    organizations: {},
    sso: {
      oidc: true,
      dns: [{ name: "a", txt: async (name) => txt[name] ?? [] }],
      fetch: async (_url, init) => {
        const code = new URLSearchParams(typeof init?.body === "string" ? init.body : "").get(
          "code",
        );
        return Response.json({ id_token: code, token_type: "Bearer" });
      },
    },
    jwt: {
      verifyIdToken: async (input) => {
        const claims = idTokens[input.token];
        if (!claims) throw new Error("fake jwt: verify failed");
        return claims as Record<string, unknown>;
      },
      signES256: async () => "es256",
    },
    ...extra,
  });
}

/** The organization acme with its verified domain and one OIDC connection, on the binding. */
async function world(extra: Partial<AuthConfig> = {}) {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const txt: Record<string, string[]> = {};
  const idTokens: Record<string, object> = {};
  const mail: string[] = [];
  const auth = make(env.DB, txt, idTokens, mail, extra);
  const sso = auth.api.sso;
  if (!sso) throw new Error("no sso api");
  // The owner signs in by a magic link, so the user is verified by the product.
  await auth.api.requestMagicLink({ email: "owner@acme.example", ip: null });
  const link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "");
  const owner = await auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
  if (!owner.ok || !("token" in owner.value)) throw new Error("no owner");
  const made = await auth.api.createOrganization({
    user: owner.value.user,
    slug: "acme",
    name: "Acme",
  });
  if (!made.ok) throw new Error(made.code);
  const organizationId = made.value.organization.id;
  const domain = await sso.domains.add({ actor: APP, organizationId, domain: "acme.example" });
  if (!domain.ok || domain.value.record === null) throw new Error("no domain");
  txt[domain.value.record.name] = [domain.value.record.value];
  const verified = await sso.domains.verify({ actor: APP, id: domain.value.id });
  if (!verified.ok) throw new Error(verified.code);
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
  return { auth, txt, idTokens, mail, extra, connectionId: connection.value.id };
}

type World = Awaited<ReturnType<typeof world>>;

/** One callback for Ada, on a counting view of the binding. */
async function callback(w: World, code: string) {
  const started = await w.auth.handle(new Request(`${BASE}/auth/sso/${w.connectionId}/start`));
  const url = new URL(started.headers.get("location") ?? "");
  const bind = started.headers
    .getSetCookie()
    .find((x) => x.startsWith("__Secure-tempo_session_oauth="))
    ?.split(";")[0];
  w.idTokens[code] = {
    sub: "ada-1",
    email: "ada@acme.example",
    nonce: url.searchParams.get("nonce") ?? "",
  };
  const q = new URLSearchParams({ code, state: url.searchParams.get("state") ?? "" });
  const { db, c } = counting(env.DB);
  const res = await make(db, w.txt, w.idTokens, [], w.extra).handle(
    new Request(`${BASE}/auth/sso/${w.connectionId}/callback?${q}`, {
      headers: { cookie: bind ?? "" },
    }),
  );
  const at = new URL(res.headers.get("location") ?? "", BASE).searchParams;
  const token = res.headers
    .getSetCookie()
    .find((x) => x.startsWith("__Host-tempo_session="))
    ?.split(";")[0]
    ?.split("=")[1];
  return {
    n: c.n,
    sql: c.sql,
    error: at.get("auth_error"),
    challenge: at.get("challenge"),
    token: token ? decodeURIComponent(token) : null,
  };
}

/**
 * An unverified password sign-up of Ada. The token of its session, or null
 * under the uniform answer of plan 12b.
 */
async function claimant(w: World): Promise<string | null> {
  const up = await w.auth.api.password?.signUp({
    email: "ada@acme.example",
    password: "a claimant's password",
    ip: null,
    userAgent: null,
  });
  if (!up?.ok) throw new Error("no claimant");
  return "token" in up.value ? up.value.token : null;
}

/** Ada with a verified password and the second factor on, by the enable of plan 9f. */
async function withFactor(w: World): Promise<void> {
  const password = "correct horse battery";
  const up = await w.auth.api.password?.signUp({
    email: "ada@acme.example",
    password,
    ip: null,
    userAgent: null,
  });
  if (!up?.ok) throw new Error("no sign-up");
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(w.mail.at(-1) ?? "")?.[1] ?? "");
  const v = await w.auth.api.password?.verifyEmail({ token, ip: null, userAgent: null });
  if (!v?.ok || v.value.signedIn === null) throw new Error("the verify link did not sign in");
  const session = await w.auth.api.getSession(v.value.signedIn.token);
  const totp = w.auth.api.totp;
  if (!session || !totp) throw new Error("no session or no totp");
  const setup = await totp.setup({ session, password });
  if (!setup.ok) throw new Error(setup.code);
  const code = await totpCode(base32Decode(setup.value.secret), new Date());
  const on = await totp.enable({ session, code });
  if (!on.ok) throw new Error(on.code);
}

/**
 * The queries of two callbacks for one address. The first callback of
 * "create" creates the user and the member row just in time. The first of
 * "claim" claims an unverified password sign-up at the address. The first
 * of "factor" links a verified user with the second factor on. The second
 * callback signs in the known identity.
 */
async function callbacks(kind: "create" | "claim" | "factor"): Promise<number[]> {
  const w = await world();
  if (kind === "claim") await claimant(w);
  if (kind === "factor") await withFactor(w);
  const counts: number[] = [];
  for (const code of ["code-1", "code-2"]) {
    const r = await callback(w, code);
    if (r.error !== null) throw new Error(r.error);
    // The gate answers a challenge, not a session, for a user with the factor on.
    if ((r.challenge !== null) !== (kind === "factor")) throw new Error("a wrong answer kind");
    counts.push(r.n);
  }
  return counts;
}

describe("the queries of one SSO callback on D1 (plan 12d Task 5)", () => {
  it("stays inside 50 queries for a create, a known identity, a claim, and the factor", async () => {
    const created = await callbacks("create");
    const claimed = await callbacks("claim");
    const factor = await callbacks("factor");
    // Measured on the binding on 2026-10-21 (load 18.2): a create 23, a claim 35,
    // and a known identity 15 after each. The first callback of each pair adds
    // the member row; the claim also ends the claimant's rows. With the second
    // factor on, each callback writes a challenge. Measured on 2026-10-22 (load
    // 4.1 to 15.2): a link of a verified user 21, and the known identity 11 after it.
    // Update 2026-11-05 by plan 12q: each callback that opens a session reads the
    // cap (+1). A callback of the factor writes a challenge: no session.
    // Measured 2026-11-05 09:27 CST on the owner's Mac Studio, load 23.55 17.66 14.94.
    expect({ created, claimed, factor }).toEqual({
      created: [24, 16],
      // Update 2026-11-04 by plan 12p: the claim writes the lease (+1).
      // Run of 2026-11-04 20:24 CST on the owner's Mac Studio, load 7.5 9.1 7.9.
      claimed: [37, 16],
      factor: [21, 11],
    });
    for (const n of [...created, ...claimed, ...factor]) expect(n).toBeLessThanOrEqual(50);
  }, 120_000);
});

describe("the refusal of a known identity whose user left the domain on D1 (12d fix wave M1)", () => {
  it("reads the current address of the user and stays inside 50 queries", async () => {
    const w = await world();
    const first = await callback(w, "code-1");
    if (first.error !== null || first.token === null) throw new Error("no first sign-in");
    const session = await w.auth.api.getSession(first.token);
    if (!session) throw new Error("no session");
    // Ada moves the account address out of the domain by the normal email change.
    const sent = await w.auth.api.user.changeEmail({ session, newEmail: "ada@personal.example" });
    if (!sent.ok) throw new Error(sent.code);
    const link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(w.mail.at(-1) ?? "")?.[1] ?? "");
    const moved = await w.auth.api.user.confirmEmailChange({
      token: link,
      ip: null,
      userAgent: null,
    });
    if (!moved.ok) throw new Error(moved.code);
    const again = await callback(w, "code-2");
    expect([again.error, again.token]).toEqual(["sso_domain_mismatch", null]);
    // Measured on the binding on 2026-10-24 (load 4.2): 8 queries. The refusal comes
    // before the first write of the resolution.
    expect(again.n).toBe(8);
    expect(again.n).toBeLessThanOrEqual(50);
  }, 120_000);
});

/**
 * Ada's unverified sign-up, then one callback that `extra` refuses. It
 * expects `code`, no write of a row of Ada, and Ada's rows as they were.
 */
async function refusedCallback(extra: Partial<AuthConfig>, code: string): Promise<void> {
  // Ada's sign-up keeps a session, unverified.
  const w = await world({ ...extra, password: { uniformSignUp: false, requireVerified: false } });
  const token = await claimant(w);
  if (token === null) throw new Error("the sign-up opened no session");
  const store = createD1Adapter(env.DB);
  const byEmail = [{ field: "email" as const, op: "eq" as const, value: "ada@acme.example" }];
  const ada = await store.findOne("user", byEmail);
  if (!ada) throw new Error("no user");
  const byUser = [{ field: "userId" as const, op: "eq" as const, value: ada.id }];
  const password = await store.findOne("password", byUser);
  const sessions = await store.findMany("session", byUser);
  const r = await callback(w, "code-1");
  expect(r.error).toBe(code);
  // No statement of the callback writes a row of Ada, and no undo statement does either.
  const writes = r.sql.filter((q) =>
    /^\s*(INSERT|UPDATE|DELETE)\b[^;]*\b(ta_user|ta_session|ta_password|ta_identity|ta_member)\b/i.test(
      q,
    ),
  );
  expect(writes).toEqual([]);
  expect(await store.findOne("user", byEmail)).toEqual(ada);
  expect(await store.findOne("password", byUser)).toEqual(password);
  expect(await store.findMany("session", byUser)).toEqual(sessions);
  expect((await w.auth.api.getSession(token))?.user.id).toBe(ada.id);
}

describe("a member refusal of an SSO callback on D1 (ruling 41 of plan 12d)", () => {
  it("answers member_limit before the claim writes, so no undo runs", async () => {
    // The owner fills the limit of 1.
    await refusedCallback(
      { organizations: { limits: { membersPerOrganization: 1 } } },
      "member_limit",
    );
  }, 120_000);

  it("answers hook_refused from organization.beforeAddMember before the claim writes", async () => {
    const vias: string[] = [];
    const hooks: AuthConfig["hooks"] = {
      organization: {
        beforeAddMember: (e) => {
          // The owner's member row of the organization create passes.
          if (e.memberUser.email !== "ada@acme.example") return;
          vias.push(e.via);
          throw hookRefusal("Ada joins by an invitation.");
        },
      },
    };
    await refusedCallback({ hooks }, "hook_refused");
    expect(vias).toEqual(["sso"]);
  }, 120_000);
});
