import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoConfig } from "../src/config.js";
import { createOrganization } from "../src/engine/organizations.js";
import { createSetupLink } from "../src/engine/sso/setup-links.js";
import { ROUTES, type RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { SETUP_SESSION_ROUTES } from "../src/http/routes/sso-setup.js";
import { BASE_URL, recordCredential } from "./helpers.js";
import { operatorFixture } from "./operator-helpers.js";
import { FAST } from "./password-helpers.js";
import { fakeDns, SSO_APP, ssoAuth } from "./sso/helpers.js";
import { managerSession } from "./sso/manager-helpers.js";
import { enrolled, verifiedSession } from "./totp-helpers.js";

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const LINK_KEYS = [
  "POST /sso/setup-links/create",
  "GET /sso/setup-links/list",
  "GET /sso/setup-links/get",
  "POST /sso/setup-links/revoke",
  "POST /sso/setup-links/activate",
] as const;

/** Two organizations, each with an owner who has a fresh session and TOTP. */
async function world(setup = true) {
  const w = ssoAuth({
    sso: setup ? { oidc: true, setup: {} } : { oidc: true },
    password: { hash: FAST, uniformSignUp: false },
  });
  const a = await managerSession(w, "owner@acme.example", "acme");
  const b = await managerSession(w, "owner@beta.example", "beta");
  return { w, a, b };
}
type World = Awaited<ReturnType<typeof world>>;

/** One call as a manager (`token`) or with no credential (`null`). */
async function call(
  w: { handle: (request: Request) => Promise<Response> },
  method: "GET" | "POST",
  path: string,
  token: string | null,
  body?: unknown,
): Promise<[number, Record<string, unknown>]> {
  const headers: Record<string, string> = {
    "cf-connecting-ip": "198.51.100.9",
    "user-agent": "links-test/1",
    ...(token === null ? {} : { cookie: `__Host-tempo_session=${token}` }),
  };
  const req =
    method === "GET"
      ? new Request(`${BASE_URL}/auth${path}`, { headers })
      : new Request(`${BASE_URL}/auth${path}`, {
          method,
          headers: { ...headers, "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify(body ?? {}),
        });
  const res = await w.handle(req);
  return [res.status, (await res.json()) as Record<string, unknown>];
}

const MINT: {
  steps: ("domain" | "connection" | "directory")[];
  kinds: ("oidc" | "saml")[];
  note: string;
} = { steps: ["domain", "connection"], kinds: ["oidc"], note: "Ada at Acme IT" };

async function mint(w: World["w"], org: string, token: string) {
  const [status, body] = await call(
    w,
    "POST",
    `/sso/setup-links/create?organizationId=${org}`,
    token,
    MINT,
  );
  expect(status).toBe(200);
  recordCredential(String(body.token));
  return body as { id: string; token: string; expiresAt: string };
}

const rows = (w: World["w"]) => w.storage.findMany("ssoSetupLink", []);

describe("the setup link routes (plan 13a Task 11)", () => {
  it("is classified: each key is in ROUTES with the session auth", () => {
    for (const key of LINK_KEYS) {
      const r = ROUTES.find((x) => `${x.method} ${x.path}` === key);
      expect(r, key).toBeDefined();
      expect([...(r?.auth ?? [])], key).toContain("session");
    }
  });

  it("is off by default: no setup route in the router when sso.setup is absent", async () => {
    const { w } = await world(false);
    const keys = new Set(coreRoutes(w.config).map((r) => r.key));
    for (const key of LINK_KEYS) expect(keys.has(key), key).toBe(false);
    // The routes of the setup session, from the closed list (the test start has a query, no key of its own).
    const session = SETUP_SESSION_ROUTES.filter((key) => !key.includes("?"));
    expect(session).toHaveLength(6);
    for (const key of session) expect(keys.has(key as RouteKey), key).toBe(false);
  });

  it("answers 409 setup_link_limit to a third live link through the route", async () => {
    const { w, a } = await world();
    await mint(w, a.org, a.token);
    await mint(w, a.org, a.token);
    const [status, answer] = await call(
      w,
      "POST",
      `/sso/setup-links/create?organizationId=${a.org}`,
      a.token,
      MINT,
    );
    expect([status, answer]).toEqual([409, { error: "setup_link_limit" }]);
    expect(await rows(w)).toHaveLength(2);
  });

  it("answers 401 to each route with no credential", async () => {
    const { w, a } = await world();
    const made = await mint(w, a.org, a.token);
    const calls: [string, string, string, unknown?][] = [
      ["POST", `/sso/setup-links/create?organizationId=${a.org}`, "", MINT],
      ["GET", `/sso/setup-links/list?organizationId=${a.org}`, ""],
      ["GET", `/sso/setup-links/get?id=${made.id}`, ""],
      ["POST", "/sso/setup-links/revoke", "", { id: made.id }],
      ["POST", "/sso/setup-links/activate", "", { id: made.id }],
    ];
    for (const [method, path, , body] of calls) {
      const [status, answer] = await call(w, method as "GET" | "POST", path, null, body);
      expect([path, status, answer]).toEqual([path, 401, { error: "unauthorized" }]);
    }
  });

  it("answers 400 invalid_body to a bad body or a bad query", async () => {
    const { w, a } = await world();
    const bad: [string, string, unknown?][] = [
      ["POST", `/sso/setup-links/create?organizationId=${a.org}`, { steps: [] }],
      ["POST", `/sso/setup-links/create?organizationId=${a.org}`, { ...MINT, extra: 1 }],
      ["POST", "/sso/setup-links/revoke", { id: "" }],
      ["POST", "/sso/setup-links/activate", { id: 5 }],
      ["GET", "/sso/setup-links/list"],
      ["GET", "/sso/setup-links/get"],
    ];
    for (const [method, path, body] of bad) {
      const [status, answer] = await call(w, method as "GET" | "POST", path, a.token, body);
      expect([path, status, answer]).toEqual([path, 400, { error: "invalid_body" }]);
    }
    expect(await rows(w)).toEqual([]);
  });

  it("creates, lists, gets, and revokes a link, and answers get with a null preview", async () => {
    const { w, a } = await world();
    const made = await mint(w, a.org, a.token);
    expect(made.token).toMatch(/^sl_/);
    const [ls, list] = await call(
      w,
      "GET",
      `/sso/setup-links/list?organizationId=${a.org}`,
      a.token,
    );
    expect(ls).toBe(200);
    expect((list.links as { id: string }[]).map((l) => l.id)).toEqual([made.id]);
    const [gs, got] = await call(w, "GET", `/sso/setup-links/get?id=${made.id}`, a.token);
    expect(gs).toBe(200);
    expect(got.preview).toBeNull();
    expect((got.link as { id: string }).id).toBe(made.id);
    expect(JSON.stringify(got)).not.toContain(made.token);
    const [rs, revoked] = await call(w, "POST", "/sso/setup-links/revoke", a.token, {
      id: made.id,
    });
    expect([rs, revoked]).toEqual([200, { ok: true }]);
    expect((await rows(w))[0]?.revokedAt).not.toBeNull();
  });

  it("answers 409 setup_not_tested to an activate of a link with no passed run", async () => {
    const { w, a } = await world();
    const made = await mint(w, a.org, a.token);
    const [status, answer] = await call(w, "POST", "/sso/setup-links/activate", a.token, {
      id: made.id,
    });
    expect(status).toBe(409);
    expect(answer.error).toBe("setup_not_tested");
  });

  it("answers an owner of another organization 403 forbidden_rank and writes nothing", async () => {
    const { w, a, b } = await world();
    const made = await mint(w, a.org, a.token);
    const before = await rows(w);
    const refused: [string, string, unknown?][] = [
      ["GET", `/sso/setup-links/get?id=${made.id}`],
      ["GET", `/sso/setup-links/list?organizationId=${a.org}`],
      ["POST", "/sso/setup-links/revoke", { id: made.id }],
      ["POST", "/sso/setup-links/activate", { id: made.id }],
      ["POST", `/sso/setup-links/create?organizationId=${a.org}`, MINT],
    ];
    for (const [method, path, body] of refused) {
      const [status, answer] = await call(w, method as "GET" | "POST", path, b.token, body);
      expect([path, status, answer]).toEqual([path, 403, { error: "forbidden_rank" }]);
    }
    expect(await rows(w)).toEqual(before);
  });

  it("answers an unknown link id 404 not_found", async () => {
    const { w, a } = await world();
    const [status, answer] = await call(w, "GET", "/sso/setup-links/get?id=nope", a.token);
    expect([status, answer]).toEqual([404, { error: "not_found" }]);
  });
});

describe("the guard of the setup link routes (plan 13a Task 11)", () => {
  it("answers operator_required, second_factor_required, and session_not_fresh at each route", async () => {
    const f = await operatorFixture({
      factor: false,
      config: { sso: { oidc: true, dns: [fakeDns("a", {})], setup: {} } as SsoConfig },
    });
    const w = { handle: createRouter(f.auth.config, coreRoutes(f.auth.config)) };
    const plain = await verifiedSession(f.auth, "solo@beta.example");
    const beta = await createOrganization(f.auth.config, {
      user: plain.user,
      slug: "beta",
      name: "Beta",
    });
    if (!beta.ok) throw new Error(beta.code);
    const org = beta.value.organization.id;
    const link = await createSetupLink(f.auth.config, SSO_APP, { organizationId: org, ...MINT });
    if (!link.ok) throw new Error(link.code);
    const id = link.value.id;
    const calls = [
      ["POST", `/sso/setup-links/create?organizationId=${org}`, MINT],
      ["GET", `/sso/setup-links/list?organizationId=${org}`, undefined],
      ["GET", `/sso/setup-links/get?id=${id}`, undefined],
      ["POST", "/sso/setup-links/revoke", { id }],
      ["POST", "/sso/setup-links/activate", { id }],
    ] as const;
    const refused = async (token: string, code: string) => {
      for (const [method, path, body] of calls)
        expect(await call(w, method, path, token, body), path).toEqual([403, { error: code }]);
    };
    // A platform operator with no second factor fails the operator guard.
    await refused(f.operator.token, "operator_required");
    // The owner has no second factor yet.
    await refused(plain.token, "second_factor_required");
    // With the factor, a session older than the fresh window.
    const factor = (await enrolled(f.auth, "solo@beta.example")).session;
    f.auth.clock.advance(f.auth.config.session.freshMinutes * 60_000);
    await refused(factor.token, "session_not_fresh");
    expect(await f.auth.storage.findMany("ssoSetupLink", [])).toHaveLength(1);
  });
});
