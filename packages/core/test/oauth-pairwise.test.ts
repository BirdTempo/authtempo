import { describe, expect, it } from "vitest";
import { subjectFor } from "../src/engine/oauth-subject.js";
import { fromBase64Url } from "../src/primitives/crypto.js";
import { HTTP_LOOPBACK, isLocalHost } from "../src/primitives/host.js";
import type { OAuthClientRow } from "../src/schema.js";
import { BASE_URL, get, post } from "./helpers.js";
import {
  authorized,
  basicHeader,
  type Handle,
  oauthHandle,
  pkce,
  RESOURCE,
  SCOPES,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";

const dec = new TextDecoder();
const A = "https://a.example.com/callback";
const A2 = "https://a.example.com/other";
const B = "https://b.example.com/callback";
const SCOPE = "openid mcp:read offline_access";

/** A fake `oauth.fetch` that answers from a map and counts its calls. */
function fakeFetch() {
  const answers = new Map<string, unknown>();
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (!answers.has(url)) throw new Error(`no fake answer for ${url}`);
    return new Response(JSON.stringify(answers.get(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fn, answers, calls };
}

/** One resource, so every introspection client sees its tokens. CIMD is on when `fetchFn` is given. */
function handle(fetchFn?: typeof fetch): Handle {
  return oauthHandle({
    oauth: {
      resources: [RESOURCE],
      scopes: SCOPES,
      registration: { cimd: fetchFn !== undefined, dynamic: true },
      ...(fetchFn ? { fetch: fetchFn } : {}),
    },
  });
}

/** The claims of a compact JWS, read here without core's decoder. */
function claimsOf(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1] ?? "";
  return JSON.parse(dec.decode(fromBase64Url(part))) as Record<string, unknown>;
}

let ipCount = 0;

/** A registration through the route: the status and the body. Each comes from a new IP, under the limit. */
async function register(h: Handle, body: Record<string, unknown>) {
  ipCount++;
  const ip = { "cf-connecting-ip": `203.0.113.${ipCount % 250}` };
  const res = await h.auth.handle(post("/auth/oauth/register", body, ip));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A pairwise client registered through the route. Answers its client id. */
async function pairwise(h: Handle, redirectUris: string[]): Promise<string> {
  const r = await register(h, { redirect_uris: redirectUris, subject_type: "pairwise" });
  if (r.status !== 201) throw new Error(`register answered ${String(r.body.error)}`);
  return String(r.body.client_id);
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
}

/** The real authorize and exchange of `clientId` for the session `cookie`. */
async function tokensOf(
  h: Handle,
  cookie: string,
  clientId: string,
  redirectUri: string,
  headers: Record<string, string> = {},
): Promise<Tokens> {
  const p = await pkce();
  const { code } = await authorized(h, cookie, {
    clientId,
    challenge: p.challenge,
    scope: SCOPE,
    redirectUri,
  });
  const res = await h.auth.handle(
    tokenPost(
      {
        grant_type: "authorization_code",
        code,
        code_verifier: p.verifier,
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      },
      headers,
    ),
  );
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) throw new Error(`the exchange answered ${String(body.error)}`);
  return body as unknown as Tokens;
}

/** The `sub` of the ID token of one authorization. */
async function subOf(h: Handle, cookie: string, clientId: string, redirectUri: string) {
  return String(claimsOf((await tokensOf(h, cookie, clientId, redirectUri)).id_token).sub);
}

async function clientRowOf(h: Handle, id: string): Promise<OAuthClientRow> {
  const row = await h.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: id }]);
  if (!row) throw new Error("no client row");
  return row;
}

/** A client of `api.oauth.clients` with a Basic secret that may introspect. */
async function secretClient(h: Handle, input: Record<string, unknown>) {
  const clients = h.auth.api.oauth?.clients;
  if (!clients) throw new Error("oauth is off");
  const made = await clients.create({
    authMethod: "client_secret_basic",
    introspect: true,
    ...input,
  });
  if (!made.ok || !made.value.clientSecret) throw new Error("create failed");
  const id = made.value.client.id;
  return { id, authorization: basicHeader(id, made.value.clientSecret) };
}

