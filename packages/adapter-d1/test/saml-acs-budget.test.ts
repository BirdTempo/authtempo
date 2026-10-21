import { env } from "cloudflare:test";
import { createAuth } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { createTestIdp, type TestIdp } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The queries of one SAML ACS post on the D1 binding (plan 12d Task 8). D1
// Free allows 50 queries per invocation (D1 limits page updated 21 April
// 2026, read 2026-10-21). The post is one request, so it is one invocation.
// The start is another request. The ACS sends no subrequest: the
// certificates are in the connection row.

const BASE = "https://api.example.com";
const APP = { kind: "app", name: "saml-budget" } as const;
const BIND = "__Secure-tempo_session_oauth=";
const SESSION = "__Host-tempo_session=";
const DAY = 86_400_000;

/** The engine clock: the wall clock plus `shift`, so a test can reach a due refresh. */
let shift = 0;
const clock = { now: () => new Date(Date.now() + shift) };

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

/** The engine on `db`, with organizations, `sso.saml`, and the fake DNS. */
function make(db: D1Database, txt: Record<string, string[]>, mail: string[] = []) {
  return createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    limiter: { allow: async () => true },
    clock,
    mail: { send: async (m) => void mail.push(m.text) },
    organizations: {},
    sso: { saml: true, dns: [{ name: "a", txt: async (name) => txt[name] ?? [] }] },
  });
}

/** base64 of a UTF-8 text, the form of `SAMLResponse`. */
function b64(xml: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(xml)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The ID of the AuthnRequest of a redirect: base64, then raw DEFLATE. */
async function requestIdOf(location: URL): Promise<string> {
  const value = location.searchParams.get("SAMLRequest") ?? "";
  const bytes = Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const text = await new Response(stream).text();
  return /\sID="([^"]+)"/.exec(text)?.[1] ?? "";
}

/** The organization acme with its verified domain and one SAML connection, on the binding. */
async function world() {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  shift = 0;
  const txt: Record<string, string[]> = {};
  const mail: string[] = [];
  const auth = make(env.DB, txt, mail);
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
  const idp = await createTestIdp({ alg: "rsa" });
  const connection = await sso.connections.create({
    actor: APP,
    organizationId,
    kind: "saml",
    label: "Acme IdP",
    idpEntityId: idp.entityId,
    ssoUrl: "https://idp.example/sso",
    certificates: [idp.certificatePem],
  });
  if (!connection.ok) throw new Error(connection.code);
  return { auth, txt, idp, connectionId: connection.value.id };
}

/** One SAML sign-in of Ada: the start, then the ACS post on a counting view of the binding. */
async function signIn(
  w: {
    auth: ReturnType<typeof make>;
    txt: Record<string, string[]>;
    idp: TestIdp;
    connectionId: string;
  },
  sessionNotOnOrAfter?: Date,
) {
  const id = w.connectionId;
  const started = await w.auth.handle(new Request(`${BASE}/auth/sso/${id}/start`));
  const location = new URL(started.headers.get("location") ?? "");
  const bind = started.headers
    .getSetCookie()
    .find((x) => x.startsWith(BIND))
    ?.split(";")[0];
  const now = clock.now();
  const xml = await w.idp.response({
    audience: `${BASE}/auth/sso/${id}/metadata`,
    recipient: `${BASE}/auth/sso/${id}/acs`,
    inResponseTo: await requestIdOf(location),
    nameId: "ada-1",
    attributes: { email: ["ada@acme.example"] },
    notBefore: new Date(now.getTime() - 60_000),
    notOnOrAfter: new Date(now.getTime() + 5 * 60_000),
    now,
    ...(sessionNotOnOrAfter === undefined ? {} : { sessionNotOnOrAfter }),
  });
  const form = new URLSearchParams({
    SAMLResponse: b64(xml),
    RelayState: location.searchParams.get("RelayState") ?? "",
  });
  const { db, c } = counting(env.DB);
  const res = await make(db, w.txt).handle(
    new Request(`${BASE}/auth/sso/${id}/acs`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: bind ?? "" },
      body: form.toString(),
    }),
  );
  const at = new URL(res.headers.get("location") ?? "", BASE).searchParams;
  if (at.get("auth_error") !== null) throw new Error(at.get("auth_error") ?? "");
  const cookie = res.headers
    .getSetCookie()
    .find((x) => x.startsWith(SESSION))
    ?.split(";")[0];
  return { n: c.n, cookie: cookie ?? "" };
}

describe("the queries of one SAML ACS post on D1 (plan 12d Task 8)", () => {
  it("stays inside 50 queries for a create, a known identity, and a capped session", async () => {
    const w = await world();
    const created = (await signIn(w)).n;
    const known = (await signIn(w)).n;
    const capped = (await signIn(w, new Date(Date.now() + DAY))).n;
    // Measured on the binding on 2026-10-22 (load 12.1): a just-in-time create 23, and a known
    // identity 15 after it. A capped session adds the create of its session-cap row (ruling 38
    // Q1 of plan 12d): 16.
    expect({ created, known, capped }).toEqual({ created: 23, known: 15, capped: 16 });
    for (const n of [created, known, capped]) expect(n).toBeLessThanOrEqual(50);
  }, 120_000);

  it("stays inside 50 queries for a due refresh of a capped session", async () => {
    const w = await world();
    // The IdP writes whole seconds.
    const cap = new Date(Math.floor(clock.now().getTime() / 1000) * 1000 + 10 * DAY);
    const { cookie } = await signIn(w, cap);
    // The refresh is due after 7 days. It reads the session-cap row of ruling 44 of plan 12d.
    shift = 7 * DAY + 1000;
    const { db, c } = counting(env.DB);
    const res = await make(db, w.txt).handle(
      new Request(`${BASE}/auth/session`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { expiresAt: string } };
    expect(new Date(body.session.expiresAt)).toEqual(cap);
    // The refresh renews the cookie.
    expect(res.headers.getSetCookie().some((x) => x.startsWith(SESSION))).toBe(true);
    // Measured on the binding on 2026-10-22 (load 15): 5, with the read of the cap row.
    expect(c.n).toBe(5);
    expect(c.n).toBeLessThanOrEqual(50);
  }, 120_000);
});
