import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { publicKeySet } from "../src/engine/jwt.js";
import { decodeJws, tokenHashClaim } from "../src/primitives/jwk.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { BASE_URL, get } from "./helpers.js";
import {
  codeFor,
  exchange,
  ISSUER,
  OTHER_RESOURCE,
  oauthHandle,
  pkce,
  REDIRECT,
  RESOURCE,
  registered,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";

type Tokens = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
  id_token?: string;
};

async function tokens(res: Response): Promise<Tokens> {
  if (res.status !== 200) throw new Error(`token answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as Tokens;
}

const refreshWith = (refreshToken: string, clientId: string, extra: Record<string, string> = {}) =>
  tokenPost({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    ...extra,
  });
const answer = async (res: Response) => ({ status: res.status, body: await res.json() });
const GRANT = { status: 400, body: { error: "invalid_grant" } };

/**
 * A handle whose storage can hold an `oauthToken` create, update, or delete
 * until a promise settles, so a test picks the order of two parallel
 * refreshes. `bothRead` settles at the second `oauthToken` read. A hold also
 * ends after 500 ms, so a run where the held event never comes does not hang.
 */
function gatedHandle() {
  const outer = oauthHandle();
  const holds: Record<"create" | "update" | "delete", Promise<unknown> | null> = {
    create: null,
    update: null,
    delete: null,
  };
  let reads = 0;
  let read = () => {};
  const bothRead = new Promise<void>((r) => {
    read = r;
  });
  let deleted = () => {};
  const firstDelete = new Promise<void>((r) => {
    deleted = r;
  });
  const wait = (p: Promise<unknown> | null) =>
    p ? Promise.race([p, new Promise((r) => setTimeout(r, 500))]) : Promise.resolve();
  const base = outer.storage;
  const storage = new Proxy(base, {
    get(target, key, receiver) {
      if (key === "findOne")
        return async (model: string, ...args: unknown[]) => {
          const out = await (base.findOne as (...a: unknown[]) => Promise<unknown>)(model, ...args);
          if (model === "oauthToken" && holds.update && ++reads === 2) read();
          return out;
        };
      if (key === "create" || key === "update" || key === "delete")
        return async (model: string, ...args: unknown[]) => {
          if (model === "oauthToken") await wait(holds[key]);
          const fn = Reflect.get(target, key, receiver) as (...a: unknown[]) => Promise<unknown>;
          const out = await fn.call(target, model, ...args);
          if (key === "delete" && model === "oauthToken") deleted();
          return out;
        };
      return Reflect.get(target, key, receiver);
    },
  }) as StorageAdapter;
  const inner = oauthHandle({ storage, clock: outer.clock });
  return { ...inner, storage: base, clock: outer.clock, holds, firstDelete, bothRead };
}

/**
 * Two parallel refreshes of one refresh token. Both read the unspent row
 * before either spends it, so the loser's spend matches zero rows. `order`
 * picks which comes first: the winner's write or the loser's delete.
 */
async function parallelRefresh(order: "write-first" | "delete-first" | "free") {
  const h = gatedHandle();
  const c = await codeFor(h);
  const rt =
    (await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)))).refresh_token ??
    "";
  h.holds.update = h.bothRead;
  const a = h.auth.handle(refreshWith(rt, c.clientId));
  const b = h.auth.handle(refreshWith(rt, c.clientId));
  if (order === "write-first") h.holds.delete = Promise.race([a, b]);
  if (order === "delete-first") h.holds.create = h.firstDelete;
  const results = await Promise.all([a, b].map(async (p) => answer(await p)));
  return { h, statuses: results.map((r) => r.status).sort(), results };
}

describe("the code exchange (plan 9g)", () => {
  it("exchanges a code for an access JWT with aud, scope, client_id, and sub, and a refresh token; no ID token without openid", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const res = await h.auth.handle(exchange(c.code, c.clientId, c.verifier));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const t = await tokens(res);
    expect(t).toMatchObject({
      token_type: "Bearer",
      expires_in: 900,
      scope: "mcp:read offline_access",
    });
    expect(t.refresh_token).toMatch(/^or_[A-Za-z0-9_-]{43}$/);
    expect(t.id_token).toBeUndefined();
    const { payload, protectedHeader } = await jwtVerify(
      t.access_token,
      createLocalJWKSet(await publicKeySet(h.config)),
      { issuer: ISSUER, audience: RESOURCE, currentDate: h.clock.now(), typ: "at+jwt" },
    );
    expect(protectedHeader.typ).toBe("at+jwt");
    expect(payload).toMatchObject({
      sub: c.user.id,
      client_id: c.clientId,
      scope: "mcp:read offline_access",
      aud: RESOURCE,
    });
    expect(typeof payload.jti).toBe("string");
    const rows = await h.storage.findMany("oauthToken", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: c.user.id,
      clientId: c.clientId,
      resource: RESOURCE,
      usedAt: null,
      expiresAt: new Date(h.clock.now().getTime() + 30 * 86_400_000),
    });
    expect(JSON.stringify(rows)).not.toContain(t.refresh_token);
  });

  it("answers invalid_grant for a wrong verifier, a wrong redirect URI, and a second exchange after each; each attempt spends the code", async () => {
    for (const extra of [
      { code_verifier: (await pkce()).verifier },
      { code_verifier: "short" },
      { redirect_uri: `${REDIRECT}/other` },
    ]) {
      const h = oauthHandle();
      const c = await codeFor(h);
      expect(
        await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier, extra))),
      ).toEqual(GRANT);
      expect(await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)))).toEqual(
        GRANT,
      );
    }
  });

  it("a reused code answers invalid_grant and deletes the family the first exchange gave (OAuth 2.1 section 4.1.3)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const first = await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)));
    expect(await h.storage.findMany("oauthToken", [])).toHaveLength(1);
    expect(await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)))).toEqual(
      GRANT,
    );
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
    expect(
      await answer(await h.auth.handle(refreshWith(first.refresh_token ?? "", c.clientId))),
    ).toEqual(GRANT);
  });

  it("answers invalid_grant for the right verifier with another client id, and the code is spent (Review Focus 1)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const other = await registered(h, [REDIRECT], "Other client");
    expect(await answer(await h.auth.handle(exchange(c.code, other, c.verifier)))).toEqual(GRANT);
    expect(await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)))).toEqual(
      GRANT,
    );
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
  });

  it("answers invalid_client for an unknown client, which spends nothing, and invalid_target for another resource, which does", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    expect(
      await answer(await h.auth.handle(exchange(c.code, `cl_${"B".repeat(43)}`, c.verifier))),
    ).toEqual({ status: 400, body: { error: "invalid_client" } });
    expect(
      await answer(
        await h.auth.handle(exchange(c.code, c.clientId, c.verifier, { resource: OTHER_RESOURCE })),
      ),
    ).toEqual({ status: 400, body: { error: "invalid_target" } });
    expect(await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)))).toEqual(
      GRANT,
    );
  });

  it("answers invalid_grant for a code 5 minutes old", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    h.clock.advance(5 * 60_000);
    expect(await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)))).toEqual(
      GRANT,
    );
  });

  it("adds an ID token with openid: the claims by scope, the nonce, sid, and at_hash of the access token", async () => {
    const h = oauthHandle();
    const c = await codeFor(h, "openid email profile mcp:read", { nonce: "n-123" });
    const t = await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)));
    expect(t.refresh_token).toBeUndefined();
    const { payload, protectedHeader } = await jwtVerify(
      t.id_token ?? "",
      createLocalJWKSet(await publicKeySet(h.config)),
      { issuer: ISSUER, audience: c.clientId, currentDate: h.clock.now() },
    );
    expect(protectedHeader.typ).toBe("JWT");
    expect(payload).toMatchObject({
      sub: c.user.id,
      nonce: "n-123",
      sid: c.session.id,
      email: "ada@example.com",
      email_verified: true,
      name: "Ada Lovelace",
      picture: "https://img.example.com/ada.png",
      at_hash: await tokenHashClaim("EdDSA", t.access_token),
    });
    const narrow = oauthHandle();
    const d = await codeFor(narrow, "openid mcp:read");
    const n = await tokens(await narrow.auth.handle(exchange(d.code, d.clientId, d.verifier)));
    expect(Object.keys(decodeJws(n.id_token ?? "")?.payload ?? {}).sort()).toEqual([
      "at_hash",
      "aud",
      "exp",
      "iat",
      "iss",
      "sid",
      "sub",
    ]);
  });
});

describe("the refresh token (plan 9g)", () => {
  it("rotates: the old row is used, the new one joins the family, and the access token is new", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const first = await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)));
    h.clock.advance(60_000);
    const second = await tokens(
      await h.auth.handle(refreshWith(first.refresh_token ?? "", c.clientId)),
    );
    expect(second.refresh_token).toMatch(/^or_/);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.id_token).toBeUndefined();
    const rows = await h.storage.findMany("oauthToken", [], {
      sort: [
        { field: "createdAt", dir: "asc" },
        { field: "id", dir: "asc" },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.usedAt).toEqual(h.clock.now());
    expect(rows[1]).toMatchObject({ familyId: rows[0]?.familyId, usedAt: null });
  });

  it("a refresh token used twice revokes the family, and the third use answers invalid_grant (Review Focus 2)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const first = await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)));
    const second = await tokens(
      await h.auth.handle(refreshWith(first.refresh_token ?? "", c.clientId)),
    );
    expect(
      await answer(await h.auth.handle(refreshWith(first.refresh_token ?? "", c.clientId))),
    ).toEqual(GRANT);
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
    expect(
      await answer(await h.auth.handle(refreshWith(second.refresh_token ?? "", c.clientId))),
    ).toEqual(GRANT);
  });

  it("two parallel refreshes of one token: at most one answers 200, and the family ends with no live row in each order", async () => {
    const writeFirst = await parallelRefresh("write-first");
    expect(writeFirst.statuses).toEqual([200, 400]);
    expect(writeFirst.results.filter((r) => r.status === 400).map((r) => r.body)).toEqual([
      GRANT.body,
    ]);
    expect(await writeFirst.h.storage.findMany("oauthToken", [])).toEqual([]);
    const deleteFirst = await parallelRefresh("delete-first");
    expect(deleteFirst.results).toEqual([GRANT, GRANT]);
    expect(await deleteFirst.h.storage.findMany("oauthToken", [])).toEqual([]);
    const free = await parallelRefresh("free");
    expect(free.statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    expect(free.statuses).toContain(400);
    expect(await free.h.storage.findMany("oauthToken", [])).toEqual([]);
  });

  it("refuses another client, a scope beyond the grant, and another resource without spending; a narrower scope answers that scope; an expired token answers invalid_grant", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const rt =
      (await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)))).refresh_token ??
      "";
    const other = await registered(h, [REDIRECT], "Other");
    expect(await answer(await h.auth.handle(refreshWith(rt, other)))).toEqual(GRANT);
    expect(
      await answer(
        await h.auth.handle(refreshWith(rt, c.clientId, { scope: "mcp:read mcp:write" })),
      ),
    ).toEqual({ status: 400, body: { error: "invalid_scope" } });
    expect(
      await answer(await h.auth.handle(refreshWith(rt, c.clientId, { resource: OTHER_RESOURCE }))),
    ).toEqual({ status: 400, body: { error: "invalid_target" } });
    const narrow = await tokens(
      await h.auth.handle(refreshWith(rt, c.clientId, { scope: "mcp:read" })),
    );
    expect(narrow.scope).toBe("mcp:read");
    expect(narrow.refresh_token).toMatch(/^or_/);
    h.clock.advance(31 * 86_400_000);
    expect(
      await answer(await h.auth.handle(refreshWith(narrow.refresh_token ?? "", c.clientId))),
    ).toEqual(GRANT);
  });

  it("revoke deletes the family; another client's id answers unauthorized_client and an unknown id invalid_client, and neither revokes (RFC 7009 section 2.1, Review Focus 4)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const other = await registered(h);
    const t = await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)));
    const revoke = (body: Record<string, string>) =>
      h.auth.handle(
        new Request(`${BASE_URL}/auth/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(body).toString(),
        }),
      );
    for (const body of [{ token: "or_unknown" }, { token: t.access_token }]) {
      const res = await revoke(body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    }
    // A registered client did not get this token. An unknown id fails the client auth (plan 12e).
    const byOther = await revoke({ token: t.refresh_token ?? "", client_id: other });
    expect(await answer(byOther)).toEqual({ status: 400, body: { error: "unauthorized_client" } });
    const byUnknown = await revoke({ token: t.refresh_token ?? "", client_id: "cl_other" });
    // No Authorization header: invalid_client is a 400 (plan 12e, ruling 19).
    expect(await answer(byUnknown)).toEqual({ status: 400, body: { error: "invalid_client" } });
    expect(await h.storage.findMany("oauthToken", [])).toHaveLength(1);
    expect((await revoke({ token: t.refresh_token ?? "", client_id: c.clientId })).status).toBe(
      200,
    );
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
    expect(
      await answer(await h.auth.handle(refreshWith(t.refresh_token ?? "", c.clientId))),
    ).toEqual(GRANT);
  });
});

