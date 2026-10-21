import { env } from "cloudflare:test";
import { createAuth } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
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

/** The engine on `db`, with organizations, OIDC connections, the fake DNS, and the fake IdP. */
function make(
  db: D1Database,
  txt: Record<string, string[]>,
  idTokens: Record<string, object>,
  mail: string[] = [],
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
  });
}

/**
 * The queries of each of three callbacks for one address: the first sign-in,
 * which creates the user and the member row just in time; a second sign-in
 * of the known identity; and, with `claim`, a first sign-in that claims an
 * unverified password sign-up at the address.
 */
async function callbacks(claim: boolean): Promise<number[]> {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const txt: Record<string, string[]> = {};
  const idTokens: Record<string, object> = {};
  const mail: string[] = [];
  const auth = make(env.DB, txt, idTokens, mail);
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
  if (claim) {
    const up = await auth.api.password?.signUp({
      email: "ada@acme.example",
      password: "a claimant's password",
      ip: null,
      userAgent: null,
    });
    if (!up?.ok) throw new Error("no claimant");
  }
  const counts: number[] = [];
  for (const code of ["code-1", "code-2"]) {
    const started = await auth.handle(new Request(`${BASE}/auth/sso/${connection.value.id}/start`));
    const url = new URL(started.headers.get("location") ?? "");
    const bind = started.headers
      .getSetCookie()
      .find((x) => x.startsWith("__Secure-tempo_session_oauth="))
      ?.split(";")[0];
    idTokens[code] = {
      sub: "ada-1",
      email: "ada@acme.example",
      nonce: url.searchParams.get("nonce") ?? "",
    };
    const q = new URLSearchParams({ code, state: url.searchParams.get("state") ?? "" });
    const { db, c } = counting(env.DB);
    const res = await make(db, txt, idTokens).handle(
      new Request(`${BASE}/auth/sso/${connection.value.id}/callback?${q}`, {
        headers: { cookie: bind ?? "" },
      }),
    );
    const error = new URL(res.headers.get("location") ?? "", BASE).searchParams.get("auth_error");
    if (error !== null) throw new Error(error);
    counts.push(c.n);
  }
  return counts;
}

describe("the queries of one SSO callback on D1 (plan 12d Task 5)", () => {
  it("stays inside 50 queries for a create, a known identity, and a claim", async () => {
    const created = await callbacks(false);
    const claimed = await callbacks(true);
    // Measured on the binding on 2026-10-21 (load 18.2): a create 23, a claim 35,
    // and a known identity 15 after each. The first callback of each pair adds
    // the member row; the claim also ends the claimant's rows.
    expect({ created, claimed }).toEqual({ created: [23, 15], claimed: [35, 15] });
    for (const n of [...created, ...claimed]) expect(n).toBeLessThanOrEqual(50);
  }, 120_000);
});
