import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, updateConnection } from "../../src/engine/sso/connections.js";
import { completeSsoOidc, SSO_DISCOVERY_MAX, startSso } from "../../src/engine/sso/oidc.js";
import type { SsoProfile } from "../../src/engine/sso/resolve.js";
import { sha256Hex } from "../../src/primitives/crypto.js";
import type { OidcEndpoints } from "../../src/social/oidc.js";
import { createTestIdp } from "../../src/testing/saml-idp.js";
import { BASE_URL, get, LONG_TEST_MS } from "../helpers.js";
import { type FakeIdToken, fakeFetch, fakeJwt, type TokenCall } from "../social-helpers.js";
import { SSO_APP, seedOrganization, ssoAuth } from "./helpers.js";

let errors: { mock: { calls: unknown[][] } };

beforeEach(() => {
  // Each refused step writes one log line; the tests read the lines.
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The issuer of the connection of an organization slug. */
const issuerOf = (slug: string) => `https://login.${slug}-idp.example/v2.0`;

/** The fixed endpoints of the connection of an organization slug. */
function endpointsOf(slug: string): OidcEndpoints {
  return {
    authorizeUrl: `https://login.${slug}-idp.example/authorize`,
    tokenUrl: `https://login.${slug}-idp.example/token`,
    jwksUrl: `https://login.${slug}-idp.example/keys`,
  };
}

/**
 * A memory engine with OIDC connections on. The fake IdP of plan 9c: the
 * token endpoint answers the code as the ID token, and the jwt seam knows
 * the tokens of `tokens`. A discovery URL answers the document of `docs`.
 */
function oidcWorld() {
  const tokens: Record<string, FakeIdToken> = {};
  const docs: Record<string, unknown> = {};
  const idp = fakeFetch((call: TokenCall) => {
    if (call.url.endsWith("/.well-known/openid-configuration")) {
      const doc = docs[call.url];
      return doc === undefined ? new Response("no", { status: 404 }) : Response.json(doc);
    }
    return Response.json({ id_token: call.form.code, token_type: "Bearer" });
  });
  const w = ssoAuth({
    sso: {
      oidc: true,
      saml: true,
      fetch: idp.fetchFn,
      limits: { connectionsPerOrganization: 600 },
    },
    jwt: fakeJwt(tokens),
  });
  return { ...w, tokens, docs, calls: idp.calls };
}

type World = ReturnType<typeof oidcWorld>;

/** One OIDC connection of the organization, made by the app. `endpoints` null takes discovery. */
async function connection(
  w: World,
  organizationId: string,
  slug: string,
  endpoints: OidcEndpoints | null = endpointsOf(slug),
) {
  const r = await createConnection(w.config, SSO_APP, {
    organizationId,
    kind: "oidc",
    label: `${slug} IdP`,
    issuer: issuerOf(slug),
    clientId: `${slug}-client`,
    clientSecret: `${slug}-secret-0123456789`,
    ...(endpoints ? { endpoints } : {}),
  });
  if (!r.ok) throw new Error(r.code);
  return r.value.id;
}

/** Two organizations with one OIDC connection each. */
async function twoConnections(w: World) {
  const a = await connection(w, await seedOrganization(w, "acme"), "acme");
  const b = await connection(w, await seedOrganization(w, "globex"), "globex");
  return { a, b };
}

/** The binding cookie value of a start answer. */
function bindOf(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("__Secure-tempo_session_oauth="));
  return set?.split(";")[0]?.split("=")[1] ?? "";
}

/** A start through the router: the authorize URL, the binding value, and the answer. */
async function start(w: World, id: string, ip = "203.0.113.7") {
  const res = await w.handle(get(`/auth/sso/${id}/start?next=/home`, { "cf-connecting-ip": ip }));
  const url = new URL(res.headers.get("location") ?? "");
  return {
    res,
    url,
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    bind: bindOf(res),
  };
}

/** A callback through the router with the binding cookie. */
function callback(w: World, id: string, query: Record<string, string>, bind: string) {
  const q = new URLSearchParams(query).toString();
  return w.handle(
    get(`/auth/sso/${id}/callback?${q}`, { cookie: `__Secure-tempo_session_oauth=${bind}` }),
  );
}

/** The steps of the `sso failed` log lines of a connection. */
function stepsOf(id: string): unknown[] {
  return errors.mock.calls
    .filter((c) => c[0] === "authtempo: sso failed" && c[1] === id)
    .map((c) => c[2]);
}

/** The `auth_error` of a redirect answer. */
function authError(res: Response): string | null {
  return new URL(res.headers.get("location") ?? "").searchParams.get("auth_error");
}

describe("the OIDC sign-in of an SSO connection (plan 12d Task 4)", () => {
  it("starts with the connection's own redirect URI and a binding cookie", async () => {
    const w = oidcWorld();
    const { a } = await twoConnections(w);
    const s = await start(w, a);
    expect(s.res.status).toBe(302);
    expect(`${s.url.origin}${s.url.pathname}`).toBe("https://login.acme-idp.example/authorize");
    expect(Object.fromEntries(s.url.searchParams)).toEqual({
      client_id: "acme-client",
      redirect_uri: `${BASE_URL}/auth/sso/${a}/callback`,
      response_type: "code",
      scope: "openid email profile",
      state: s.state,
      nonce: s.nonce,
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "S256",
    });
    const cookie = s.res.headers.getSetCookie().join("\n");
    expect(cookie).toContain("Path=/auth/sso;");
    expect(s.bind).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await w.storage.findOne("verification", [
      { field: "valueHash", op: "eq", value: await sha256Hex(s.state) },
    ]);
    expect(row?.purpose).toBe("oauth-state");
    expect(row?.identifier).toBe(`sso:${a}`);
    expect(row?.data).toMatchObject({ next: "/home", connectionId: a });
  });

  it("refuses the ID token of one connection on the other", async () => {
    const w = oidcWorld();
    const { b } = await twoConnections(w);
    const s = await start(w, b);
    // A valid token of connection A: its audience is A's client id.
    w.tokens["token-of-a"] = {
      audience: "acme-client",
      issuer: issuerOf("acme"),
      claims: { sub: "a-1", email: "x@acme.example", nonce: s.nonce },
    };
    const res = await callback(w, b, { code: "token-of-a", state: s.state }, s.bind);
    expect(authError(res)).toBe("sso_failed");
    expect(stepsOf(b)).toEqual(["id_token"]);
    // The exchange sent B's own redirect URI (review L2 of Task 4a).
    const exchange = w.calls.find((c) => c.url === endpointsOf("globex").tokenUrl);
    expect(exchange?.form.redirect_uri).toBe(`${BASE_URL}/auth/sso/${b}/callback`);
    expect(exchange?.form.client_id).toBe("globex-client");
  });

  it("refuses a state of one connection at the callback of another", async () => {
    const w = oidcWorld();
    const { a, b } = await twoConnections(w);
    const s = await start(w, a);
    const res = await callback(w, b, { code: "c", state: s.state }, s.bind);
    expect(authError(res)).toBe("sso_failed");
    expect(stepsOf(b)).toEqual(["state_connection"]);
    const row = await w.storage.findOne("verification", [
      { field: "valueHash", op: "eq", value: await sha256Hex(s.state) },
    ]);
    expect(row?.consumedAt).toEqual(w.clock.now());
    // The state is spent, so its own callback fails too, before any exchange.
    const again = await callback(w, a, { code: "c", state: s.state }, s.bind);
    expect(authError(again)).toBe("sso_failed");
    expect(stepsOf(a)).toEqual(["state"]);
    expect(w.calls).toEqual([]);
  });

  it("refuses a wrong and a missing binding cookie before any call to the IdP", async () => {
    const w = oidcWorld();
    const { a } = await twoConnections(w);
    const answers: (string | null)[] = [];
    for (const bind of ["A".repeat(43), null]) {
      const s = await start(w, a);
      // A token that passes each later step, so only the binding check can stop the flow.
      w.tokens[`token-${s.nonce}`] = {
        audience: "acme-client",
        issuer: issuerOf("acme"),
        claims: { sub: "a-1", nonce: s.nonce },
      };
      const query = { code: `token-${s.nonce}`, state: s.state };
      const res =
        bind === null
          ? await w.handle(get(`/auth/sso/${a}/callback?${new URLSearchParams(query)}`))
          : await callback(w, a, query, bind);
      answers.push(authError(res));
    }
    expect(answers).toEqual(["sso_failed", "sso_failed"]);
    expect(stepsOf(a)).toEqual(["binding", "binding"]);
    expect(w.calls).toEqual([]);
  });

  it("refuses an ID token with a wrong nonce or no nonce", async () => {
    const w = oidcWorld();
    const { a } = await twoConnections(w);
    const answers: (string | null)[] = [];
    for (const claims of [{ sub: "a-1", nonce: "a-nonce-of-another-start" }, { sub: "a-1" }]) {
      const s = await start(w, a);
      const code = `token-${s.state}`;
      w.tokens[code] = { audience: "acme-client", issuer: issuerOf("acme"), claims };
      answers.push(authError(await callback(w, a, { code, state: s.state }, s.bind)));
    }
    expect(answers).toEqual(["sso_failed", "sso_failed"]);
    expect(stepsOf(a)).toEqual(["nonce", "nonce"]);
  });

  it("refuses a state at the end of its 10 minutes", async () => {
    const w = oidcWorld();
    const { a } = await twoConnections(w);
    const late = await start(w, a);
    const inTime = await start(w, a);
    for (const s of [late, inTime])
      w.tokens[`token-${s.nonce}`] = {
        audience: "acme-client",
        issuer: issuerOf("acme"),
        claims: { sub: "a-1", nonce: s.nonce },
      };
    // One millisecond before the end the state passes, and the flow reaches the resolution of Task 5.
    w.clock.advance(10 * 60_000 - 1);
    await callback(w, a, { code: `token-${inTime.nonce}`, state: inTime.state }, inTime.bind);
    w.clock.advance(1);
    const res = await callback(w, a, { code: `token-${late.nonce}`, state: late.state }, late.bind);
    expect(authError(res)).toBe("sso_failed");
    expect(stepsOf(a)).toEqual(["resolve", "state"]);
    // The late state is not spent: the refusal wrote nothing.
    const row = await w.storage.findOne("verification", [
      { field: "valueHash", op: "eq", value: await sha256Hex(late.state) },
    ]);
    expect(row?.consumedAt).toBeNull();
  });

  it("refuses a discovery document with another issuer, and a discovered private host", async () => {
    const w = oidcWorld();
    const other = await connection(w, await seedOrganization(w, "acme"), "acme", null);
    const local = await connection(w, await seedOrganization(w, "globex"), "globex", null);
    // A document of another tenant: its issuer is not the connection's issuer.
    w.docs[`${issuerOf("acme")}/.well-known/openid-configuration`] = {
      issuer: issuerOf("initech"),
      ...wellKnown(endpointsOf("acme")),
    };
    // The right issuer, but the token endpoint is on a private host.
    w.docs[`${issuerOf("globex")}/.well-known/openid-configuration`] = {
      issuer: issuerOf("globex"),
      ...wellKnown({ ...endpointsOf("globex"), tokenUrl: "https://10.0.0.5/token" }),
    };
    expect(authError((await start(w, other)).res)).toBe("sso_failed");
    expect(authError((await start(w, local)).res)).toBe("sso_failed");
    expect(stepsOf(other)).toEqual(["discovery"]);
    expect(stepsOf(local)).toEqual(["discovery_host"]);
    // No state row: a refused start writes nothing.
    expect(await w.storage.findMany("verification", [])).toEqual([]);
  });

  it("reads amr and acr and never email_verified", async () => {
    const w = oidcWorld();
    const { a } = await twoConnections(w);
    const s = await start(w, a);
    w.tokens["token-1"] = {
      audience: "acme-client",
      issuer: issuerOf("acme"),
      claims: {
        sub: "a-1",
        email: "ada@acme.example",
        email_verified: false,
        name: "Ada",
        picture: "https://img.acme.example/a.png",
        amr: ["mfa", "pwd", 7],
        acr: "urn:x",
        nonce: s.nonce,
      },
    };
    const seen: SsoProfile[] = [];
    const r = await completeSsoOidc(
      w.config,
      {
        connectionId: a,
        state: s.state,
        code: "token-1",
        error: null,
        bindToken: s.bind,
        ip: null,
        userAgent: null,
      },
      { onProfile: (p) => seen.push(p) },
    );
    expect(seen).toEqual([
      {
        subject: "a-1",
        email: "ada@acme.example",
        name: "Ada",
        image: "https://img.acme.example/a.png",
        amr: ["mfa", "pwd"],
        acr: "urn:x",
      },
    ]);
    // Task 5 writes the resolution; until then the answer is sso_failed at the step resolve.
    expect(r).toEqual({ ok: false, code: "sso_failed", status: 400 });
    expect(stepsOf(a)).toEqual(["resolve"]);
    const exchange = w.calls.find((c) => c.url === endpointsOf("acme").tokenUrl);
    expect(exchange?.form).toEqual({
      grant_type: "authorization_code",
      code: "token-1",
      redirect_uri: `${BASE_URL}/auth/sso/${a}/callback`,
      client_id: "acme-client",
      client_secret: "acme-secret-0123456789",
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it(
    "keeps at most 500 discovery entries",
    async () => {
      const w = oidcWorld();
      const org = await seedOrganization(w, "acme");
      const ids: string[] = [];
      for (let i = 0; i <= SSO_DISCOVERY_MAX; i++) {
        const slug = `t${i}`;
        w.docs[`${issuerOf(slug)}/.well-known/openid-configuration`] = {
          issuer: issuerOf(slug),
          ...wellKnown(endpointsOf(slug)),
        };
        ids.push(await connection(w, org, slug, null));
      }
      const reads = (slug: string) =>
        w.calls.filter((c) => c.url === `${issuerOf(slug)}/.well-known/openid-configuration`)
          .length;
      // One IP per start, so the start limit counts none of them twice.
      const begin = async (i: number) => {
        const r = await startSso(w.config, {
          connectionId: ids[i] ?? "",
          ip: `10.1.${i >> 8}.${i & 255}`,
        });
        if (!r.ok) throw new Error(r.code);
      };
      for (let i = 0; i <= SSO_DISCOVERY_MAX; i++) await begin(i);
      // The 501st entry pushed out the first: its document is read again. The newest entry stays.
      await begin(0);
      await begin(SSO_DISCOVERY_MAX);
      expect({ first: reads("t0"), newest: reads(`t${SSO_DISCOVERY_MAX}`) }).toEqual({
        first: 2,
        newest: 1,
      });
    },
    LONG_TEST_MS,
  );

  it("reads the document again after an update of the connection", async () => {
    const w = oidcWorld();
    const id = await connection(w, await seedOrganization(w, "acme"), "acme", null);
    w.docs[`${issuerOf("acme")}/.well-known/openid-configuration`] = {
      issuer: issuerOf("acme"),
      ...wellKnown(endpointsOf("acme")),
    };
    const reads = () =>
      w.calls.filter((c) => c.url.endsWith("/.well-known/openid-configuration")).length;
    await start(w, id);
    await start(w, id);
    expect(reads()).toBe(1);
    const updated = await updateConnection(w.config, SSO_APP, { id, label: "Acme new" });
    expect(updated.ok).toBe(true);
    await start(w, id);
    expect(reads()).toBe(2);
  });

  it("answers oauth_denied, and sso_not_configured for a connection that cannot sign in", async () => {
    const w = oidcWorld();
    const { a, b } = await twoConnections(w);
    const denied = await start(w, a);
    const res = await callback(w, a, { error: "access_denied", state: denied.state }, denied.bind);
    expect(authError(res)).toBe("oauth_denied");
    // A connection turned off between the start and the callback.
    const s = await start(w, b);
    expect((await updateConnection(w.config, SSO_APP, { id: b, enabled: false })).ok).toBe(true);
    expect(authError(await callback(w, b, { code: "c", state: s.state }, s.bind))).toBe(
      "sso_not_configured",
    );
    // An id that names no connection, a connection that is off, and a SAML connection.
    expect(authError((await start(w, "c-none")).res)).toBe("sso_not_configured");
    expect(authError((await start(w, b)).res)).toBe("sso_not_configured");
    const idp = await createTestIdp({ alg: "ec" });
    const saml = await createConnection(w.config, SSO_APP, {
      organizationId: await seedOrganization(w, "initech"),
      kind: "saml",
      label: "Initech",
      idpEntityId: idp.entityId,
      ssoUrl: "https://idp.example/sso",
      certificates: [idp.certificatePem],
    });
    if (!saml.ok) throw new Error(saml.code);
    expect(authError((await start(w, saml.value.id)).res)).toBe("sso_not_configured");
    // The binding cookie goes with each callback answer.
    expect(res.headers.getSetCookie().join("\n")).toContain(
      "__Secure-tempo_session_oauth=; Path=/auth/sso; Max-Age=0",
    );
  });

  it("counts the starts of one IP on sso-start:ip", async () => {
    const w = oidcWorld();
    const { a } = await twoConnections(w);
    for (let i = 0; i < 30; i++) expect((await start(w, a, "198.51.100.9")).res.status).toBe(302);
    const over = await start(w, a, "198.51.100.9");
    expect(authError(over.res)).toBe("rate_limited");
    expect(authError((await start(w, a, "198.51.100.10")).res)).toBeNull();
  });
});

/** The discovery fields of a document for three endpoints. */
function wellKnown(e: OidcEndpoints) {
  return {
    authorization_endpoint: e.authorizeUrl,
    token_endpoint: e.tokenUrl,
    jwks_uri: e.jwksUrl,
  };
}
