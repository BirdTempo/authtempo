import { env } from "cloudflare:test";
import { createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { base32Decode, createTestIdp, totpCode } from "@authtempo/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The queries of each step of the SSO setup scene on the D1 binding (plan 13a Task 14, row 8).
// D1 Free allows 50 queries per invocation (D1 limits page updated 21 April 2026, read
// 2026-11-23). One request is one invocation, so each step builds a new engine on a new
// counting view, as each request of the Worker does. The limiter is the D1 limiter, so its
// queries count too. The view refuses query 51, as D1 Free does.
//
// This test lives in adapter-d1, not in core: core cannot run D1 (deviation of Task 14).
// The scene is the one of Task 12: the owner mints a link, the IT admin opens it, adds and
// verifies the domain, saves a SAML draft, runs the test, and makes a pending SCIM token.
// Then the owner reads the preview and activates.

const BASE = "https://api.example.com";
const ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const PASSWORD = "correct horse battery";
const BIND = "__Secure-tempo_session_oauth=";

/**
 * The measured statements of each step, with the D1 limiter. The activate step is the largest:
 * it locks the rows, routes the domains, turns on the token, and sends the notices.
 * Measured 2026-11-23 05:24 on the owner's Mac Studio, load 7.94 5.86 5.38.
 */
const PINS: Record<string, number> = {
  mint: 15,
  open: 13,
  domainAdd: 15,
  domainVerify: 17,
  saveDraft: 16,
  testStart: 18,
  testCallback: 12,
  scimToken: 16,
  status: 13,
  preview: 18,
  activate: 38,
};

/** A view of `db` that counts each statement, and each statement of a batch. Query 51 throws. */
function counting(db: D1Database) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (count.queries + n > BUDGET)
      throw new Error("Too many API requests by single worker invocation.");
    count.queries += n;
  };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            tick(1);
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          tick(statements.length);
          return target.batch(
            statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted as D1Database, count };
}

const txt: Record<string, string[]> = {};
const mail: { to: string; text: string }[] = [];

/** One engine on a new counting view: one invocation of the Worker. */
function make() {
  const { db, count } = counting(env.DB);
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async (m) => void mail.push({ to: m.to, text: m.text }) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    organizations: {},
    scim: {},
    sso: {
      saml: true,
      setup: {},
      dns: [{ name: "a", txt: async (name) => txt[name] ?? [] }],
    },
  });
  return { auth, count };
}

let ip = 0;
const headersOf = (cookie: string | null, json: boolean): Record<string, string> => ({
  "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
  "user-agent": "setup-budget",
  ...(json ? { "content-type": "application/json", origin: ORIGIN } : {}),
  ...(cookie ? { cookie } : {}),
});
const post = (path: string, body: unknown, cookie: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: headersOf(cookie, true),
    body: JSON.stringify(body),
  });
const get = (path: string, cookie: string | null = null) =>
  new Request(`${BASE}/auth${path}`, { headers: headersOf(cookie, false) });

/** The queries of one request, from a count of zero, with the work after the answer. */
async function measure(request: Request) {
  const w = make();
  const after: Promise<unknown>[] = [];
  const res = await w.auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return { res, queries: w.count.queries };
}

const cookieOf = (res: Response, name: string): string =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(name))
    ?.split(";")[0] ?? "";

/** The ID of the AuthnRequest of a redirect: base64, then raw DEFLATE. */
async function requestIdOf(location: URL): Promise<string> {
  const value = location.searchParams.get("SAMLRequest") ?? "";
  const bytes = Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return /\sID="([^"]+)"/.exec(await new Response(stream).text())?.[1] ?? "";
}

function b64(xml: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(xml)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The owner: a verified user with TOTP, who made the organization. Not measured. */
async function owner(): Promise<{ cookie: string; organizationId: string }> {
  const email = "owner@acme.example";
  const up = await (await measure(post("/password/sign-up", { email, password: PASSWORD }))).res;
  const link = mail.findLast((m) => m.to === email)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(link)?.[1] ?? "");
  const proof = cookieOf(up, "__Host-tempo_signup=");
  await measure(post("/password/verify", { token }, proof));
  const signed = await measure(post("/password/sign-in", { email, password: PASSWORD }));
  const cookie = cookieOf(signed.res, "__Host-tempo_session=");
  const made = await measure(post("/organizations/create", { slug: "acme", name: "Acme" }, cookie));
  const organization = ((await made.res.json()) as { organization: { id: string } }).organization;
  const setup = await measure(post("/totp/setup", { password: PASSWORD }, cookie));
  const { secret } = (await setup.res.json()) as { secret: string };
  const code = await totpCode(base32Decode(secret), new Date());
  expect((await measure(post("/totp/enable", { code }, cookie))).res.status).toBe(200);
  return { cookie, organizationId: organization.id };
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
  for (const k of Object.keys(txt)) delete txt[k];
  mail.length = 0;
});

