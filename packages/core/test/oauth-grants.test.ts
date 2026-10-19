import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmEmailChange, requestEmailChange } from "../src/engine/email-change.js";
import { requestResetOtp, resetPasswordWithOtp } from "../src/engine/email-otp.js";
import { familyEnds } from "../src/engine/oauth-family.js";
import { deleteOAuthTokens, revokeGrant } from "../src/engine/oauth-grants.js";
import { changePassword, requestPasswordReset, resetPassword } from "../src/engine/password.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, get, post } from "./helpers.js";
import {
  authorized,
  authorizeGet,
  codeFor,
  exchange,
  type Handle,
  OTHER_RESOURCE,
  oauthHandle,
  pkce,
  RESOURCE,
  registered,
  SCOPES,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";
import { FAST, pwHandle, recordNextTransaction } from "./password-helpers.js";

/**
 * The grants of a user and their end (plan 9g final fix wave, review I-1):
 * `api.oauth.grants` and `api.oauth.revoke`, their session routes, and the
 * reset and change rule that deletes the refresh tokens and keeps the consents.
 */

const OAUTH = {
  resources: [RESOURCE, OTHER_RESOURCE],
  scopes: SCOPES,
  registration: { cimd: false, dynamic: true },
};
const GRANT = { status: 400, body: { error: "invalid_grant" } };
const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

/** The family of a live refresh token. */
async function familyOf(h: { storage: StorageAdapter }, refresh: string | undefined) {
  const row = await h.storage.findOne("oauthToken", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(refresh ?? "") },
  ]);
  if (!row) throw new Error("no refresh row");
  return row.familyId;
}

/** The families that hold an end mark (ruling 43 of plan 12e): each one ended after its commit. */
const endedFamilies = async (h: { storage: StorageAdapter }) =>
  (
    await h.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "oauth-family-end" },
    ])
  )
    .map((v) => v.identifier)
    .sort();

/** The OAuth handle with password sign-in on and a mail list, so a test can reset the password. */
function pwOAuth() {
  return pwHandle({ hash: FAST }, { oauth: OAUTH });
}

