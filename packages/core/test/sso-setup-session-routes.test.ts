import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoConfig } from "../src/config.js";
import { resolveSession } from "../src/engine/sessions.js";
import { requireSsoManager } from "../src/engine/sso/guard.js";
import { createSetupLink } from "../src/engine/sso/setup-links.js";
import { BODY_CAPS } from "../src/http/body-cap.js";
import { SETUP_SESSION_ROUTES } from "../src/http/routes/sso-setup.js";
import { SETUP_SESSION_COOKIE } from "../src/primitives/credentials.js";
import { newId } from "../src/primitives/ids.js";
import { BASE_URL, recordCredential } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { type FakeIdToken, fakeFetch, fakeJwt } from "./social-helpers.js";
import { ssoAuth } from "./sso/helpers.js";
import { managerSession } from "./sso/manager-helpers.js";
import { endpointsOf, issuerOf } from "./sso/sign-in-helpers.js";

const SECRET = "idp-client-secret-0123456789";
const OIDC = {
  kind: "oidc",
  label: "Acme Okta",
  issuer: "https://login.idp.example/acme",
  clientId: "acme-client",
  clientSecret: SECRET,
};
const CLIENT = { "cf-connecting-ip": "198.51.100.7", "user-agent": "setup-session-routes/1" };

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function world(
  steps: ("domain" | "connection" | "directory")[] = ["domain", "connection", "directory"],
  limits?: { domainsPerOrganization: number },
) {
  // The fake IdP of a test run: the token endpoint answers the code as the ID token.
  const tokens: Record<string, FakeIdToken> = {};
  const idp = fakeFetch((call) =>
    Response.json({ id_token: call.form.code, token_type: "Bearer" }),
  );
  const w = ssoAuth({
    sso: {
      oidc: true,
      setup: {},
      fetch: idp.fetchFn,
      ...(limits ? { limits } : {}),
    } as SsoConfig,
    jwt: fakeJwt(tokens),
    scim: {},
    password: { hash: FAST, uniformSignUp: false },
  });
  const a = await managerSession(w, "owner@acme.example", "acme");
  const b = await managerSession(w, "owner@beta.example", "beta");
  const actorOf = async (m: typeof a) => {
    const resolved = await resolveSession(w.config, m.token);
    if (!resolved) throw new Error("the session ended");
    const g = await requireSsoManager(w.config, resolved, m.org);
    if (!g.ok) throw new Error(g.code);
    return g.value;
  };
  /** A link of `m`'s organization, opened through the route: the setup cookie pair. */
  const open = async (m: typeof a, linkSteps = steps) => {
    const made = await createSetupLink(w.config, await actorOf(m), {
      organizationId: m.org,
      steps: linkSteps,
      kinds: ["oidc"],
      note: "Ada at IT",
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const res = await w.handle(post("/sso/setup/open", { token: made.value.token }));
    const pair = (res.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    recordCredential(pair.split("=")[1] ?? "");
    return { cookie: pair, linkId: made.value.id };
  };
  return { w, a, b, open, tokens };
}
type World = Awaited<ReturnType<typeof world>>;

function post(path: string, body: unknown, cookie?: string, raw?: string) {
  return new Request(`${BASE_URL}/auth${path}`, {
    method: "POST",
    headers: {
      ...CLIENT,
      "content-type": "application/json",
      origin: BASE_URL,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: raw ?? JSON.stringify(body),
  });
}

async function send(w: World["w"], path: string, body: unknown, cookie?: string, raw?: string) {
  const res = await w.handle(post(path, body, cookie, raw));
  return [res.status, (await res.json()) as Record<string, unknown>] as const;
}

const NONE = [401, { error: "unauthorized" }] as const;
const PATHS = [
  ["/sso/setup/domains/add", { domain: "acme.example" }],
  ["/sso/setup/domains/verify", { id: "x" }],
  ["/sso/setup/connection", OIDC],
  ["/sso/setup/scim-token", {}],
  ["/sso/setup/handback", {}],
] as const;

describe("the setup session routes (plan 13a Task 11)", () => {
  it("answers each route with no credential, or a manager cookie, as 401 unauthorized", async () => {
    const { w, a } = await world();
    for (const [path, body] of PATHS) {
      expect(await send(w, path, body), path).toEqual(NONE);
      expect(await send(w, path, body, `__Host-tempo_session=${a.token}`), path).toEqual(NONE);
      expect(
        await send(w, path, body, `${SETUP_SESSION_COOKIE}=ss_${"A".repeat(43)}`),
        path,
      ).toEqual(NONE);
    }
    // A bearer token of a manager, on each route of the closed list that has a key of its own.
    for (const key of SETUP_SESSION_ROUTES.filter((k) => !k.includes("?"))) {
      const [method, path] = key.split(" ") as [string, string];
      const bearer = new Request(`${BASE_URL}/auth${path}`, {
        method,
        headers: {
          ...CLIENT,
          authorization: `Bearer ${a.token}`,
          "content-type": "application/json",
          origin: BASE_URL,
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect((await w.handle(bearer)).status, key).toBe(401);
    }
    expect(await w.storage.findMany("ssoConnection", [])).toEqual([]);
    expect(await w.storage.findMany("ssoDomain", [])).toEqual([]);
  });

  it("reads no body before the cookie check: a bad body with no cookie is 401, with a cookie 400", async () => {
    const { w, a, open } = await world();
    const s = await open(a);
    for (const [path] of PATHS.filter(([p]) => p !== "/sso/setup/scim-token")) {
      expect(await send(w, path, null, undefined, "{not json"), path).toEqual(NONE);
    }
    const [status, answer] = await send(w, "/sso/setup/domains/add", { nope: 1 }, s.cookie);
    expect([status, answer]).toEqual([400, { error: "invalid_body" }]);
    const [cs, ca] = await send(w, "/sso/setup/connection", { kind: "oidc" }, s.cookie);
    expect([cs, ca]).toEqual([400, { error: "invalid_body" }]);
  });

  it("holds the connection route to a 4 MiB cap, and reads no body of a caller with no cookie", async () => {
    const cap = BODY_CAPS["POST /sso/setup/connection"];
    expect(cap).toBe(4_194_304);
    const { w, a, open } = await world();
    const s = await open(a);
    const big = "x".repeat(5 * 1024 * 1024);
    // No cookie: the answer is 401 and the body stays unread.
    const bare = post("/sso/setup/connection", null, undefined, big);
    expect((await w.handle(bare)).status).toBe(401);
    expect(bare.bodyUsed).toBe(false);
    // A cookie: the read stops at the cap.
    const [status, answer] = await send(w, "/sso/setup/connection", null, s.cookie, big);
    expect([status, answer]).toEqual([413, { error: "body_too_large" }]);
    expect(await w.storage.findMany("ssoConnection", [])).toEqual([]);
  });

  it("answers 409 domain_limit to a domain past sso.limits.domainsPerOrganization", async () => {
    const { w, a, open } = await world(undefined, { domainsPerOrganization: 1 });
    const s = await open(a);
    const [first] = await send(w, "/sso/setup/domains/add", { domain: "one.example" }, s.cookie);
    expect(first).toBe(200);
    const [status, answer] = await send(
      w,
      "/sso/setup/domains/add",
      { domain: "two.example" },
      s.cookie,
    );
    expect([status, answer]).toEqual([409, { error: "domain_limit" }]);
  });

  it("answers 409 conflict to a link that adds a domain that the manager added", async () => {
    const { w, a, open } = await world();
    const s = await open(a);
    const manager = `__Host-tempo_session=${a.token}`;
    const [ms] = await send(
      w,
      "/sso/domains/add",
      { organizationId: a.org, domain: "acme.example" },
      manager,
    );
    expect(ms).toBe(200);
    const before = await w.storage.findMany("ssoDomain", []);
    const [status, answer] = await send(
      w,
      "/sso/setup/domains/add",
      { domain: "acme.example" },
      s.cookie,
    );
    expect([status, answer]).toEqual([409, { error: "conflict" }]);
    // The challenge of the manager stays: the rows do not change.
    expect(await w.storage.findMany("ssoDomain", [])).toEqual(before);
  });

  it("answers a null scim in the preview of a draft with no directory token", async () => {
    const { w, a, open } = await world();
    const s = await open(a);
    const [, conn] = await send(w, "/sso/setup/connection", OIDC, s.cookie);
    expect(conn.connection).toBeDefined();
    const got = await w.handle(
      new Request(`${BASE_URL}/auth/sso/setup-links/get?id=${s.linkId}`, {
        headers: { ...CLIENT, cookie: `__Host-tempo_session=${a.token}` },
      }),
    );
    expect(got.status).toBe(200);
    const body = (await got.json()) as { preview: { scim: unknown } | null };
    expect(body.preview).not.toBeNull();
    expect(body.preview?.scim).toBeNull();
  });

  it("previews the draft for the manager, and activates it through the route", async () => {
    const { w, a, open, tokens } = await world();
    const s = await open(a);
    const [, added] = await send(w, "/sso/setup/domains/add", { domain: "acme.example" }, s.cookie);
    const domain = added.domain as { id: string; record: { name: string; value: string } };
    w.answers.a[domain.record.name] = [domain.record.value];
    w.answers.b[domain.record.name] = [domain.record.value];
    expect((await send(w, "/sso/setup/domains/verify", { id: domain.id }, s.cookie))[0]).toBe(200);
    const tested = { ...OIDC, issuer: issuerOf("acme"), endpoints: endpointsOf("acme") };
    const [, conn] = await send(w, "/sso/setup/connection", tested, s.cookie);
    const connId = (conn.connection as { id: string }).id;
    expect((await send(w, "/sso/setup/scim-token", {}, s.cookie, "{}"))[0]).toBe(200);
    // The passed run comes by the product path: the test start of the link, then the IdP callback.
    const started = await w.handle(
      new Request(`${BASE_URL}/auth/sso/${connId}/start?test=1`, {
        headers: { ...CLIENT, cookie: s.cookie },
      }),
    );
    expect(started.status).toBe(302);
    const url = new URL(started.headers.get("location") ?? "");
    const bind = started.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Secure-tempo_session_oauth="))
      ?.split(";")[0];
    expect(bind).toBeDefined();
    tokens["tcode-1"] = {
      audience: "acme-client",
      issuer: issuerOf("acme"),
      claims: {
        sub: "a-1",
        email: "ada@acme.example",
        name: "Ada",
        nonce: url.searchParams.get("nonce") ?? "",
      },
    };
    const back = new URLSearchParams({
      code: "tcode-1",
      state: url.searchParams.get("state") ?? "",
    });
    const callback = await w.handle(
      new Request(`${BASE_URL}/auth/sso/${connId}/callback?${back}`, {
        headers: { ...CLIENT, cookie: bind ?? "" },
      }),
    );
    expect(callback.status).toBe(303);
    // The token write after the draft moved the version to 2 (ruling R32). The test ran after it.
    expect(await w.storage.findMany("ssoTestRun", [])).toMatchObject([
      { outcome: "passed", draftVersion: 2, linkId: s.linkId },
    ]);
    const manager = `__Host-tempo_session=${a.token}`;
    const get = await w.handle(
      new Request(`${BASE_URL}/auth/sso/setup-links/get?id=${s.linkId}`, {
        headers: { ...CLIENT, cookie: manager },
      }),
    );
    expect(get.status).toBe(200);
    const got = (await get.json()) as { preview: { scim: unknown; version: number } | null };
    expect(got.preview).not.toBeNull();
    expect(got.preview?.scim).not.toBeNull();
    expect(JSON.stringify(got)).not.toContain(SECRET);
    const [status, activated] = await send(
      w,
      "/sso/setup-links/activate",
      { id: s.linkId, version: got.preview?.version },
      manager,
    );
    expect(status).toBe(200);
    const live = activated.connection as { id: string; label: string };
    expect([live.id, live.label]).toEqual([connId, "Acme Okta"]);
    const row = await w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: connId },
    ]);
    expect(row?.draft).toBe(false);
    expect(JSON.stringify(activated)).not.toContain(SECRET);
    const again = await send(
      w,
      "/sso/setup-links/activate",
      { id: s.linkId, version: got.preview?.version },
      manager,
    );
    expect(again[0]).toBeGreaterThanOrEqual(400);
  });

  it("adds and verifies a domain, saves a draft, mints a token, and hands back", async () => {
    const { w, a, open } = await world();
    const s = await open(a);
    const [ds, added] = await send(
      w,
      "/sso/setup/domains/add",
      { domain: "acme.example" },
      s.cookie,
    );
    expect(ds).toBe(200);
    const domain = added.domain as { id: string; record: { name: string; value: string } };
    w.answers.a[domain.record.name] = [domain.record.value];
    w.answers.b[domain.record.name] = [domain.record.value];
    const [vs, verified] = await send(w, "/sso/setup/domains/verify", { id: domain.id }, s.cookie);
    expect([vs, (verified.domain as { verified: boolean }).verified]).toEqual([200, true]);
    const [cs, conn] = await send(w, "/sso/setup/connection", OIDC, s.cookie);
    expect(cs).toBe(200);
    expect(JSON.stringify(conn)).not.toContain(SECRET);
    const draft = conn.connection as { id: string; kind: string; label: string };
    expect([draft.kind, draft.label]).toEqual(["oidc", "Acme Okta"]);
    const [ts, token] = await send(w, "/sso/setup/scim-token", {}, s.cookie, "");
    expect(ts).toBe(200);
    expect(String(token.token).length).toBeGreaterThan(20);
    recordCredential(String(token.token));
    expect(String(token.scimBaseUrl)).toContain("/scim/v2");
    const [hs, back] = await send(w, "/sso/setup/handback", {}, s.cookie);
    expect([hs, back]).toEqual([200, { ok: true }]);
    const link = await w.storage.findOne("ssoSetupLink", [
      { field: "id", op: "eq", value: s.linkId },
    ]);
    expect(link?.readyAt).not.toBeNull();
  });

  it("answers the status as JSON for an Accept of application/json, and as a page otherwise", async () => {
    const { w, a, open } = await world();
    const s = await open(a);
    await send(w, "/sso/setup/connection", OIDC, s.cookie);
    const get = (accept?: string) =>
      w.handle(
        new Request(`${BASE_URL}/auth/sso/setup/status`, {
          headers: { ...CLIENT, cookie: s.cookie, ...(accept ? { accept } : {}) },
        }),
      );
    const page = await get();
    expect(page.headers.get("content-type")).toContain("text/html");
    const res = await get("application/json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      link: { id: string };
      connection: { label: string } | null;
      domains: unknown[];
      scimToken: unknown;
      test: unknown;
    };
    expect(body.link.id).toBe(s.linkId);
    expect(body.connection?.label).toBe("Acme Okta");
    expect(body.domains).toEqual([]);
    expect(body.scimToken).toBeNull();
    expect(body.test).toBeNull();
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("answers a test result in the JSON status for a run of the link, and not_found for another link", async () => {
    const { w, a, b, open } = await world();
    const s = await open(a);
    const t = await open(b);
    const [, conn] = await send(w, "/sso/setup/connection", OIDC, s.cookie);
    const connId = (conn.connection as { id: string }).id;
    const now = w.clock.now();
    const run = await w.storage.create("ssoTestRun", {
      id: newId(now),
      createdAt: now,
      updatedAt: now,
      organizationId: a.org,
      connectionId: connId,
      linkId: s.linkId,
      outcome: "passed",
      step: null,
      attributeNames: ["email"],
      domainClaimed: false,
      draftVersion: 1,
    });
    const status = async (cookie: string) => {
      const res = await w.handle(
        new Request(`${BASE_URL}/auth/sso/setup/status?run=${run.id}`, {
          headers: { ...CLIENT, cookie, accept: "application/json" },
        }),
      );
      return [
        res.status,
        (await res.json()) as { test: { outcome: string; current: boolean } | null },
      ] as const;
    };
    const [own, ownBody] = await status(s.cookie);
    expect([own, ownBody.test?.outcome, ownBody.test?.current]).toEqual([200, "passed", true]);
    const [other, otherBody] = await status(t.cookie);
    expect([other, otherBody.test]).toEqual([200, null]);
  });

  it("holds a session of link A to its own organization: it cannot touch org B", async () => {
    const { w, a, b, open } = await world();
    const s = await open(a);
    const other = await open(b);
    const [, added] = await send(
      w,
      "/sso/setup/domains/add",
      { domain: "beta.example" },
      other.cookie,
    );
    const bDomain = (added.domain as { id: string }).id;
    const before = await w.storage.findMany("ssoDomain", []);
    expect(await send(w, "/sso/setup/domains/verify", { id: bDomain }, s.cookie)).toEqual(NONE);
    expect(await w.storage.findMany("ssoDomain", [])).toEqual(before);
    // Its own draft lands in org A only.
    await send(w, "/sso/setup/connection", OIDC, s.cookie);
    const drafts = await w.storage.findMany("ssoConnection", []);
    expect(drafts.map((d) => d.organizationId)).toEqual([a.org]);
  });

  it("answers domain_unverified to a verify with no record, and domain_taken to a second organization", async () => {
    const { w, a, b, open } = await world();
    const s = await open(a);
    const t = await open(b);
    const add = async (cookie: string) => {
      const [, answer] = await send(
        w,
        "/sso/setup/domains/add",
        { domain: "shared.example" },
        cookie,
      );
      return answer.domain as { id: string; record: { name: string; value: string } };
    };
    const first = await add(s.cookie);
    const second = await add(t.cookie);
    const [us, unverified] = await send(w, "/sso/setup/domains/verify", { id: first.id }, s.cookie);
    expect([us, unverified.error]).toEqual([400, "domain_unverified"]);
    w.answers.a[first.record.name] = [first.record.value, second.record.value];
    w.answers.b[first.record.name] = [first.record.value, second.record.value];
    const [vs] = await send(w, "/sso/setup/domains/verify", { id: first.id }, s.cookie);
    expect(vs).toBe(200);
    const [ts, taken] = await send(w, "/sso/setup/domains/verify", { id: second.id }, t.cookie);
    expect([ts, taken.error]).toEqual([409, "domain_taken"]);
  });

  it("answers 400 token_expired to a verify of a pending domain past its life, and 429 past the draft limit", async () => {
    const { w, a, open } = await world();
    const s = await open(a);
    const [, added] = await send(w, "/sso/setup/domains/add", { domain: "late.example" }, s.cookie);
    const id = (added.domain as { id: string }).id;
    await w.storage.update("ssoDomain", [{ field: "id", op: "eq", value: id }], {
      expiresAt: new Date(w.clock.now().getTime() - 1000),
    });
    expect(await send(w, "/sso/setup/domains/verify", { id }, s.cookie)).toEqual([
      400,
      { error: "token_expired" },
    ]);
    // The gate counts each write of the link: 60 an hour, and the next answers 429.
    let last = 0;
    for (let i = 0; i < 60; i += 1)
      last = (await send(w, "/sso/setup/scim-token", {}, s.cookie, "{}"))[0];
    expect(last).toBe(429);
  });

  it("answers 401 for a step that the link does not hold", async () => {
    const { w, a, open } = await world();
    const s = await open(a, ["domain"]);
    expect(await send(w, "/sso/setup/connection", OIDC, s.cookie)).toEqual(NONE);
    expect(await send(w, "/sso/setup/scim-token", {}, s.cookie, "")).toEqual(NONE);
  });
});