describe("the queries of each step of the SSO setup scene on D1 (plan 13a Task 14, row 8)", () => {
  it("keeps each step of open, save, test, and activate under the D1 Free budget", async () => {
    const got: Record<string, number> = {};
    const boss = await owner();

    const minted = await measure(
      post(
        `/sso/setup-links/create?organizationId=${boss.organizationId}`,
        { steps: ["domain", "connection", "directory"], kinds: ["saml"], note: "Ada at Acme IT" },
        boss.cookie,
      ),
    );
    expect(minted.res.status).toBe(200);
    got.mint = minted.queries;
    const { id: linkId, token } = (await minted.res.clone().json()) as {
      id: string;
      token: string;
    };

    const opened = await measure(post("/sso/setup/open", { token }));
    expect(opened.res.status).toBe(200);
    got.open = opened.queries;
    const cookie = cookieOf(opened.res, "__Host-tempo_setup=");
    expect(cookie).not.toBe("");

    const added = await measure(post("/sso/setup/domains/add", { domain: "acme.example" }, cookie));
    expect(added.res.status).toBe(200);
    got.domainAdd = added.queries;
    const domain = (
      (await added.res.json()) as {
        domain: { id: string; record: { name: string; value: string } };
      }
    ).domain;
    txt[domain.record.name] = [domain.record.value];
    const verified = await measure(post("/sso/setup/domains/verify", { id: domain.id }, cookie));
    expect(verified.res.status).toBe(200);
    got.domainVerify = verified.queries;

    const idp = await createTestIdp({ alg: "rsa" });
    const saved = await measure(
      post(
        "/sso/setup/connection",
        {
          kind: "saml",
          label: "Acme IdP",
          idpEntityId: idp.entityId,
          ssoUrl: "https://idp.example/sso",
          certificates: [idp.certificatePem],
        },
        cookie,
      ),
    );
    expect(saved.res.status).toBe(200);
    got.saveDraft = saved.queries;
    const connectionId = ((await saved.res.json()) as { connection: { id: string } }).connection.id;

    const started = await measure(get(`/sso/${connectionId}/start?test=1`, cookie));
    expect(started.res.status).toBe(302);
    got.testStart = started.queries;
    const location = new URL(started.res.headers.get("location") ?? "");
    const bind = cookieOf(started.res, BIND);
    const now = new Date();
    const xml = await idp.response({
      audience: `${BASE}/auth/sso/${connectionId}/metadata`,
      recipient: `${BASE}/auth/sso/${connectionId}/acs`,
      inResponseTo: await requestIdOf(location),
      nameId: "ada-1",
      attributes: { email: ["ada@acme.example"] },
      notBefore: new Date(now.getTime() - 60_000),
      notOnOrAfter: new Date(now.getTime() + 5 * 60_000),
      now,
    });
    const form = new URLSearchParams({
      SAMLResponse: b64(xml),
      RelayState: location.searchParams.get("RelayState") ?? "",
    });
    const back = await measure(
      new Request(`${BASE}/auth/sso/${connectionId}/acs`, {
        method: "POST",
        headers: { ...headersOf(bind, false), "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
    );
    expect(back.res.status).toBe(303);
    got.testCallback = back.queries;

    const scim = await measure(post("/sso/setup/scim-token", {}, cookie));
    expect(scim.res.status).toBe(200);
    got.scimToken = scim.queries;

    const status = await measure(get("/sso/setup/status", cookie));
    expect(status.res.status).toBe(200);
    got.status = status.queries;

    const preview = await measure(get(`/sso/setup-links/get?id=${linkId}`, boss.cookie));
    expect(preview.res.status).toBe(200);
    got.preview = preview.queries;

    const activated = await measure(post("/sso/setup-links/activate", { id: linkId }, boss.cookie));
    expect(activated.res.status).toBe(200);
    got.activate = activated.queries;

    expect(got).toEqual(PINS);
    for (const count of Object.values(got)) expect(count).toBeLessThan(BUDGET);
  }, 120_000);
});