/** The introspection of a token by the client of `authorization`. */
function introspector(h: Handle, authorization: string) {
  return async (token: string) => {
    const res = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/introspect`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization },
        body: new URLSearchParams({ token }).toString(),
      }),
    );
    if (res.status !== 200) throw new Error(`introspect answered ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
}

/** A resource server of `api.oauth.clients` that may introspect. */
async function resourceServer(h: Handle) {
  const rs = await secretClient(h, {
    name: "Resource server",
    grantTypes: ["client_credentials"],
    credentialsScopes: ["mcp:read"],
  });
  return introspector(h, rs.authorization);
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("pairwise subjects (plan 12e Task 11, OIDC Core 8)", () => {
  it("gives two clients on two hosts two subjects, and one client one subject per user", async () => {
    const h = handle();
    const ada = await signedIn(h);
    const bob = await signedIn(h, "bob@example.com");
    const a = await pairwise(h, [A]);
    const a2 = await pairwise(h, [A2]);
    const b = await pairwise(h, [B]);
    const adaAtA = await subOf(h, ada.cookie, a, A);
    expect(adaAtA).toMatch(/^ps_[A-Za-z0-9_-]{22}$/);
    expect(adaAtA).not.toContain(ada.user.id);
    // One user at one client: one subject at each authorization.
    expect(await subOf(h, ada.cookie, a, A)).toBe(adaAtA);
    // Another client of the same sector: the same subject.
    expect(await subOf(h, ada.cookie, a2, A2)).toBe(adaAtA);
    // Another sector, or another user: another subject.
    const adaAtB = await subOf(h, ada.cookie, b, B);
    const bobAtA = await subOf(h, bob.cookie, a, A);
    expect(new Set([adaAtA, adaAtB, bobAtA]).size).toBe(3);
    expect(adaAtB).toMatch(/^ps_/);
    expect(bobAtA).toMatch(/^ps_/);
    const rows = await h.storage.findMany("oauthSubject", []);
    expect(rows.map((r) => [r.sector, r.userId, r.subject]).sort()).toEqual(
      [
        ["a.example.com", ada.user.id, adaAtA],
        ["a.example.com", bob.user.id, bobAtA],
        ["b.example.com", ada.user.id, adaAtB],
      ].sort(),
    );
  });

  it("keeps one row when two first tokens race", async () => {
    const h = handle();
    const ada = await signedIn(h);
    const client = await clientRowOf(h, await pairwise(h, [A]));
    const [one, two] = await Promise.all([
      subjectFor(h.config, ada.user.id, client),
      subjectFor(h.config, ada.user.id, client),
    ]);
    expect(one).toMatch(/^ps_/);
    expect(two).toBe(one);
    const rows = await h.storage.findMany("oauthSubject", [
      { field: "userId", op: "eq", value: ada.user.id },
    ]);
    expect(rows.map((r) => r.subject)).toEqual([one]);
  });

  it("refuses pairwise for redirect URIs on two hosts or a private-use scheme", async () => {
    const h = handle();
    const refused = { status: 400, body: { error: "invalid_client_metadata" } };
    for (const uris of [
      [A, B],
      [A, "http://127.0.0.1:8080/callback"],
      ["http://127.0.0.1/callback", "http://localhost/callback"],
      ["com.example.app:/callback"],
      [A, "com.example.app:/callback"],
    ]) {
      const r = await register(h, { redirect_uris: uris, subject_type: "pairwise" });
      expect({ uris, status: r.status, body: r.body }).toEqual({ uris, ...refused });
      // The same URIs as a public client pass: the refusal is the sector rule.
      expect((await register(h, { redirect_uris: uris })).status).toBe(201);
    }
    // One https host with two paths passes.
    expect((await register(h, { redirect_uris: [A, A2], subject_type: "pairwise" })).status).toBe(
      201,
    );
    // api.oauth.clients takes the same rule, at create and at update.
    const clients = h.auth.api.oauth?.clients;
    if (!clients) throw new Error("oauth is off");
    expect(await clients.create({ redirectUris: [A, B], subjectType: "pairwise" })).toMatchObject({
      ok: false,
      error: "invalid_client_metadata",
    });
    const made = await clients.create({ redirectUris: [A], subjectType: "pairwise" });
    if (!made.ok) throw new Error(made.error);
    expect(
      await clients.update({ clientId: made.value.client.id, redirectUris: [A, B] }),
    ).toMatchObject({
      ok: false,
      error: "invalid_client_metadata",
    });
  });

  it("refuses pairwise for a client whose redirect URIs are all on a loopback or local host", async () => {
    const h = handle();
    const refused = { status: 400, body: { error: "invalid_client_metadata" } };
    for (const uris of [
      ["http://127.0.0.1:1/cb", "http://127.0.0.1:2/cb"],
      ["http://localhost:8080/callback"],
      ["https://localhost/callback"],
      ["https://[::1]/callback"],
      // Ruling 34: every https form of a loopback or local host.
      ["https://localhost./callback"],
      ["https://127.0.0.2/callback"],
      ["https://app.localhost/callback"],
      ["https://[::ffff:127.0.0.1]/callback"],
      ["https://[::7f00:1]/callback"],
      ["https://0.0.0.0/callback"],
      ["https://[::]/callback"],
      ["https://intranet/callback"],
      ["https://printer.local/callback"],
      ["https://nas.home.arpa/callback"],
      ["https://svc.internal/callback"],
    ]) {
      const r = await register(h, { redirect_uris: uris, subject_type: "pairwise" });
      expect({ uris, status: r.status, body: r.body }).toEqual({ uris, ...refused });
      expect((await register(h, { redirect_uris: uris })).status).toBe(201);
    }
    const clients = h.auth.api.oauth?.clients;
    if (!clients) throw new Error("oauth is off");
    const loop = ["http://127.0.0.1:3000/callback"];
    expect(await clients.create({ redirectUris: loop, subjectType: "pairwise" })).toMatchObject({
      ok: false,
      error: "invalid_client_metadata",
    });
    const made = await clients.create({ redirectUris: loop });
    if (!made.ok) throw new Error(made.error);
    expect(
      await clients.update({ clientId: made.value.client.id, subjectType: "pairwise" }),
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
  });

  it("keeps each http loopback host inside the one local host rule", () => {
    expect([...HTTP_LOOPBACK].sort()).toEqual(["127.0.0.1", "localhost"]);
    for (const host of HTTP_LOOPBACK)
      expect({ host, local: isLocalHost(host) }).toEqual({ host, local: true });
    // Hosts of other parties stay sectors: a public name, and a public IP literal.
    for (const host of [
      "a.example.com",
      "localhost.example.com",
      "127.0.0.1.example.com",
      "203.0.113.5",
      "[2001:db8::1]",
    ])
      expect({ host, local: isLocalHost(host) }).toEqual({ host, local: false });
  });

  it("refuses an update that changes the sector of a pairwise client", async () => {
    const h = handle();
    const ada = await signedIn(h);
    const clients = h.auth.api.oauth?.clients;
    if (!clients) throw new Error("oauth is off");
    const made = await clients.create({ redirectUris: [A], subjectType: "pairwise" });
    if (!made.ok) throw new Error(made.error);
    const id = made.value.client.id;
    const before = await subOf(h, ada.cookie, id, A);
    expect(await clients.update({ clientId: id, redirectUris: [B] })).toMatchObject({
      ok: false,
      error: "invalid_client_metadata",
    });
    expect((await clientRowOf(h, id)).redirectUris).toEqual([A]);
    // A change inside the sector passes, and the subject stays.
    expect((await clients.update({ clientId: id, redirectUris: [A, A2] })).ok).toBe(true);
    expect(await subOf(h, ada.cookie, id, A2)).toBe(before);
  });

  it("refuses sector_identifier_uri for a pairwise registration and never fetches it", async () => {
    const f = fakeFetch();
    const h = handle(f.fn);
    const sectorUri = "https://sector.example.com/redirects.json";
    f.answers.set(sectorUri, [A, B]);
    for (const uris of [[A], [A, B]]) {
      const r = await register(h, {
        redirect_uris: uris,
        subject_type: "pairwise",
        sector_identifier_uri: sectorUri,
      });
      expect({ uris, status: r.status, body: r.body }).toEqual({
        uris,
        status: 400,
        body: { error: "invalid_client_metadata" },
      });
    }
    expect(f.calls).toEqual([]);
  });

  it("takes the host of the client id as the sector of a CIMD client", async () => {
    const f = fakeFetch();
    const h = handle(f.fn);
    const docA = "https://app.example.org/client.json";
    const docA2 = "https://app.example.org/second.json";
    const cb1 = "https://cb.example.net/callback";
    const cb2 = "https://b.example.com/callback";
    // The redirect hosts span two hosts and name the host of a registered
    // client. A sector_identifier_uri in a document is dropped, never fetched.
    for (const url of [docA, docA2])
      f.answers.set(url, {
        client_id: url,
        client_name: "Doc client",
        redirect_uris: [cb1, cb2],
        subject_type: "pairwise",
        sector_identifier_uri: "https://sector.example.com/redirects.json",
      });
    const ada = await signedIn(h);
    const atDoc = await subOf(h, ada.cookie, docA, cb1);
    expect(atDoc).toMatch(/^ps_/);
    // Another document on the same host: the same sector, the same subject.
    expect(await subOf(h, ada.cookie, docA2, cb2)).toBe(atDoc);
    // A registered client on a redirect host of the document: another sector.
    const atB = await subOf(h, ada.cookie, await pairwise(h, [cb2]), cb2);
    expect(atB).not.toBe(atDoc);
    const rows = await h.storage.findMany("oauthSubject", []);
    expect(rows.map((r) => [r.sector, r.subject]).sort()).toEqual(
      [
        ["app.example.org", atDoc],
        ["b.example.com", atB],
      ].sort(),
    );
    expect(f.calls.sort()).toEqual([docA, docA2].sort());
  });

  it("maps a pairwise sub back for auth.caller and introspection", async () => {
    const h = handle();
    const ada = await signedIn(h);
    const ask = await resourceServer(h);
    const a = await pairwise(h, [A]);
    const t = await tokensOf(h, ada.cookie, a, A);
    const sub = String(claimsOf(t.access_token).sub);
    expect(sub).toMatch(/^ps_/);
    expect(await h.auth.caller(get("/mcp", bearer(t.access_token)))).toMatchObject({
      kind: "oauth",
      clientId: a,
      user: { id: ada.user.id },
    });
    expect(await ask(t.access_token)).toMatchObject({ active: true, sub, client_id: a });
    // Two updates move the client to another sector: to public, then back to
    // pairwise on another host. The old subject is not of that sector, so its
    // tokens map to no user.
    const clients = h.auth.api.oauth?.clients;
    if (!clients) throw new Error("oauth is off");
    expect((await clients.update({ clientId: a, subjectType: "public" })).ok).toBe(true);
    expect(
      (await clients.update({ clientId: a, redirectUris: [B], subjectType: "pairwise" })).ok,
    ).toBe(true);
    expect(await h.auth.caller(get("/mcp", bearer(t.access_token)))).toBeNull();
    expect(await ask(t.access_token)).toEqual({ active: false });
    const userinfo = await h.auth.handle(get("/auth/oauth/userinfo", bearer(t.access_token)));
    expect(userinfo.status).toBe(401);
  });

  it("uses the pairwise sub in the ID token, the access token, userinfo, and introspection", async () => {
    const h = handle();
    const ada = await signedIn(h);
    const ask = await resourceServer(h);
    const a = await pairwise(h, [A]);
    const t = await tokensOf(h, ada.cookie, a, A);
    const sub = String(claimsOf(t.id_token).sub);
    expect(sub).toMatch(/^ps_/);
    expect(claimsOf(t.access_token).sub).toBe(sub);
    const userinfo = await h.auth.handle(get("/auth/oauth/userinfo", bearer(t.access_token)));
    expect(userinfo.status).toBe(200);
    expect(((await userinfo.json()) as Record<string, unknown>).sub).toBe(sub);
    expect(await ask(t.access_token)).toMatchObject({ active: true, sub });
    // The refresh grant gives a token of the same subject.
    const res = await h.auth.handle(
      tokenPost({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: a }),
    );
    expect(res.status).toBe(200);
    const fresh = (await res.json()) as { access_token: string };
    expect(claimsOf(fresh.access_token).sub).toBe(sub);
    expect(await ask(fresh.access_token)).toMatchObject({ active: true, sub });
    // No answer of any path names the user id.
    const all = JSON.stringify([t, fresh].map((x) => claimsOf(x.access_token)));
    expect(all.includes(ada.user.id)).toBe(false);
    expect(JSON.stringify(claimsOf(t.id_token)).includes(ada.user.id)).toBe(false);
    // A confidential pairwise client sees its own refresh token with the subject of its sector.
    const own = await secretClient(h, { name: "Own", redirectUris: [A2], subjectType: "pairwise" });
    const ct = await tokensOf(h, ada.cookie, own.id, A2, { authorization: own.authorization });
    expect(claimsOf(ct.id_token).sub).toBe(sub);
    expect(await introspector(h, own.authorization)(ct.refresh_token)).toMatchObject({
      active: true,
      client_id: own.id,
      sub,
    });
    // A public client still gets the user id.
    const pub = await register(h, { redirect_uris: [B] });
    expect(await subOf(h, ada.cookie, String(pub.body.client_id), B)).toBe(ada.user.id);
  });
});
