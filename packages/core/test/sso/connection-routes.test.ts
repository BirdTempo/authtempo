import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { createOrganization } from "../../src/engine/organizations.js";
import { createConnection } from "../../src/engine/sso/connections.js";
import { addDomain } from "../../src/engine/sso/domains.js";
import { BODY_CAP_FLOOR, bodyCapOf } from "../../src/http/body-cap.js";
import { createRouter } from "../../src/http/router.js";
import { coreRoutes } from "../../src/http/routes/index.js";
import { SSO_MANAGE_PER_USER } from "../../src/http/routes/sso.js";
import { createTestIdp } from "../../src/testing/saml-idp.js";
import { BASE_URL } from "../helpers.js";
import { operatorFixture } from "../operator-helpers.js";
import { enrolled, verifiedSession } from "../totp-helpers.js";
import { fakeDns, SSO_APP } from "./helpers.js";

beforeEach(() => {
  // A refused guard writes one log line; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const IP = "203.0.113.9";
const MINUTE_MS = 60_000;

/**
 * The 12f fixture with OIDC and SAML connections on, and an owner of
 * `acme` with a factor and a fresh session. `factor: false` leaves the
 * operator's second factor off. `limits` goes into `sso`.
 */
async function routeWorld(
  options: { factor?: boolean; limits?: { connectionsPerOrganization: number } } = {},
) {
  const config: Partial<AuthConfig> = {
    sso: {
      oidc: true,
      saml: true,
      dns: [fakeDns("a", {})],
      ...(options.limits ? { limits: options.limits } : {}),
    },
  };
  const f = await operatorFixture({
    ...(options.factor === undefined ? {} : { factor: options.factor }),
    config,
  });
  const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
  const plain = await verifiedSession(f.auth, "owner@acme.example");
  const made = await createOrganization(f.auth.config, {
    user: plain.user,
    slug: "acme",
    name: "Acme",
  });
  if (!made.ok) throw new Error(made.code);
  // The owner turns on a factor after the create; the sign-in of the enable is fresh.
  const owner = (await enrolled(f.auth, "owner@acme.example")).session;
  return { ...f, handle, owner, org: made.value.organization.id };
}
type RouteWorld = Awaited<ReturnType<typeof routeWorld>>;

/** One route call with the session cookie of `token`, an IP, and a user agent: its status and body. */
async function send(
  w: RouteWorld,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  token: string | null,
): Promise<[number, Record<string, unknown>]> {
  const headers: Record<string, string> = {
    "cf-connecting-ip": IP,
    "user-agent": "manager/2",
    ...(token === null ? {} : { cookie: `__Host-tempo_session=${token}` }),
  };
  const request =
    method === "GET"
      ? new Request(`${BASE_URL}/auth${path}`, { headers })
      : new Request(`${BASE_URL}/auth${path}`, {
          method,
          headers: { ...headers, "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify(body),
        });
  const res = await w.handle(request);
  return [res.status, (await res.json()) as Record<string, unknown>];
}

const oidcBody = (organizationId: string) => ({
  organizationId,
  kind: "oidc",
  label: "Acme Entra ID",
  issuer: "https://login.idp.example/acme/v2.0",
  clientId: "acme",
  clientSecret: "acme-secret-0123456789",
});

describe("the connection routes (plan 12d Task 3)", () => {
  it("serves the connections of an organization to its owner, with an audit row per write", async () => {
    const w = await routeWorld();
    const idp = await createTestIdp({ alg: "ec", entityId: "https://idp.example/metadata" });
    const list = `/sso/connections?organizationId=${w.org}`;
    expect(await send(w, "GET", list, null, w.owner.token)).toEqual([200, { connections: [] }]);
    const [s1, oidc] = await send(
      w,
      "POST",
      "/sso/connections/create",
      { ...oidcBody(w.org), tokenEndpointAuthMethod: "client_secret_basic" },
      w.owner.token,
    );
    expect(s1).toBe(200);
    const o = oidc.connection as {
      id: string;
      saml?: unknown;
      oidc: { endpoints: unknown; tokenEndpointAuthMethod: string };
    };
    expect([o.saml, o.oidc.endpoints, o.oidc.tokenEndpointAuthMethod]).toEqual([
      undefined,
      null,
      "client_secret_basic",
    ]);
    // A new millisecond: an id orders the rows by their time.
    w.auth.clock.advance(1000);
    const [s2, saml] = await send(
      w,
      "POST",
      "/sso/connections/create",
      {
        organizationId: w.org,
        kind: "saml",
        label: "Acme Okta",
        idpEntityId: idp.entityId,
        ssoUrl: "https://idp.example/sso",
        certificates: [idp.certificatePem],
      },
      w.owner.token,
    );
    expect(s2).toBe(200);
    const s = saml.connection as { id: string; oidc?: unknown };
    expect(s.oidc).toBeUndefined();
    const [, listed] = await send(w, "GET", list, null, w.owner.token);
    expect((listed.connections as { id: string }[]).map((c) => c.id)).toEqual([o.id, s.id]);
    for (const id of [o.id, s.id]) {
      const [status, body] = await send(
        w,
        "POST",
        "/sso/connections/update",
        { id, label: "Renamed", jit: false },
        w.owner.token,
      );
      expect([status, (body.connection as { label: string }).label]).toEqual([200, "Renamed"]);
    }
    expect(
      await send(w, "POST", "/sso/connections/update", { id: o.id, kind: "saml" }, w.owner.token),
    ).toEqual([400, { error: "invalid_body", message: "kind and organizationId do not change" }]);
    expect(await send(w, "POST", "/sso/connections/delete", { id: s.id }, w.owner.token)).toEqual([
      200,
      { ok: true },
    ]);
    const rows = await w.auth.storage.findMany("operatorAudit", [
      { field: "actorId", op: "eq", value: w.owner.user.id },
    ]);
    expect(rows.map((r) => [r.action, r.actorKind, r.ip, r.userAgent])).toEqual([
      ["sso_connection_create", "user", IP, "manager/2"],
      ["sso_connection_create", "user", IP, "manager/2"],
      ["sso_connection_update", "user", IP, "manager/2"],
      ["sso_connection_update", "user", IP, "manager/2"],
      ["sso_connection_delete", "user", IP, "manager/2"],
    ]);
  });

  it("answers the refusals of the guard, the input, and the limit", async () => {
    const w = await routeWorld({ factor: false, limits: { connectionsPerOrganization: 1 } });
    const made = await createConnection(w.auth.config, SSO_APP, {
      ...oidcBody(w.org),
      kind: "oidc",
    });
    if (!made.ok) throw new Error(made.code);
    const id = made.value.id;
    const calls = [
      ["GET", `/sso/connections?organizationId=${w.org}`, null],
      ["POST", "/sso/connections/create", oidcBody(w.org)],
      ["POST", "/sso/connections/update", { id, label: "X" }],
      ["POST", "/sso/connections/delete", { id }],
    ] as const;
    for (const [method, path, body] of calls) {
      expect(await send(w, method, path, body, null), path).toEqual([
        401,
        { error: "unauthorized" },
      ]);
      // A platform operator with no second factor fails the operator guard.
      expect(await send(w, method, path, body, w.operator.token), path).toEqual([
        403,
        { error: "operator_required" },
      ]);
    }
    // The owner, with the factor and a fresh session, meets the limit of one connection.
    expect(
      await send(w, "POST", "/sso/connections/create", oidcBody(w.org), w.owner.token),
    ).toEqual([409, { error: "connection_limit" }]);
    expect(
      await send(
        w,
        "POST",
        "/sso/connections/create",
        { ...oidcBody(w.org), label: "" },
        w.owner.token,
      ),
    ).toEqual([
      400,
      {
        error: "invalid_body",
        message: "label must be 1 to 80 characters with no control character",
      },
    ]);
    expect(await send(w, "GET", "/sso/connections", null, w.owner.token)).toEqual([
      400,
      { error: "invalid_body" },
    ]);
    for (const [path, body] of [
      ["/sso/connections/update", { id, more: 1 }],
      ["/sso/connections/update", { id, tokenEndpointAuthMethod: "private_key_jwt" }],
      ["/sso/connections/delete", { id, more: 1 }],
    ] as const)
      expect(await send(w, "POST", path, body, w.owner.token), path).toEqual([
        400,
        { error: "invalid_body" },
      ]);
    // An id that names no connection, and an organization that does not exist.
    for (const path of ["/sso/connections/update", "/sso/connections/delete"])
      expect(await send(w, "POST", path, { id: "c-none" }, w.owner.token), path).toEqual([
        404,
        { error: "not_found" },
      ]);
  });

  it("answers not_found to a platform operator for an organization that does not exist", async () => {
    const w = await routeWorld();
    expect(
      await send(w, "GET", "/sso/connections?organizationId=o-none", null, w.operator.token),
    ).toEqual([404, { error: "not_found" }]);
    expect(
      await send(w, "POST", "/sso/connections/create", oidcBody("o-none"), w.operator.token),
    ).toEqual([404, { error: "not_found" }]);
  });

  it("answers second_factor_required and session_not_fresh on every manager route", async () => {
    const w = await routeWorld();
    const plain = await verifiedSession(w.auth, "solo@beta.example");
    const beta = await createOrganization(w.auth.config, {
      user: plain.user,
      slug: "beta",
      name: "Beta",
    });
    if (!beta.ok) throw new Error(beta.code);
    const org = beta.value.organization.id;
    const domain = await addDomain(w.auth.config, SSO_APP, {
      organizationId: org,
      domain: "beta.example",
    });
    const connection = await createConnection(w.auth.config, SSO_APP, {
      ...oidcBody(org),
      kind: "oidc",
    });
    if (!domain.ok || !connection.ok) throw new Error("the setup failed");
    const calls = [
      ["GET", `/sso/domains?organizationId=${org}`, null],
      ["POST", "/sso/domains/add", { organizationId: org, domain: "two.beta.example" }],
      ["POST", "/sso/domains/verify", { id: domain.value.id }],
      ["POST", "/sso/domains/update", { id: domain.value.id, includeSubdomains: true }],
      ["POST", "/sso/domains/delete", { id: domain.value.id }],
      ["GET", `/sso/connections?organizationId=${org}`, null],
      ["POST", "/sso/connections/create", oidcBody(org)],
      ["POST", "/sso/connections/update", { id: connection.value.id, label: "X" }],
      ["POST", "/sso/connections/delete", { id: connection.value.id }],
    ] as const;
    // The owner has no second factor yet.
    for (const [method, path, body] of calls)
      expect(await send(w, method, path, body, plain.token), path).toEqual([
        403,
        { error: "second_factor_required" },
      ]);
    // With the factor, a session older than the fresh window.
    const factor = (await enrolled(w.auth, "solo@beta.example")).session;
    w.auth.clock.advance(w.auth.config.session.freshMinutes * MINUTE_MS);
    for (const [method, path, body] of calls)
      expect(await send(w, method, path, body, factor.token), path).toEqual([
        403,
        { error: "session_not_fresh" },
      ]);
  });
});

/** A POST of the JSON text `text` with the session cookie of `token`, so a test can read `bodyUsed` after the answer. */
function rawPost(path: string, text: string, token: string | null): Request {
  return new Request(`${BASE_URL}/auth${path}`, {
    method: "POST",
    headers: {
      "cf-connecting-ip": IP,
      "content-type": "application/json",
      origin: BASE_URL,
      ...(token === null ? {} : { cookie: `__Host-tempo_session=${token}` }),
    },
    body: text,
  });
}

describe("the body cap of the connection writes (ruling 46 of the 12j lane)", () => {
  it("reads the body of a connection write only after the session check and the limit of the user", async () => {
    const w = await routeWorld();
    const text = JSON.stringify({ ...oidcBody(w.org), idpMetadata: "m".repeat(200_000) });
    for (const path of ["/sso/connections/create", "/sso/connections/update"]) {
      const anonymous = rawPost(path, text, null);
      const res = await w.handle(anonymous);
      expect(res.status).toBe(401);
      expect(anonymous.bodyUsed).toBe(false);
    }
    // The limit of the user: each write before it reads its body, the next one does not. A
    // domain write spends the count at the floor, so the limit of the large reads takes no part.
    for (let i = 0; i < SSO_MANAGE_PER_USER.max; i++) {
      const res = await w.handle(rawPost("/sso/domains/update", "{}", w.owner.token));
      expect(res.status).toBe(400);
    }
    const limited = rawPost("/sso/connections/create", text, w.owner.token);
    expect((await w.handle(limited)).status).toBe(429);
    expect(limited.bodyUsed).toBe(false);
  });

  it("reads a connection write past the floor up to 8 MiB, and answers 413 past it", async () => {
    const w = await routeWorld();
    const cap = bodyCapOf("POST /sso/connections/create");
    expect(cap).toBe(8_388_608);
    // The largest metadata that the schema allows: past the floor of every other route.
    const text = JSON.stringify({
      organizationId: w.org,
      kind: "saml",
      label: "Acme Okta",
      idpMetadata: "m".repeat(200_000),
    });
    expect(text.length).toBeGreaterThan(BODY_CAP_FLOOR);
    const [status, body] = await (async () => {
      const res = await w.handle(rawPost("/sso/connections/create", text, w.owner.token));
      return [res.status, (await res.json()) as { error: string }] as const;
    })();
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_body");
    const over = await w.handle(
      rawPost("/sso/connections/create", text + " ".repeat(cap + 1 - text.length), w.owner.token),
    );
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "body_too_large" });
  });
});