describe("the scopes of a user access token (ruling 29 of plan 12e)", () => {
  it("refuses a user token with a scope that the config no longer names, on a second instance", async () => {
    const h = oauthHandle();
    const c = await codeFor(h, "openid mcp:read mcp:write");
    const t = await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)));
    const atResource = () =>
      new Request(`${RESOURCE}/tools`, { headers: { authorization: `Bearer ${t.access_token}` } });
    expect(await h.auth.caller(atResource())).toMatchObject({ kind: "oauth" });
    // A deploy that drops mcp:write: the second instance names mcp:read only.
    const other = oauthHandle({
      storage: h.storage,
      clock: h.clock,
      oauth: {
        resources: [RESOURCE, OTHER_RESOURCE],
        scopes: { "mcp:read": "Read your documents" },
        registration: { cimd: false },
      },
    });
    expect(await other.auth.caller(atResource())).toBeNull();
    const info = await other.auth.handle(
      get("/auth/oauth/userinfo", { authorization: `Bearer ${t.access_token}` }),
    );
    expect(info.status).toBe(401);
    // The first instance still names mcp:write, so the token still passes there.
    expect(await h.auth.caller(atResource())).toMatchObject({ kind: "oauth" });
  });
});

describe("the refresh of a grant whose scope the config drops (ruling 30 of plan 12e)", () => {
  /** A second instance on the storage and clock of `h` whose config names `mcp:read` only. */
  const readOnly = (h: ReturnType<typeof oauthHandle>) =>
    oauthHandle({
      storage: h.storage,
      clock: h.clock,
      oauth: {
        resources: [RESOURCE, OTHER_RESOURCE],
        scopes: { "mcp:read": "Read your documents" },
        registration: { cimd: false },
      },
    });

  it("keeps only the served scopes of the grant, and the new access token passes", async () => {
    const h = oauthHandle();
    const c = await codeFor(h, "mcp:read mcp:write offline_access");
    const t = await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)));
    const other = readOnly(h);
    const next = await tokens(
      await other.auth.handle(refreshWith(t.refresh_token ?? "", c.clientId)),
    );
    expect(next.scope).toBe("mcp:read offline_access");
    const caller = await other.auth.caller(
      new Request(`${RESOURCE}/tools`, {
        headers: { authorization: `Bearer ${next.access_token}` },
      }),
    );
    expect(caller).toMatchObject({ kind: "oauth", scopes: ["mcp:read", "offline_access"] });
    // A narrower scope must be a served scope of the grant.
    const again = await other.auth.handle(
      refreshWith(next.refresh_token ?? "", c.clientId, { scope: "mcp:write" }),
    );
    expect(await answer(again)).toEqual({ status: 400, body: { error: "invalid_scope" } });
  });

  it("answers invalid_grant when no served scope but offline_access is left, and spends nothing", async () => {
    const h = oauthHandle();
    const c = await codeFor(h, "mcp:write offline_access");
    const t = await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)));
    const refresh = t.refresh_token ?? "";
    expect(await answer(await readOnly(h).auth.handle(refreshWith(refresh, c.clientId)))).toEqual(
      GRANT,
    );
    // The token is not spent: an instance that still names mcp:write refreshes it.
    const back = await tokens(await h.auth.handle(refreshWith(refresh, c.clientId)));
    expect(back.scope).toBe("mcp:write offline_access");
  });
});

