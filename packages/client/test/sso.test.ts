import { ERRORS, type ErrorCode } from "@authtempo/core/errors";
import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { type Client, createClient } from "../src/client.js";
import type { ClientResult } from "../src/result.js";
import { APP_ORIGIN, BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

/** One domain as the route answers it: a pending domain with its record. */
const DOMAIN = {
  id: "d1",
  organizationId: "o1",
  domain: "acme.example",
  record: {
    name: "_authtempo-challenge.acme.example",
    type: "TXT",
    value: "authtempo-domain=abc",
  },
  verified: false,
  verifiedAt: null,
  checkedAt: null,
  connectionId: null,
  enforce: false,
  includeSubdomains: false,
  expiresAt: "2026-01-08T00:00:00.000Z",
};

/** One OIDC connection as the route answers it. No answer holds the client secret. */
const CONNECTION = {
  id: "c1",
  organizationId: "o1",
  kind: "oidc",
  label: "Acme staff",
  enabled: true,
  draft: false,
  jit: true,
  defaultRole: "member",
  mfa: null,
  scimRoles: null,
  oidc: {
    issuer: "https://login.acme.example",
    clientId: "authtempo",
    scope: "openid email profile",
    endpoints: null,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const SCIM_TOKEN = {
  id: "s1",
  name: "Entra",
  hint: "abcdefgh",
  scopes: ["scim.users.read"],
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  pending: false,
};

/** One setup link as the route answers it (plan 13a Task 11). It holds no token and no hash. */
const SETUP_LINK = {
  id: "l1",
  organizationId: "o1",
  hint: "abcdefgh",
  steps: ["domain", "connection"],
  kinds: ["oidc"],
  note: "Ada at IT",
  createdBy: "u1",
  expiresAt: "2026-01-08T00:00:00.000Z",
  revokedAt: null,
  endedAt: null,
  openedAt: null,
  readyAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SETUP_PREVIEW = {
  kind: "oidc",
  issuerOrEntityId: "https://login.acme.example",
  signInHost: "api.example.com",
  fingerprints: [],
  domains: ["acme.example"],
  scim: null,
};

const SETUP_STATUS = {
  link: {
    id: "l1",
    steps: ["domain", "connection"],
    kinds: ["oidc"],
    note: "Ada at IT",
    expiresAt: "2026-01-08T00:00:00.000Z",
    readyAt: null,
  },
  domains: [DOMAIN],
  connection: CONNECTION,
  scimToken: null,
  test: {
    outcome: "passed",
    step: null,
    help: "",
    attributeNames: ["email"],
    address: "ada@acme.example",
    name: null,
    domainClaimed: true,
    current: true,
  },
};

/** The draft of a setup session: the IdP values only. */
const SETUP_DRAFT = {
  kind: "oidc",
  label: "Acme staff",
  issuer: "https://login.acme.example",
  clientId: "authtempo",
  clientSecret: "s3cret",
} as const;

/**
 * One call of client.sso or client.scim.tokens: the route it must reach, the
 * body it must send, the answer of a 200, and the value the client gives.
 */
interface Case {
  name: string;
  run: (c: Client) => Promise<ClientResult<unknown>>;
  route: string;
  url: string;
  body: unknown;
  answer: unknown;
  value: unknown;
}

const CASES: readonly Case[] = [
  {
    name: "sso.discover",
    run: (c) => c.sso.discover({ email: "ada@acme.example", next: "/home" }),
    route: "POST /sso/discover",
    url: "/auth/sso/discover",
    body: { email: "ada@acme.example", next: "/home" },
    answer: { sso: true, connectionId: "c1", start: "https://api.example.com/auth/sso/c1/start" },
    value: { sso: true, connectionId: "c1", start: "https://api.example.com/auth/sso/c1/start" },
  },
  {
    name: "sso.domains.list",
    run: (c) => c.sso.domains.list({ organizationId: "o1" }),
    route: "GET /sso/domains",
    url: "/auth/sso/domains?organizationId=o1",
    body: undefined,
    answer: { domains: [DOMAIN] },
    value: [DOMAIN],
  },
  {
    name: "sso.domains.add",
    run: (c) => c.sso.domains.add({ organizationId: "o1", domain: "acme.example" }),
    route: "POST /sso/domains/add",
    url: "/auth/sso/domains/add",
    body: { organizationId: "o1", domain: "acme.example" },
    answer: { domain: DOMAIN },
    value: DOMAIN,
  },
  {
    name: "sso.domains.verify",
    run: (c) => c.sso.domains.verify({ id: "d1" }),
    route: "POST /sso/domains/verify",
    url: "/auth/sso/domains/verify",
    body: { id: "d1" },
    answer: { domain: DOMAIN },
    value: DOMAIN,
  },
  {
    name: "sso.domains.update",
    run: (c) => c.sso.domains.update({ id: "d1", connectionId: "c1", enforce: true }),
    route: "POST /sso/domains/update",
    url: "/auth/sso/domains/update",
    body: { id: "d1", connectionId: "c1", enforce: true },
    answer: { domain: DOMAIN },
    value: DOMAIN,
  },
  {
    name: "sso.domains.delete",
    run: (c) => c.sso.domains.delete({ id: "d1" }),
    route: "POST /sso/domains/delete",
    url: "/auth/sso/domains/delete",
    body: { id: "d1" },
    answer: { ok: true },
    value: { ok: true },
  },
  {
    name: "sso.connections.list",
    run: (c) => c.sso.connections.list({ organizationId: "o1" }),
    route: "GET /sso/connections",
    url: "/auth/sso/connections?organizationId=o1",
    body: undefined,
    answer: { connections: [CONNECTION] },
    value: [CONNECTION],
  },
  {
    name: "sso.connections.create",
    run: (c) =>
      c.sso.connections.create({
        organizationId: "o1",
        kind: "oidc",
        label: "Acme staff",
        issuer: "https://login.acme.example",
        clientId: "authtempo",
        clientSecret: "s3cret",
      }),
    route: "POST /sso/connections/create",
    url: "/auth/sso/connections/create?organizationId=o1",
    body: {
      kind: "oidc",
      label: "Acme staff",
      issuer: "https://login.acme.example",
      clientId: "authtempo",
      clientSecret: "s3cret",
    },
    answer: { connection: CONNECTION },
    value: CONNECTION,
  },
  {
    name: "sso.connections.update",
    run: (c) => c.sso.connections.update({ id: "c1", scimRoles: { Admins: "admin" } }),
    route: "POST /sso/connections/update",
    url: "/auth/sso/connections/update?id=c1",
    body: { scimRoles: { Admins: "admin" } },
    answer: { connection: CONNECTION },
    value: CONNECTION,
  },
  {
    name: "sso.connections.delete",
    run: (c) => c.sso.connections.delete({ id: "c1" }),
    route: "POST /sso/connections/delete",
    url: "/auth/sso/connections/delete",
    body: { id: "c1" },
    answer: { ok: true },
    value: { ok: true },
  },
  {
    name: "scim.tokens.list",
    run: (c) => c.scim.tokens.list({ organizationId: "o1" }),
    route: "GET /scim/tokens",
    url: "/auth/scim/tokens?organizationId=o1",
    body: undefined,
    answer: { tokens: [SCIM_TOKEN] },
    value: [SCIM_TOKEN],
  },
  {
    name: "scim.tokens.create",
    run: (c) =>
      c.scim.tokens.create({
        organizationId: "o1",
        name: "Entra",
        scopes: ["scim.users.read"],
        expiresInDays: 90,
      }),
    route: "POST /scim/tokens/create",
    url: "/auth/scim/tokens/create",
    body: { organizationId: "o1", name: "Entra", scopes: ["scim.users.read"], expiresInDays: 90 },
    answer: { token: "sk_clear", id: "s1", hint: "abcdefgh" },
    value: { token: "sk_clear", id: "s1", hint: "abcdefgh" },
  },
  {
    name: "scim.tokens.revoke",
    run: (c) => c.scim.tokens.revoke({ id: "s1" }),
    route: "POST /scim/tokens/revoke",
    url: "/auth/scim/tokens/revoke",
    body: { id: "s1" },
    answer: { ok: true },
    value: { ok: true },
  },
  // Plan 13a Task 11: the setup links of a manager, then the calls of a setup session.
  {
    name: "sso.setupLinks.create",
    run: (c) =>
      c.sso.setupLinks.create({
        organizationId: "o1",
        steps: ["domain", "connection"],
        kinds: ["oidc"],
        note: "Ada at IT",
        ttlHours: 24,
      }),
    route: "POST /sso/setup-links/create",
    // The guard runs before the body read, so the organization travels in the query.
    url: "/auth/sso/setup-links/create?organizationId=o1",
    body: { steps: ["domain", "connection"], kinds: ["oidc"], note: "Ada at IT", ttlHours: 24 },
    answer: { id: "l1", token: "sl_clear", expiresAt: "2026-01-08T00:00:00.000Z" },
    value: { id: "l1", token: "sl_clear", expiresAt: "2026-01-08T00:00:00.000Z" },
  },
  {
    name: "sso.setupLinks.list",
    run: (c) => c.sso.setupLinks.list({ organizationId: "o1" }),
    route: "GET /sso/setup-links/list",
    url: "/auth/sso/setup-links/list?organizationId=o1",
    body: undefined,
    answer: { links: [SETUP_LINK] },
    value: [SETUP_LINK],
  },
  {
    name: "sso.setupLinks.get",
    run: (c) => c.sso.setupLinks.get({ id: "l1" }),
    route: "GET /sso/setup-links/get",
    url: "/auth/sso/setup-links/get?id=l1",
    body: undefined,
    answer: { link: SETUP_LINK, preview: SETUP_PREVIEW },
    value: { link: SETUP_LINK, preview: SETUP_PREVIEW },
  },
  {
    name: "sso.setupLinks.revoke",
    run: (c) => c.sso.setupLinks.revoke({ id: "l1" }),
    route: "POST /sso/setup-links/revoke",
    url: "/auth/sso/setup-links/revoke",
    body: { id: "l1" },
    answer: { ok: true },
    value: { ok: true },
  },
  {
    name: "sso.setupLinks.activate",
    run: (c) => c.sso.setupLinks.activate({ id: "l1" }),
    route: "POST /sso/setup-links/activate",
    url: "/auth/sso/setup-links/activate",
    body: { id: "l1" },
    answer: { connection: CONNECTION },
    value: CONNECTION,
  },
  {
    name: "sso.setup.open",
    run: (c) => c.sso.setup.open({ token: "sl_clear" }),
    route: "POST /sso/setup/open",
    url: "/auth/sso/setup/open",
    body: { token: "sl_clear" },
    answer: { linkId: "l1" },
    value: { linkId: "l1" },
  },
  {
    name: "sso.setup.status",
    run: (c) => c.sso.setup.status({ run: "r1" }),
    route: "GET /sso/setup/status",
    url: "/auth/sso/setup/status?run=r1",
    body: undefined,
    answer: SETUP_STATUS,
    value: SETUP_STATUS,
  },
  {
    name: "sso.setup.domains.add",
    run: (c) => c.sso.setup.domains.add({ domain: "acme.example" }),
    route: "POST /sso/setup/domains/add",
    url: "/auth/sso/setup/domains/add",
    body: { domain: "acme.example" },
    answer: { domain: DOMAIN },
    value: DOMAIN,
  },
  {
    name: "sso.setup.domains.verify",
    run: (c) => c.sso.setup.domains.verify({ id: "d1" }),
    route: "POST /sso/setup/domains/verify",
    url: "/auth/sso/setup/domains/verify",
    body: { id: "d1" },
    answer: { domain: DOMAIN },
    value: DOMAIN,
  },
  {
    name: "sso.setup.connection",
    run: (c) => c.sso.setup.connection(SETUP_DRAFT),
    route: "POST /sso/setup/connection",
    url: "/auth/sso/setup/connection",
    body: SETUP_DRAFT,
    answer: { connection: CONNECTION },
    value: CONNECTION,
  },
  {
    name: "sso.setup.scimToken",
    run: (c) => c.sso.setup.scimToken(),
    route: "POST /sso/setup/scim-token",
    url: "/auth/sso/setup/scim-token",
    body: undefined,
    answer: { id: "s1", token: "sk_clear", scimBaseUrl: "https://api.example.com/auth/scim/v2" },
    value: { id: "s1", token: "sk_clear", scimBaseUrl: "https://api.example.com/auth/scim/v2" },
  },
  {
    name: "sso.setup.handback",
    run: (c) => c.sso.setup.handback(),
    route: "POST /sso/setup/handback",
    url: "/auth/sso/setup/handback",
    body: undefined,
    answer: { ok: true },
    value: { ok: true },
  },
];

/** A client whose fetch keeps each request and answers `status` with `body`. */
function answering(status: number, body: unknown) {
  const seen: { route: string; url: string; body: unknown }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    seen.push({
      route: `${req.method} ${url.pathname.replace(/^\/auth/, "")}`,
      url: `${url.pathname}${url.search}`,
      body: text === "" ? undefined : JSON.parse(text),
    });
    return Response.json(body, { status });
  }) as typeof globalThis.fetch;
  return { seen, client: createClient({ baseURL: BASE_URL, fetch }) };
}

/** The codes that ROUTES lists for a route. */
function codesOf(route: string): readonly ErrorCode[] {
  const entry = ROUTES.find((r) => `${r.method} ${r.path}` === route);
  if (!entry) throw new Error(`no route ${route}`);
  return entry.codes;
}

describe("client.sso and client.scim.tokens (plan 12d Task 13)", () => {
  it("calls each SSO route with its body and answers its codes", async () => {
    for (const c of CASES) {
      const { seen, client } = answering(200, c.answer);
      expect(await c.run(client), c.name).toEqual({ ok: true, value: c.value });
      expect(seen, c.name).toEqual([{ route: c.route, url: c.url, body: c.body }]);
      const codes = codesOf(c.route);
      expect(codes.length, c.name).toBeGreaterThan(0);
      for (const code of codes) {
        const status = ERRORS[code];
        const failing = answering(status, { error: code });
        expect(await c.run(failing.client), `${c.name} ${code}`).toEqual({
          ok: false,
          code,
          status,
        });
      }
    }
  });

  it("covers every session route of the sso and scim features, and the discovery", () => {
    const called = new Set(CASES.map((c) => c.route));
    const owned = ROUTES.filter(
      (r) =>
        (r.feature === "sso" || r.feature === "scim") &&
        ((r.auth as readonly string[]).includes("session") || r.path === "/sso/discover"),
    ).map((r) => `${r.method} ${r.path}`);
    // Plan 13a Task 11: the twelve calls of the setup are the other rows of CASES, and
    // the confirm page (a link that a browser opens) is the one setup route with no call.
    const setup = ROUTES.filter((r) => r.feature === "ssoSetup" && r.path !== "/sso/setup").map(
      (r) => `${r.method} ${r.path}`,
    );
    expect(setup).toHaveLength(12);
    expect([...owned, ...setup].sort()).toEqual([...called].sort());
    expect(owned).toHaveLength(13);
  });

  it("asks for JSON on the setup status, and refuses a page as the answer", async () => {
    let accept: string | null = null;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      accept = new Request(input, init).headers.get("accept");
      return Response.json(SETUP_STATUS);
    }) as typeof globalThis.fetch;
    const client = createClient({ baseURL: BASE_URL, fetch });
    expect((await client.sso.setup.status()).ok).toBe(true);
    // Core answers the page of the setup to any other Accept: the call must name JSON.
    expect(accept).toBe("application/json");
    // A page answer is not the contract: the client does not hand HTML to the app.
    const page = createClient({
      baseURL: BASE_URL,
      fetch: (async () =>
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        })) as typeof globalThis.fetch,
    });
    expect(await page.sso.setup.status()).toEqual({ ok: false, code: "unexpected", status: 200 });
  });

  it("answers the refusals of a setup route with its own code", async () => {
    const { client: forbidden } = answering(403, { error: "forbidden_rank" });
    expect(await forbidden.sso.setupLinks.get({ id: "l1" })).toEqual({
      ok: false,
      code: "forbidden_rank",
      status: 403,
    });
    const { client: notTested } = answering(409, { error: "setup_not_tested" });
    expect(await notTested.sso.setupLinks.activate({ id: "l1" })).toEqual({
      ok: false,
      code: "setup_not_tested",
      status: 409,
    });
    const { client: noCookie } = answering(401, { error: "unauthorized" });
    expect(await noCookie.sso.setup.handback()).toEqual({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
  });

  it("answers a typed error for each refusal code of the setup calls", async () => {
    type C = ReturnType<typeof answering>["client"];
    const create = (c: C) =>
      c.sso.setupLinks.create({
        organizationId: "o1",
        steps: ["domain"],
        kinds: ["oidc"],
        note: "Ada at IT",
      });
    const calls: [string, number, (c: C) => Promise<unknown>][] = [
      ["setup_link_invalid", 404, (c) => c.sso.setupLinks.revoke({ id: "l1" })],
      ["setup_link_limit", 409, create],
      ["domain_limit", 409, (c) => c.sso.setup.domains.add({ domain: "acme.example" })],
      ["domain_taken", 409, (c) => c.sso.setup.domains.verify({ id: "d1" })],
      ["domain_unverified", 400, (c) => c.sso.setup.domains.verify({ id: "d1" })],
      ["token_expired", 400, (c) => c.sso.setup.domains.verify({ id: "d1" })],
      ["invalid_body", 400, (c) => c.sso.setup.scimToken()],
      ["rate_limited", 429, (c) => c.sso.setup.handback()],
    ];
    for (const [code, status, run] of calls) {
      const { client } = answering(status, { error: code });
      expect(await run(client), code).toEqual({ ok: false, code, status });
    }
  });

  it("sends no key for an optional field the caller did not set", async () => {
    const { seen, client } = answering(200, {});
    await client.sso.discover({ email: "ada@acme.example" });
    await client.scim.tokens.create({ organizationId: "o1", name: "Okta" });
    await client.sso.domains.update({ id: "d1", connectionId: null });
    expect(seen.map((s) => s.body)).toEqual([
      { email: "ada@acme.example" },
      { organizationId: "o1", name: "Okta" },
      { id: "d1", connectionId: null },
    ]);
  });

  it("builds the start URL of a connection, and refuses an id outside the segment rule", () => {
    const { seen, client } = answering(200, {});
    expect(client.sso.startURL({ connectionId: "01JABCDEF", next: "/home" })).toEqual({
      ok: true,
      value: "https://api.example.com/auth/sso/01JABCDEF/start?next=%2Fhome",
    });
    expect(client.sso.startURL({ connectionId: "01JABCDEF" })).toEqual({
      ok: true,
      value: "https://api.example.com/auth/sso/01JABCDEF/start",
    });
    for (const connectionId of ["", "a/b", "a%2Fb", "a b", ".", "..", "x".repeat(129)])
      expect(client.sso.startURL({ connectionId }), connectionId).toEqual({
        ok: false,
        code: "invalid_body",
        status: 0,
      });
    // A start is a link: no request leaves the client.
    expect(seen).toEqual([]);
  });

  it("sends the browser to the start URL", () => {
    const went: string[] = [];
    const client = createClient({ baseURL: BASE_URL, navigate: (url) => went.push(url) });
    expect(client.sso.signIn({ connectionId: "c1" })).toEqual({
      ok: true,
      value: { url: "https://api.example.com/auth/sso/c1/start" },
    });
    expect(client.sso.signIn({ connectionId: ".." })).toEqual({
      ok: false,
      code: "invalid_body",
      status: 0,
    });
    expect(went).toEqual(["https://api.example.com/auth/sso/c1/start"]);
  });

  it("discovers on a split origin: the start is a URL of the api origin, with next", async () => {
    // The two resolvers of the domain proof read one test zone.
    const zone = new Map<string, string[]>();
    const dns = ["a", "b"].map((name) => ({
      name,
      txt: async (n: string) => zone.get(n) ?? [],
    }));
    const server = makeServer({ appURL: APP_ORIGIN, organizations: {}, sso: { oidc: true, dns } });
    const sso = server.auth.api.sso;
    if (!sso) throw new Error("sso is off");
    // An owner makes the organization through the client, signed in by a magic link.
    const { fetch } = inProcessFetch(server.auth);
    const owner = createClient({ baseURL: BASE_URL, fetch });
    if (!(await owner.magicLink.request({ email: "owner@owner.example" })).ok) throw new Error();
    const v = await owner.magicLink.verify({
      token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
    });
    if (!v.ok) throw new Error(v.code);
    const made = await owner.organizations.create({ slug: "acme", name: "Acme" });
    if (!made.ok) throw new Error(made.code);
    const organizationId = made.value.organization.id;
    // The app proves the domain and routes it to an OIDC connection.
    const actor = { kind: "app", name: "admin-page" } as const;
    const domain = await sso.domains.add({ actor, organizationId, domain: "acme.example" });
    if (!domain.ok || !domain.value.record) throw new Error("no domain");
    zone.set(domain.value.record.name, [domain.value.record.value]);
    if (!(await sso.domains.verify({ actor, id: domain.value.id })).ok) throw new Error();
    const idp = "https://login.acme-idp.example";
    const connection = await sso.connections.create({
      actor,
      organizationId,
      kind: "oidc",
      label: "Acme staff",
      issuer: idp,
      clientId: "acme-client",
      clientSecret: "acme-secret-0123456789",
      endpoints: {
        authorizeUrl: `${idp}/authorize`,
        tokenUrl: `${idp}/token`,
        jwksUrl: `${idp}/keys`,
      },
    });
    if (!connection.ok) throw new Error(connection.code);
    const connectionId = connection.value.id;
    const routed = await sso.domains.update({ actor, id: domain.value.id, connectionId });
    if (!routed.ok) throw new Error(routed.code);

    // A page of the app origin asks the api origin.
    const page = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    const found = await page.sso.discover({ email: "ada@acme.example", next: "/home" });
    if (!found.ok || !found.value.sso) throw new Error("no SSO");
    expect(found.value.connectionId).toBe(connectionId);
    const start = new URL(found.value.start);
    expect(start.origin).toBe(BASE_URL);
    expect(start.origin).not.toBe(APP_ORIGIN);
    // The answer is the start URL that the client builds for the same connection and next.
    expect(page.sso.startURL({ connectionId, next: "/home" })).toEqual({
      ok: true,
      value: found.value.start,
    });
    // The browser goes to the start as it is, and the start sends it to the provider.
    const go = await server.auth.handle(new Request(found.value.start));
    expect(go.status).toBe(302);
    expect(new URL(go.headers.get("location") ?? "").origin).toBe(idp);
  });
});
