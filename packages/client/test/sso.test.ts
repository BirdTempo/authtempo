import { ERRORS, type ErrorCode } from "@authtempo/core/errors";
import { ROUTES } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { type Client, createClient } from "../src/client.js";
import type { ClientResult } from "../src/result.js";
import { BASE_URL } from "./harness.js";

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
};

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
    answer: { sso: true, start: "/auth/sso/c1/start" },
    value: { sso: true, start: "/auth/sso/c1/start" },
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
    url: "/auth/sso/connections/create",
    body: {
      organizationId: "o1",
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
    url: "/auth/sso/connections/update",
    body: { id: "c1", scimRoles: { Admins: "admin" } },
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
    expect(owned.sort()).toEqual([...called].sort());
    expect(owned).toHaveLength(13);
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
});
