import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/create-auth.js";
import { createOrganization, deleteOrganization } from "../../src/engine/organizations.js";
import { createScimToken, listScimTokens, revokeScimToken } from "../../src/engine/scim/tokens.js";
import { sessionFromRequest } from "../../src/engine/sessions.js";
import { authenticateRequest, callerFromRequest } from "../../src/engine/tokens.js";
import { createRouter, type Route } from "../../src/http/router.js";
import { scimJson, scimRoute } from "../../src/http/routes/scim.js";
import { createMemoryAdapter } from "../../src/storage/memory.js";
import { BASE_URL } from "../helpers.js";
import { verifiedSession } from "../totp-helpers.js";
import { SCIM_APP, SCIM_IP, type ScimWorld, scim, scimAuth, scimToken } from "./helpers.js";

beforeEach(() => {
  // A refused guard writes one log line; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ERROR_URN = "urn:ietf:params:scim:api:messages:2.0:Error";
const DAY_MS = 86_400_000;

/** The SHA-256 hex of a text, by Web Crypto in the test, not by the code under test. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A manager route call with the owner's session cookie: its status and body. */
async function manage(
  w: ScimWorld,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  token: string = w.owner.token,
): Promise<[number, Record<string, unknown>]> {
  const headers: Record<string, string> = {
    "cf-connecting-ip": SCIM_IP,
    "user-agent": "manager/1",
    cookie: `__Host-tempo_session=${token}`,
  };
  const res = await w.handle(
    method === "GET"
      ? new Request(`${BASE_URL}/auth${path}`, { headers })
      : new Request(`${BASE_URL}/auth${path}`, {
          method,
          headers: { ...headers, "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify(body),
        }),
  );
  return [res.status, (await res.json()) as Record<string, unknown>];
}

/** A router over one test route of `scimRoute`, with `seen` holding each body that reached it. */
function probeRoutes(w: ScimWorld) {
  const seen: unknown[] = [];
  const routes: Route[] = [
    scimRoute(w.config, {
      method: "POST",
      path: "/scim/v2/Probe",
      // A test stub of a path outside ROUTES has no key (ruling 3 of plan 12d).
      key: undefined as never,
      scope: "scim.users.write",
      body: true,
      async handle(_ctx, caller, body) {
        seen.push(body);
        return scimJson({ organizationId: caller.organizationId }, 201);
      },
    }),
    scimRoute(w.config, {
      method: "GET",
      path: "/scim/v2/Probe",
      key: undefined as never,
      scope: "scim.users.read",
      body: false,
      async handle(_ctx, caller) {
        return scimJson({ organizationId: caller.organizationId });
      },
    }),
  ];
  return { seen, handle: createRouter(w.config, routes) };
}

describe("the SCIM tokens (plan 12d Task 9)", () => {
  it("answers the token once and stores its hash", async () => {
    const w = await scimAuth();
    const made = await createScimToken(w.config, SCIM_APP, {
      organizationId: w.org,
      name: "Entra ID",
    });
    if (!made.ok) throw new Error(made.code);
    const { token, id, hint } = made.value;
    expect(token).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    expect(hint).toBe(token.slice(3, 11));
    const row = await w.storage.findOne("scimToken", [{ field: "id", op: "eq", value: id }]);
    expect(row?.tokenHash).toBe(await sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row?.scopes).toEqual([
      "scim.users.read",
      "scim.users.write",
      "scim.groups.read",
      "scim.groups.write",
    ]);
    const listed = await listScimTokens(w.config, SCIM_APP, { organizationId: w.org });
    expect(listed).toEqual({
      ok: true,
      value: [
        {
          id,
          name: "Entra ID",
          hint,
          scopes: ["scim.users.read", "scim.users.write", "scim.groups.read", "scim.groups.write"],
          createdAt: "2026-01-01T00:00:30.000Z",
          lastUsedAt: null,
          expiresAt: null,
        },
      ],
    });
    // No audit row holds the token or its hash.
    const audit = await w.storage.findMany("operatorAudit", [
      { field: "action", op: "eq", value: "scim_token_create" },
    ]);
    expect(audit.map((a) => [a.actorKind, a.actorId, a.data])).toEqual([
      [
        "app",
        "scim-test",
        {
          organizationId: w.org,
          tokenId: id,
          name: "Entra ID",
          scopes: ["scim.users.read", "scim.users.write", "scim.groups.read", "scim.groups.write"],
        },
      ],
    ]);
    const all = JSON.stringify(await w.storage.findMany("operatorAudit", []));
    expect(all).not.toContain(token);
    expect(all).not.toContain(await sha256(token));
  });

  it("keeps at most two live tokens", async () => {
    const w = await scimAuth();
    const create = (expiresInDays?: number) =>
      createScimToken(w.config, SCIM_APP, {
        organizationId: w.org,
        name: "directory",
        ...(expiresInDays === undefined ? {} : { expiresInDays }),
      });
    const short = await create(1);
    const second = await create();
    if (!short.ok || !second.ok) throw new Error("no token");
    expect(await create()).toMatchObject({ ok: false, code: "token_limit", status: 409 });
    // Two days on, the short token is expired and does not count.
    w.clock.advance(2 * DAY_MS);
    const third = await create();
    expect(third.ok).toBe(true);
    expect(await create()).toMatchObject({ ok: false, code: "token_limit" });
    expect(await revokeScimToken(w.config, SCIM_APP, { id: second.value.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect((await create()).ok).toBe(true);
    expect(await w.storage.findMany("scimToken", [])).toHaveLength(3);
  });

  it("refuses a wrong, an expired, and a revoked token with 401 and the SCIM shape", async () => {
    const w = await scimAuth();
    const expired = await createScimToken(w.config, SCIM_APP, {
      organizationId: w.org,
      name: "short",
      expiresInDays: 1,
    });
    const revoked = await scimToken(w);
    if (!expired.ok) throw new Error(expired.code);
    expect((await scim(w, expired.value.token, "GET", "/ServiceProviderConfig")).status).toBe(200);
    w.clock.advance(DAY_MS);
    expect((await revokeScimToken(w.config, SCIM_APP, { id: revoked.id })).ok).toBe(true);
    const wrong = `sk_${"A".repeat(43)}`;
    const cases: [string | null, Record<string, string>][] = [
      [wrong, {}],
      [expired.value.token, {}],
      [revoked.token, {}],
      [null, {}],
      // The scheme needs one space, and the token its form.
      [null, { authorization: `Bearer  ${revoked.token}` }],
      [`${wrong}x`, {}],
    ];
    for (const [token, headers] of cases) {
      const res = await scim(w, token, "GET", "/ServiceProviderConfig", undefined, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="scim"');
      expect(res.headers.get("content-type")).toBe("application/scim+json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        schemas: [ERROR_URN],
        status: "401",
        detail: "the request needs a valid SCIM token as its bearer",
      });
    }
  });

  it("counts failures, not calls, on the IP key", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w);
    const bad = `sk_${"B".repeat(43)}`;
    for (let i = 1; i <= 60; i++)
      expect((await scim(w, bad, "GET", "/ServiceProviderConfig")).status, `call ${i}`).toBe(401);
    const refused = await scim(w, bad, "GET", "/ServiceProviderConfig");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      schemas: [ERROR_URN],
      status: "429",
      detail: "too many requests; try again later",
    });
    for (let i = 1; i <= 100; i++)
      expect((await scim(w, token, "GET", "/ServiceProviderConfig")).status, `good ${i}`).toBe(200);
  });

  it("counts the calls of one token on its own key", async () => {
    const w = await scimAuth();
    const { token, id } = await scimToken(w);
    const allow = vi.spyOn(w.config.limiter, "allow");
    expect((await scim(w, token, "GET", "/ServiceProviderConfig")).status).toBe(200);
    expect(allow.mock.calls).toEqual([[`scim:token:${id}`, { seconds: 600, max: 1200 }]]);
    allow.mockResolvedValueOnce(false);
    const res = await scim(w, token, "GET", "/ServiceProviderConfig");
    expect([res.status, await res.json()]).toEqual([
      429,
      { schemas: [ERROR_URN], status: "429", detail: "too many requests; try again later" },
    ]);
  });

  it("refuses a write with a read scope", async () => {
    const w = await scimAuth();
    const read = await scimToken(w, ["scim.users.read"]);
    const probe = probeRoutes(w);
    const post = await scim(probe, read.token, "POST", "/Probe", { userName: "a@acme.example" });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({
      schemas: [ERROR_URN],
      status: "403",
      detail: "the token does not hold the scope scim.users.write",
    });
    expect(probe.seen).toEqual([]);
    const get = await scim(probe, read.token, "GET", "/Probe");
    expect([get.status, await get.json()]).toEqual([200, { organizationId: w.org }]);
    const write = await scimToken(w, ["scim.users.write"]);
    expect((await scim(probe, write.token, "GET", "/Probe")).status).toBe(403);
    expect((await scim(probe, write.token, "POST", "/Probe", { a: 1 })).status).toBe(201);
    expect(probe.seen).toEqual([{ a: 1 }]);
  });

  it("moves lastUsedAt at most once a minute", async () => {
    const w = await scimAuth();
    const { token, id } = await scimToken(w);
    const update = vi.spyOn(w.storage, "update");
    const writes = () => update.mock.calls.filter(([model]) => model === "scimToken").length;
    const lastUsed = async () =>
      (await w.storage.findOne("scimToken", [{ field: "id", op: "eq", value: id }]))?.lastUsedAt;
    await scim(w, token, "GET", "/ServiceProviderConfig");
    const first = w.clock.now();
    w.clock.advance(59_000);
    await scim(w, token, "GET", "/ServiceProviderConfig");
    expect(writes()).toBe(1);
    expect(await lastUsed()).toEqual(first);
    w.clock.advance(1_000);
    await scim(w, token, "GET", "/ServiceProviderConfig");
    expect(writes()).toBe(2);
    expect(await lastUsed()).toEqual(w.clock.now());
  });

  it("refuses a SCIM token at the caller reads of the app (auth.caller, auth.authenticate, auth.session)", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w);
    // The owner of the organization holds a live session, so a read that took the token would find one.
    const request = new Request(`${BASE_URL}/api/notes`, {
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": SCIM_IP },
    });
    expect(await authenticateRequest(w.config, request)).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    expect(await callerFromRequest(w.config, request)).toBeNull();
    expect(await sessionFromRequest(w.config, request)).toBeNull();
  });

  it("deletes the tokens with the organization and with the account (ruling 30)", async () => {
    const w = await scimAuth();
    await scimToken(w);
    const owner = w.owner.user;
    expect((await deleteOrganization(w.config, { user: owner, organizationId: w.org })).ok).toBe(
      true,
    );
    expect(await w.storage.findMany("scimToken", [])).toEqual([]);
    // A user who alone holds an organization deletes the account: the organization goes with its tokens.
    const ada = await verifiedSession(w, "ada@example.com");
    const solo = await createOrganization(w.config, { user: ada.user, slug: "solo", name: "Solo" });
    if (!solo.ok) throw new Error(solo.code);
    await scimToken(w, undefined, solo.value.organization.id);
    expect(await w.storage.findMany("scimToken", [])).toHaveLength(1);
    const res = await w.handle(
      new Request(`${BASE_URL}/auth/user/delete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          cookie: `__Host-tempo_session=${ada.token}`,
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(await w.storage.findMany("scimToken", [])).toEqual([]);
  });

  it("serves the token routes to the owner, with an audit row per write", async () => {
    const w = await scimAuth();
    const list = `/scim/tokens?organizationId=${w.org}`;
    expect(await manage(w, "GET", list, null)).toEqual([200, { tokens: [] }]);
    const [status, created] = await manage(w, "POST", "/scim/tokens/create", {
      organizationId: w.org,
      name: "Okta",
      scopes: ["scim.users.read", "scim.users.write"],
      expiresInDays: 730,
    });
    expect(status).toBe(200);
    expect(Object.keys(created).sort()).toEqual(["hint", "id", "token"]);
    const token = created.token as string;
    const [, listed] = await manage(w, "GET", list, null);
    expect(listed).toEqual({
      tokens: [
        {
          id: created.id,
          name: "Okta",
          hint: token.slice(3, 11),
          scopes: ["scim.users.read", "scim.users.write"],
          createdAt: w.clock.now().toISOString(),
          lastUsedAt: null,
          expiresAt: new Date(w.clock.now().getTime() + 730 * DAY_MS).toISOString(),
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain(token);
    expect((await scim(w, token, "GET", "/Schemas")).status).toBe(200);
    expect(await manage(w, "POST", "/scim/tokens/revoke", { id: created.id })).toEqual([
      200,
      { ok: true },
    ]);
    expect((await scim(w, token, "GET", "/Schemas")).status).toBe(401);
    const audit = await w.storage.findMany("operatorAudit", [], {
      sort: { field: "id", dir: "asc" },
    });
    expect(
      audit
        .filter((a) => a.action.startsWith("scim_token"))
        .map((a) => [a.action, a.actorKind, a.actorId, a.ip, a.userAgent, a.data]),
    ).toEqual([
      [
        "scim_token_create",
        "user",
        w.owner.user.id,
        SCIM_IP,
        "manager/1",
        {
          organizationId: w.org,
          tokenId: created.id,
          name: "Okta",
          scopes: ["scim.users.read", "scim.users.write"],
        },
      ],
      [
        "scim_token_revoke",
        "user",
        w.owner.user.id,
        SCIM_IP,
        "manager/1",
        { organizationId: w.org, tokenId: created.id, name: "Okta" },
      ],
    ]);
    // A revoke of an id that names no token, and a person who owns no organization.
    expect(await manage(w, "POST", "/scim/tokens/revoke", { id: created.id })).toEqual([
      404,
      { error: "not_found" },
    ]);
    const ada = await verifiedSession(w, "ada@example.com");
    expect(await manage(w, "GET", list, null, ada.token)).toEqual([
      403,
      { error: "forbidden_rank" },
    ]);
  });

  it("refuses a name, scopes, or a life outside the rules", async () => {
    const w = await scimAuth();
    const rows: [Record<string, unknown>, string][] = [
      [{ name: "" }, "name must be 1 to 64 characters with no control character"],
      [{ name: "x".repeat(65) }, "name must be 1 to 64 characters with no control character"],
      [{ name: "a\u0007b" }, "name must be 1 to 64 characters with no control character"],
      [{ scopes: [] }, "scopes"],
      [{ scopes: ["scim.users.read", "scim.users.read"] }, "scopes"],
      [{ scopes: ["scim.users.delete"] }, "scopes"],
      [{ expiresInDays: 0 }, "expiresInDays must be an integer from 1 to 730"],
      [{ expiresInDays: 731 }, "expiresInDays must be an integer from 1 to 730"],
      [{ expiresInDays: 1.5 }, "expiresInDays must be an integer from 1 to 730"],
    ];
    for (const [fields, message] of rows) {
      const r = await createScimToken(w.config, SCIM_APP, {
        organizationId: w.org,
        name: "directory",
        ...fields,
      } as never);
      expect(r, JSON.stringify(fields)).toMatchObject({ ok: false, code: "invalid_body" });
      expect(r.ok ? "" : r.message).toContain(message);
    }
    expect(await w.storage.findMany("scimToken", [])).toEqual([]);
    expect(
      await createScimToken(w.config, SCIM_APP, { organizationId: "nothing", name: "directory" }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("serves api.scim.tokens with the app as the actor", async () => {
    const storage = createMemoryAdapter();
    const auth = createAuth({ ...baseOf(storage), organizations: {}, scim: {} });
    const now = new Date();
    // A verified user, as makeAuth seeds one; the organization comes from the api.
    const user = await storage.create("user", {
      id: "u1",
      email: "boss@acme.example",
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      createdAt: now,
      updatedAt: now,
    });
    const org = await auth.api.createOrganization({ user, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    const organizationId = org.value.organization.id;
    const api = auth.api.scim;
    if (!api) throw new Error("no api.scim");
    const made = await api.tokens.create({ actor: SCIM_APP, organizationId, name: "app" });
    if (!made.ok) throw new Error(made.code);
    const listed = await api.tokens.list({ actor: SCIM_APP, organizationId });
    expect(listed.ok && listed.value.map((t) => t.id)).toEqual([made.value.id]);
    expect(
      await api.tokens.create({
        actor: { kind: "app", name: "Bad Name" },
        organizationId,
        name: "x",
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await api.tokens.revoke({ actor: SCIM_APP, id: made.value.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(createAuth({ ...baseOf(storage), organizations: {} }).api.scim).toBeUndefined();
  });
});

/** The keys of a minimal config over `storage`. */
function baseOf(storage: ReturnType<typeof createMemoryAdapter>) {
  return {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    mail: { send: async () => {} },
  };
}