async function tokensOf(h: Handle, c: { code: string; clientId: string; verifier: string }) {
  const res = await h.auth.handle(exchange(c.code, c.clientId, c.verifier));
  if (res.status !== 200) throw new Error(`token answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as { access_token: string; refresh_token?: string };
}

const refreshWith = (refreshToken: string, clientId: string) =>
  tokenPost({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });

/** A second client of `h` with a consent of the signed-in cookie for `scope`, and its tokens. */
async function secondGrant(h: Handle, cookie: string, name: string, scope: string) {
  const clientId = await registered(h, undefined, name);
  const p = await pkce();
  const { code } = await authorized(h, cookie, { clientId, challenge: p.challenge, scope });
  return { clientId, tokens: await tokensOf(h, { code, clientId, verifier: p.verifier }) };
}

const grantsOf = async (h: Handle, userId: string) => {
  const r = await h.auth.api.oauth?.grants({ userId });
  if (!r?.ok) throw new Error("grants failed");
  return r.value;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api.oauth.grants and api.oauth.revoke (plan 9g final fix wave)", () => {
  it("lists each consent newest first with the client name, the scopes, createdAt, and the live refresh tokens", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const first = await tokensOf(h, c);
    const firstAt = h.clock.now();
    // A rotation: the spent row stays until the sweep and does not count.
    expect((await h.auth.handle(refreshWith(first.refresh_token ?? "", c.clientId))).status).toBe(
      200,
    );
    h.clock.advance(1000);
    const second = await secondGrant(h, c.cookie, "Second client", "mcp:write");
    expect(await grantsOf(h, c.user.id)).toEqual([
      {
        clientId: second.clientId,
        clientName: "Second client",
        scopes: ["mcp:write"],
        createdAt: h.clock.now(),
        refreshTokens: 0,
      },
      {
        clientId: c.clientId,
        clientName: "Test MCP client",
        scopes: ["mcp:read", "offline_access"],
        createdAt: firstAt,
        refreshTokens: 1,
      },
    ]);
    // An expired refresh token does not count either.
    h.clock.advance(31 * 86_400_000);
    expect((await grantsOf(h, c.user.id)).map((g) => g.refreshTokens)).toEqual([0, 0]);
    const bob = await signedIn(h, "bob@example.com");
    expect(await grantsOf(h, bob.user.id)).toEqual([]);
  });

  it("revoke deletes the consent and every refresh token of the user and the client, keeps the others, and answers ok when nothing existed", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const ada = await tokensOf(h, c);
    const adaFamily = await familyOf(h, ada.refresh_token);
    const other = await secondGrant(h, c.cookie, "Other client", "mcp:read offline_access");
    const bob = await signedIn(h, "bob@example.com");
    const p = await pkce();
    const bobCode = await authorized(h, bob.cookie, {
      clientId: c.clientId,
      challenge: p.challenge,
    });
    const bobTokens = await tokensOf(h, {
      code: bobCode.code,
      clientId: c.clientId,
      verifier: p.verifier,
    });
    expect(await h.auth.api.oauth?.revoke({ userId: c.user.id, clientId: c.clientId })).toEqual({
      ok: true,
      value: { ok: true },
    });
    // Only the family of the user and the client ends with a mark.
    expect(await endedFamilies(h)).toEqual([adaFamily]);
    const consents = await h.storage.findMany("oauthConsent", []);
    expect(consents.map((r) => [r.userId, r.clientId]).sort()).toEqual(
      [
        [c.user.id, other.clientId],
        [bob.user.id, c.clientId],
      ].sort(),
    );
    const rows = await h.storage.findMany("oauthToken", []);
    expect(rows.map((r) => [r.userId, r.clientId]).sort()).toEqual(
      [
        [c.user.id, other.clientId],
        [bob.user.id, c.clientId],
      ].sort(),
    );
    expect(
      await answer(await h.auth.handle(refreshWith(ada.refresh_token ?? "", c.clientId))),
    ).toEqual(GRANT);
    expect(
      (await h.auth.handle(refreshWith(bobTokens.refresh_token ?? "", c.clientId))).status,
    ).toBe(200);
    expect(
      (await h.auth.handle(refreshWith(other.tokens.refresh_token ?? "", other.clientId))).status,
    ).toBe(200);
    expect(await h.auth.api.oauth?.revoke({ userId: c.user.id, clientId: "cl_unknown" })).toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it("a revoke whose token delete fails keeps the consent: both deletes run in one transaction (round 2 re-review)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    await tokensOf(h, c);
    // The token delete fails on both paths: inside a transaction and outside one.
    const del = h.storage.delete.bind(h.storage);
    h.storage.delete = ((model, where) =>
      model === "oauthToken"
        ? Promise.reject(new Error("storage down"))
        : del(model, where)) as typeof h.storage.delete;
    const transaction = h.storage.transaction.bind(h.storage);
    h.storage.transaction = (<T>(fn: (tx: StorageAdapter) => Promise<T>) =>
      transaction((tx) =>
        fn({
          ...tx,
          delete: (model, where) =>
            model === "oauthToken"
              ? Promise.reject(new Error("storage down"))
              : tx.delete(model, where),
        }),
      )) as typeof h.storage.transaction;
    await expect(
      h.auth.api.oauth?.revoke({ userId: c.user.id, clientId: c.clientId }),
    ).rejects.toThrow("storage down");
    expect(await h.storage.findMany("oauthConsent", [])).toHaveLength(1);
    expect(await h.storage.findMany("oauthToken", [])).toHaveLength(1);
    expect((await grantsOf(h, c.user.id)).map((g) => g.clientId)).toEqual([c.clientId]);
  });

  it("a code from before the revoke gives nothing at the exchange: the consent is gone", async () => {
    // Without offline_access no refresh row is written, so the consent check
    // before the tokens is the only guard: else an access token would go out.
    for (const scope of ["mcp:read", "mcp:read offline_access"]) {
      const h = oauthHandle();
      const c = await codeFor(h, scope);
      await h.auth.api.oauth?.revoke({ userId: c.user.id, clientId: c.clientId });
      expect({
        scope,
        answer: await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier))),
      }).toEqual({ scope, answer: GRANT });
      expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
    }
  });

  it("a revoke that lands during the code exchange, after its consent check: the new refresh row goes and the exchange answers invalid_grant", async () => {
    const outer = oauthHandle();
    let revokeFirst: (() => Promise<unknown>) | null = null;
    const storage = new Proxy(outer.storage, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "create" || typeof value !== "function") return value;
        return async (model: string, ...args: unknown[]) => {
          if (model === "oauthToken" && revokeFirst) {
            const run = revokeFirst;
            revokeFirst = null;
            await run();
          }
          return (value as (...a: unknown[]) => Promise<unknown>).call(target, model, ...args);
        };
      },
    }) as StorageAdapter;
    const h = { ...oauthHandle({ storage, clock: outer.clock }), storage: outer.storage };
    const c = await codeFor(h);
    revokeFirst = () => revokeGrant(h.config, { userId: c.user.id, clientId: c.clientId });
    expect(await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)))).toEqual(
      GRANT,
    );
    expect(revokeFirst).toBeNull();
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
  });

  it("a cleanup delete that throws is logged with the row id, and the answer stays invalid_grant (Task 6)", async () => {
    const outer = oauthHandle();
    let revokeFirst: (() => Promise<unknown>) | null = null;
    let failDelete = false;
    const storage = new Proxy(outer.storage, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if ((key !== "create" && key !== "delete") || typeof value !== "function") return value;
        return async (model: string, ...args: unknown[]) => {
          if (key === "create" && model === "oauthToken" && revokeFirst) {
            const run = revokeFirst;
            revokeFirst = null;
            await run();
            failDelete = true;
          } else if (key === "delete" && model === "oauthToken" && failDelete) {
            failDelete = false;
            throw new Error("storage down");
          }
          return (value as (...a: unknown[]) => Promise<unknown>).call(target, model, ...args);
        };
      },
    }) as StorageAdapter;
    const h = { ...oauthHandle({ storage, clock: outer.clock }), storage: outer.storage };
    const c = await codeFor(h);
    revokeFirst = () => revokeGrant(h.config, { userId: c.user.id, clientId: c.clientId });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)))).toEqual(
      GRANT,
    );
    const rows = await h.storage.findMany("oauthToken", []);
    expect(rows).toHaveLength(1);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      "authtempo: the delete of a refresh row in a revoked grant failed",
      rows[0]?.id,
      "Error",
    );
  });

  it("is absent with oauth off, and the routes answer 404", async () => {
    const h = oauthHandle({ oauth: false });
    expect(h.auth.api.oauth).toBeUndefined();
    const s = await signedIn(h);
    expect((await h.auth.handle(get("/auth/oauth/grants", { cookie: s.cookie }))).status).toBe(404);
    expect(
      (
        await h.auth.handle(
          post("/auth/oauth/grants/revoke", { clientId: "cl_x" }, { cookie: s.cookie }),
        )
      ).status,
    ).toBe(404);
  });
});

describe("the grant routes (plan 9g final fix wave)", () => {
  it("GET /oauth/grants answers the session's grants; POST /oauth/grants/revoke ends one", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    await tokensOf(h, c);
    const list = await h.auth.handle(get("/auth/oauth/grants", { cookie: c.cookie }));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      grants: [
        {
          clientId: c.clientId,
          clientName: "Test MCP client",
          scopes: ["mcp:read", "offline_access"],
          createdAt: h.clock.now().toISOString(),
          refreshTokens: 1,
        },
      ],
    });
    const revoked = await h.auth.handle(
      post("/auth/oauth/grants/revoke", { clientId: c.clientId }, { cookie: c.cookie }),
    );
    expect(await answer(revoked)).toEqual({ status: 200, body: { ok: true } });
    expect(await h.storage.findMany("oauthConsent", [])).toEqual([]);
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
    expect(
      await (await h.auth.handle(get("/auth/oauth/grants", { cookie: c.cookie }))).json(),
    ).toEqual({ grants: [] });
  });

  it("answers 401 with no session, a tk_ bearer, and an access token; 403 from an origin that is not trusted; invalid_body for a bad body", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const { access_token } = await tokensOf(h, c);
    const created = await h.auth.api.tokens.create({ user: c.user, name: "cli" });
    if (!created.ok) throw new Error(created.code);
    const bearers = [
      {},
      { authorization: `Bearer ${created.value.token}` },
      { authorization: `Bearer ${access_token}` },
    ];
    for (const headers of bearers) {
      expect(await answer(await h.auth.handle(get("/auth/oauth/grants", headers)))).toEqual({
        status: 401,
        body: { error: "unauthorized" },
      });
      expect(
        await answer(
          await h.auth.handle(post("/auth/oauth/grants/revoke", { clientId: c.clientId }, headers)),
        ),
      ).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
    const foreign = await h.auth.handle(
      post(
        "/auth/oauth/grants/revoke",
        { clientId: c.clientId },
        { cookie: c.cookie, origin: "https://evil.example.com" },
      ),
    );
    expect(await answer(foreign)).toEqual({ status: 403, body: { error: "origin_not_trusted" } });
    for (const body of [{}, { clientId: "" }, { clientId: 7 }, { clientId: "x".repeat(2049) }])
      expect(
        await answer(
          await h.auth.handle(post("/auth/oauth/grants/revoke", body, { cookie: c.cookie })),
        ),
      ).toEqual({ status: 400, body: { error: "invalid_body" } });
    // A trusted app origin passes, as on every session POST.
    expect(
      (
        await h.auth.handle(
          post(
            "/auth/oauth/grants/revoke",
            { clientId: c.clientId },
            { cookie: c.cookie, origin: APP_ORIGIN },
          ),
        )
      ).status,
    ).toBe(200);
    expect(await h.storage.findMany("oauthConsent", [])).toEqual([]);
  });
});

describe("a reset or a change of the password ends the refresh tokens and keeps the consents (plan 9g final fix wave)", () => {
  /** A verified user with a consent and a live refresh token for one client. */
  async function granted() {
    const h = pwOAuth();
    const c = await codeFor(h);
    const tokens = await tokensOf(h, c);
    return { h, c, tokens, family: await familyOf(h, tokens.refresh_token) };
  }

  /** The authorize step again with a new cookie: the code comes at once, with no consent page. */
  async function authorizeAgain(h: Handle, clientId: string, cookie: string) {
    const p = await pkce();
    const res = await h.auth.handle(authorizeGet({ clientId, challenge: p.challenge }, cookie));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("code")).toMatch(/^oc_/);
  }

  async function expectEnded(
    h: ReturnType<typeof pwOAuth>,
    c: { user: { id: string }; clientId: string },
    refresh: string,
  ) {
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
    expect(await answer(await h.auth.handle(refreshWith(refresh, c.clientId)))).toEqual(GRANT);
    expect(
      (await h.storage.findMany("oauthConsent", [])).map((r) => [r.userId, r.clientId]),
    ).toEqual([[c.user.id, c.clientId]]);
  }

  it("a reset by link", async () => {
    const { h, c, tokens, family } = await granted();
    await requestPasswordReset(h.config, { email: c.user.email, ip: null });
    const token = h.mails.at(-1)?.token ?? "";
    const writes = recordNextTransaction(h.storage);
    const r = await resetPassword(h.config, {
      token,
      password: "a new long password",
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
    if (!("token" in r.value)) throw new Error("the reset answered a challenge");
    expect(writes.indexOf("delete:oauthToken")).toBeGreaterThan(writes.indexOf("delete:session"));
    await expectEnded(h, c, tokens.refresh_token ?? "");
    expect(await endedFamilies(h)).toEqual([family]);
    await authorizeAgain(h, c.clientId, `__Host-tempo_session=${r.value.token}`);
  });

  it("a reset by code", async () => {
    const { h, c, tokens } = await granted();
    const sent = await requestResetOtp(h.config, { email: c.user.email, ip: null });
    if (!sent.ok) throw new Error(sent.code);
    const code = /\b(\d{8}|\d{6})\b/.exec(h.mails.at(-1)?.text ?? "")?.[1] ?? "";
    const writes = recordNextTransaction(h.storage);
    const r = await resetPasswordWithOtp(h.config, {
      email: c.user.email,
      code,
      password: "a new long password",
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
    if (!("token" in r.value)) throw new Error("the reset answered a challenge");
    expect(writes.indexOf("delete:oauthToken")).toBeGreaterThan(writes.indexOf("delete:session"));
    await expectEnded(h, c, tokens.refresh_token ?? "");
    await authorizeAgain(h, c.clientId, `__Host-tempo_session=${r.value.token}`);
  });

  it("a password change", async () => {
    const { h, c, tokens, family } = await granted();
    const session = await resolveSession(h.config, c.token);
    if (!session) throw new Error("no session");
    const writes = recordNextTransaction(h.storage);
    expect(await changePassword(h.config, { session, newPassword: "a new long password" })).toEqual(
      { ok: true, value: { ok: true } },
    );
    expect(writes.indexOf("delete:oauthToken")).toBeGreaterThan(writes.indexOf("delete:session"));
    await expectEnded(h, c, tokens.refresh_token ?? "");
    expect(await endedFamilies(h)).toEqual([family]);
    await authorizeAgain(h, c.clientId, c.cookie);
  });

  it("an email change ends the refresh families after its commit (ruling 43)", async () => {
    const { h, c, tokens, family } = await granted();
    const session = await resolveSession(h.config, c.token);
    if (!session) throw new Error("no session");
    const sent = await requestEmailChange(h.config, { session, newEmail: "ada@new.example.com" });
    if (!sent.ok) throw new Error(sent.code);
    const token = /token=(ec_[A-Za-z0-9_-]{43})/.exec(h.mails.at(-1)?.text ?? "")?.[1] ?? "";
    const moved = await confirmEmailChange(h.config, { token, ip: null, userAgent: null });
    if (!moved.ok) throw new Error(moved.code);
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
    expect(
      await answer(await h.auth.handle(refreshWith(tokens.refresh_token ?? "", c.clientId))),
    ).toEqual(GRANT);
    expect(await endedFamilies(h)).toEqual([family]);
  });

  it("ends a family that a code exchange writes while a reset runs (ruling 43)", async () => {
    const outer = pwOAuth();
    // Inside the reset, after its refresh token delete, a code exchange of
    // the same user runs and commits. Its new family is not in the list of
    // the delete, so only the read after the commit finds it.
    let during: (() => Promise<unknown>) | null = null;
    const inTx = (tx: StorageAdapter): StorageAdapter =>
      new Proxy(tx, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "delete" || typeof value !== "function") return value;
          return async (model: string, ...args: unknown[]) => {
            const out = await (value as (...a: unknown[]) => Promise<unknown>).call(
              target,
              model,
              ...args,
            );
            if (model === "oauthToken" && during) {
              const run = during;
              during = null;
              await run();
            }
            return out;
          };
        },
      }) as StorageAdapter;
    const storage = new Proxy(outer.storage, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "transaction" || typeof value !== "function") return value;
        return (fn: (tx: StorageAdapter) => Promise<unknown>) =>
          (value as StorageAdapter["transaction"]).call(target, (tx) => fn(inTx(tx)));
      },
    }) as StorageAdapter;
    const h = {
      ...pwHandle({ hash: FAST }, { oauth: OAUTH, storage, clock: outer.clock }),
      storage: outer.storage,
    };
    const c = await codeFor(h);
    const first = await tokensOf(h, c);
    const firstFamily = await familyOf(h, first.refresh_token);
    const p = await pkce();
    const late = await authorized(h, c.cookie, { clientId: c.clientId, challenge: p.challenge });
    let lateAnswer: { status: number; body: unknown } | null = null;
    during = async () => {
      lateAnswer = await answer(
        await outer.auth.handle(exchange(late.code, c.clientId, p.verifier)),
      );
    };
    await requestPasswordReset(h.config, { email: c.user.email, ip: null });
    const r = await resetPassword(h.config, {
      token: h.mails.at(-1)?.token ?? "",
      password: "a new long password",
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
    expect(lateAnswer).toMatchObject({ status: 200 });
    const lateFamily = (await endedFamilies(h)).find((f) => f !== firstFamily);
    expect(lateFamily).toBeDefined();
    expect((await endedFamilies(h)).length).toBe(2);
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
  });

  it("a code issued before a reset or a change answers invalid_grant: the codes go too (round 2)", async () => {
    for (const end of ["reset", "change"] as const) {
      const h = pwOAuth();
      // Without offline_access the exchange writes no refresh row, so only the code delete refuses it.
      const c = await codeFor(h, "mcp:read");
      const writes = recordNextTransaction(h.storage);
      if (end === "reset") {
        await requestPasswordReset(h.config, { email: c.user.email, ip: null });
        const r = await resetPassword(h.config, {
          token: h.mails.at(-1)?.token ?? "",
          password: "a new long password",
          ip: null,
          userAgent: null,
        });
        if (!r.ok) throw new Error(r.code);
      } else {
        const session = await resolveSession(h.config, c.token);
        if (!session) throw new Error("no session");
        expect(
          (await changePassword(h.config, { session, newPassword: "a new long password" })).ok,
        ).toBe(true);
      }
      expect(writes.indexOf("delete:oauthToken")).toBeGreaterThan(writes.indexOf("delete:session"));
      expect(writes[writes.indexOf("delete:oauthToken") + 1]).toBe("delete:verification");
      expect(
        await h.storage.findMany("verification", [
          { field: "purpose", op: "eq", value: "oauth-code" },
        ]),
      ).toEqual([]);
      expect({
        end,
        answer: await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier))),
      }).toEqual({ end, answer: GRANT });
      expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
    }
  });

  it("a reset that lands during the code exchange, after the code is spent: the new refresh row goes (round 2)", async () => {
    const outer = oauthHandle();
    let resetFirst: (() => Promise<unknown>) | null = null;
    const storage = new Proxy(outer.storage, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "create" || typeof value !== "function") return value;
        return async (model: string, ...args: unknown[]) => {
          if (model === "oauthToken" && resetFirst) {
            const run = resetFirst;
            resetFirst = null;
            await run();
          }
          return (value as (...a: unknown[]) => Promise<unknown>).call(target, model, ...args);
        };
      },
    }) as StorageAdapter;
    const h = { ...oauthHandle({ storage, clock: outer.clock }), storage: outer.storage };
    const c = await codeFor(h);
    // The reset's own delete, with the consent kept, as a reset leaves it.
    resetFirst = () => deleteOAuthTokens(outer.storage, c.user.id, familyEnds());
    expect(await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)))).toEqual(
      GRANT,
    );
    expect(resetFirst).toBeNull();
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
    expect(await h.storage.findMany("oauthConsent", [])).toHaveLength(1);
  });

  it("another user's refresh tokens stay", async () => {
    const { h, c } = await granted();
    const bob = await signedIn(h, "bob@example.com");
    const p = await pkce();
    const bobCode = await authorized(h, bob.cookie, {
      clientId: c.clientId,
      challenge: p.challenge,
    });
    await tokensOf(h, { code: bobCode.code, clientId: c.clientId, verifier: p.verifier });
    const session = await resolveSession(h.config, c.token);
    if (!session) throw new Error("no session");
    expect(
      (await changePassword(h.config, { session, newPassword: "a new long password" })).ok,
    ).toBe(true);
    expect((await h.storage.findMany("oauthToken", [])).map((r) => r.userId)).toEqual([
      bob.user.id,
    ]);
  });
});

describe("a family end that fails after the commit (ruling 45 of plan 12e)", () => {
  /**
   * A handle whose storage throws at the end mark of a family, with hooks
   * that record each ended session and each user update. The reset, the
   * change, and the move commit first; then the family end throws.
   */
  async function failingEnd() {
    const outer = pwOAuth();
    const events: string[] = [];
    const storage = new Proxy(outer.storage, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "create" || typeof value !== "function") return value;
        return async (model: string, data: { purpose?: string }) => {
          if (model === "verification" && data.purpose === "oauth-family-end")
            throw new Error("storage down");
          return (value as (...a: unknown[]) => Promise<unknown>).call(target, model, data);
        };
      },
    }) as StorageAdapter;
    const h = {
      ...pwHandle(
        { hash: FAST },
        {
          oauth: OAUTH,
          storage,
          clock: outer.clock,
          hooks: {
            session: { afterEnd: (e) => void events.push(`afterEnd:${e.reason}`) },
            user: { afterUpdate: (e) => void events.push(`afterUpdate:${e.via}`) },
          },
        },
      ),
      storage: outer.storage,
    };
    const c = await codeFor(h);
    await tokensOf(h, c);
    // A second session of the user, which the reset and the change end.
    await createSession(h.config, { userId: c.user.id, ip: null, userAgent: null });
    return { h, c, events };
  }

  const notices = (h: { mails: { subject: string }[] }) =>
    h.mails.filter((m) => m.subject.startsWith("Security notice")).length;

  it("a reset sends its notice and runs its hooks before the family end throws", async () => {
    const { h, c, events } = await failingEnd();
    await requestPasswordReset(h.config, { email: c.user.email, ip: null });
    await expect(
      resetPassword(h.config, {
        token: h.mails.at(-1)?.token ?? "",
        password: "a new long password",
        ip: null,
        userAgent: null,
      }),
    ).rejects.toThrow("storage down");
    expect(notices(h)).toBe(1);
    expect(events).toContain("afterEnd:password_reset");
    // The reset committed: its token delete holds.
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
  });

  it("a password change sends its notice and runs its hooks before the family end throws", async () => {
    const { h, c, events } = await failingEnd();
    const session = await resolveSession(h.config, c.token);
    if (!session) throw new Error("no session");
    await expect(
      changePassword(h.config, { session, newPassword: "a new long password" }),
    ).rejects.toThrow("storage down");
    expect(notices(h)).toBe(1);
    expect(events).toContain("afterEnd:password_change");
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
  });

  it("an email change sends its notice and runs its hooks before the family end throws", async () => {
    const { h, c, events } = await failingEnd();
    const session = await resolveSession(h.config, c.token);
    if (!session) throw new Error("no session");
    const sent = await requestEmailChange(h.config, { session, newEmail: "ada@new.example.com" });
    if (!sent.ok) throw new Error(sent.code);
    const token = /token=(ec_[A-Za-z0-9_-]{43})/.exec(h.mails.at(-1)?.text ?? "")?.[1] ?? "";
    await expect(
      confirmEmailChange(h.config, { token, ip: null, userAgent: null }),
    ).rejects.toThrow("storage down");
    expect(notices(h)).toBe(1);
    expect(events).toContain("afterUpdate:email_change");
    expect(await h.storage.findMany("oauthToken", [])).toEqual([]);
  });
});