describe("userinfo and the endpoint's edges (plan 9g)", () => {
  it("answers the claims by scope on GET and POST; 401 for no token, a changed token, an expired one, and an ID token; 403 without openid", async () => {
    const h = oauthHandle();
    const c = await codeFor(h, "openid email mcp:read");
    const t = await tokens(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)));
    const bearer = { authorization: `Bearer ${t.access_token}` };
    expect(await (await h.auth.handle(get("/auth/oauth/userinfo", bearer))).json()).toEqual({
      sub: c.user.id,
      email: "ada@example.com",
      email_verified: true,
    });
    const viaPost = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/userinfo`, { method: "POST", headers: bearer }),
    );
    expect(viaPost.status).toBe(200);
    const none = await h.auth.handle(get("/auth/oauth/userinfo"));
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    for (const token of [`${t.access_token}x`, t.id_token ?? ""])
      expect(
        (await h.auth.handle(get("/auth/oauth/userinfo", { authorization: `Bearer ${token}` })))
          .status,
      ).toBe(401);
    h.clock.advance(15 * 60_000);
    expect((await h.auth.handle(get("/auth/oauth/userinfo", bearer))).status).toBe(401);
    const plain = oauthHandle();
    const d = await codeFor(plain, "mcp:read");
    const u = await tokens(await plain.auth.handle(exchange(d.code, d.clientId, d.verifier)));
    const res = await plain.auth.handle(
      get("/auth/oauth/userinfo", { authorization: `Bearer ${u.access_token}` }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "insufficient_scope" });
  });

  it("POST /oauth/userinfo answers insufficient_scope as the GET does (plan 11g)", async () => {
    const plain = oauthHandle();
    const d = await codeFor(plain, "mcp:read");
    const u = await tokens(await plain.auth.handle(exchange(d.code, d.clientId, d.verifier)));
    const res = await plain.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/userinfo`, {
        method: "POST",
        headers: { authorization: `Bearer ${u.access_token}` },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "insufficient_scope" });
  });

  it("answers 401 for a session JWT whose audience is a resource and whose app claims add client_id and scope: the typ and jti checks refuse it", async () => {
    const h = oauthHandle();
    // One config cannot hold the overlap (review I-2: construction refuses
    // it). A second config on the same storage and secret can, such as an
    // app version without oauth during a deployment: it mints the token.
    const minter = oauthHandle({
      storage: h.storage,
      clock: h.clock,
      oauth: false,
      jwtMint: {
        audience: RESOURCE,
        claims: () => ({ client_id: "cl_app", scope: "openid email" }),
      },
    });
    const s = await signedIn(h);
    const minted = await minter.auth.handle(get("/auth/token", { cookie: s.cookie }));
    const { token } = (await minted.json()) as { token: string };
    expect(minted.status).toBe(200);
    expect(decodeJws(token)?.payload).toMatchObject({
      aud: RESOURCE,
      client_id: "cl_app",
      scope: "openid email",
    });
    const res = await h.auth.handle(
      get("/auth/oauth/userinfo", { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(401);
  });

  it("limits the token endpoint to 60 per IP per 15 minutes", async () => {
    const h = oauthHandle();
    const clientId = await registered(h);
    const call = (id = clientId) =>
      h.auth.handle(
        tokenPost(
          { grant_type: "refresh_token", refresh_token: "or_x", client_id: id },
          { "cf-connecting-ip": "8.8.8.8" },
        ),
      );
    // A failed client auth counts too: the limit comes first (plan 12e).
    for (let i = 0; i < 30; i++) expect((await call()).status).toBe(400);
    for (let i = 0; i < 30; i++) expect((await call("cl_x")).status).toBe(400);
    expect(await answer(await call())).toEqual({ status: 429, body: { error: "rate_limited" } });
  });

  it("answers unsupported_grant_type for another grant, and invalid_request for a JSON body and a repeated field", async () => {
    const h = oauthHandle();
    expect(
      await answer(
        await h.auth.handle(tokenPost({ grant_type: "password", username: "a", password: "b" })),
      ),
    ).toEqual({ status: 400, body: { error: "unsupported_grant_type" } });
    const asJson = new Request(`${BASE_URL}/auth/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    });
    expect(await answer(await h.auth.handle(asJson))).toEqual({
      status: 400,
      body: { error: "invalid_request" },
    });
    const twice = new Request(`${BASE_URL}/auth/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&grant_type=refresh_token",
    });
    expect(await answer(await h.auth.handle(twice))).toEqual({
      status: 400,
      body: { error: "invalid_request" },
    });
  });
});
