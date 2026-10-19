import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";
import {
  authorized,
  basicHeader,
  confidential,
  exchange,
  type Handle,
  pkce,
  RESOURCE,
  registered,
  SCOPES,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";
import { type DpopKey, dpopKey } from "./support/dpop-key.js";

/**
 * The refresh reuse window (plan 12e Task 13, spec 8.16 item 12). A retry
 * inside the window answers a new child and spends the child of the first
 * use, so the family keeps one live branch. A copy outside the window, or
 * a superseded child, ends the family on every instance.
 */

const TOKEN_URL = `${BASE_URL}/auth/oauth/token`;

/** One core instance with a reuse window of `seconds`, on the storage and clock of `shared` or on new ones. */
function instance(seconds: number | undefined, shared?: Pick<Handle, "storage" | "clock">): Handle {
  const base = shared ? { storage: shared.storage, clock: shared.clock } : makeAuth();
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: createMemoryLimiter(base.clock),
    oauth: {
      resources: [RESOURCE],
      scopes: SCOPES,
      registration: { cimd: false, dynamic: true },
      ...(seconds !== undefined ? { refreshReuseSeconds: seconds } : {}),
    },
  };
  return {
    auth: createAuth(input),
    config: resolveConfig(input),
    storage: base.storage,
    clock: base.clock,
  };
}

async function answer(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const GRANT = { status: 400, body: { error: "invalid_grant" } };
const BAD_PROOF = { status: 400, body: { error: "invalid_dpop_proof" } };

async function refresh(
  h: Handle,
  token: string,
  body: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  return answer(
    await h.auth.handle(
      tokenPost({ grant_type: "refresh_token", refresh_token: token, ...body }, headers),
    ),
  );
}

/** The refresh token of a 200 answer. */
function refreshOf(a: { status: number; body: Record<string, unknown> }): string {
  const t = a.body.refresh_token;
  if (a.status !== 200 || typeof t !== "string")
    throw new Error(`token answered ${a.status}: ${JSON.stringify(a.body)}`);
  return t;
}

const rowOf = async (h: Handle, token: string) =>
  h.storage.findOne("oauthToken", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);

/** The unspent rows of the family of `familyId`. */
const liveRows = async (h: Handle, familyId: string) =>
  h.storage.findMany("oauthToken", [
    { field: "familyId", op: "eq", value: familyId },
    { field: "usedAt", op: "eq", value: null },
  ]);

/**
 * A storage that, after `hold`, keeps each `oauthToken` update waiting
 * until two reads of a child by `parentId` are done, or 500 ms pass.
 */
function gatedStorage(base: StorageAdapter) {
  let reads = 0;
  let held = false;
  let release = () => {};
  const bothRead = new Promise<void>((r) => {
    release = r;
  });
  const storage = new Proxy(base, {
    get(target, key, receiver) {
      if (key === "findOne")
        return async (model: string, where: { field: string }[], ...rest: unknown[]) => {
          const out = await (base.findOne as (...a: unknown[]) => Promise<unknown>)(
            model,
            where,
            ...rest,
          );
          if (held && model === "oauthToken" && where.some((w) => w.field === "parentId"))
            if (++reads === 2) release();
          return out;
        };
      if (key === "update")
        return async (model: string, ...args: unknown[]) => {
          if (held && model === "oauthToken")
            await Promise.race([bothRead, new Promise((r) => setTimeout(r, 500))]);
          return (base.update as (...a: unknown[]) => Promise<unknown>)(model, ...args);
        };
      return Reflect.get(target, key, receiver);
    },
  }) as StorageAdapter;
  return {
    storage,
    hold: () => {
      held = true;
    },
    childReads: () => reads,
  };
}

let users = 0;

/** A code of a new public client for a new signed-in user. */
async function publicCode(h: Handle) {
  users += 1;
  const s = await signedIn(h, `user${users}@example.com`);
  const clientId = await registered(h);
  const p = await pkce();
  const { code } = await authorized(h, s.cookie, {
    clientId,
    challenge: p.challenge,
    scope: "mcp:read offline_access",
  });
  return { clientId, verifier: p.verifier, code };
}

/** A public client's grant: the first refresh token, its client, and its family id. */
async function grant(h: Handle) {
  const c = await publicCode(h);
  const issued = await answer(await h.auth.handle(exchange(c.code, c.clientId, c.verifier)));
  const token = refreshOf(issued);
  const familyId = (await rowOf(h, token))?.familyId ?? "";
  return { clientId: c.clientId, token, familyId };
}

describe("the refresh reuse window (plan 12e Task 13)", () => {
  it("keeps the family for a retry inside the window", async () => {
    const a = instance(10);
    const b = instance(10, a);
    const g = await grant(a);
    // The client's first use: the answer with the first child is lost on the network.
    const lost = refreshOf(await refresh(a, g.token, { client_id: g.clientId }));
    a.clock.advance(5_000);
    // The retry 5 s later reaches another instance on the same storage.
    const retry = await refresh(b, g.token, { client_id: g.clientId });
    const child = refreshOf(retry);
    expect(child).not.toBe(lost);
    expect(retry.body.token_type).toBe("Bearer");
    // The first child is spent, and the new child is the one live row of the family.
    expect((await rowOf(a, lost))?.usedAt).toEqual(a.clock.now());
    const parent = await rowOf(a, g.token);
    expect(await rowOf(a, child)).toMatchObject({
      familyId: g.familyId,
      parentId: parent?.id,
      usedAt: null,
    });
    expect((await liveRows(a, g.familyId)).length).toBe(1);
    // The family lives: the new child refreshes on the first instance.
    expect((await refresh(a, child, { client_id: g.clientId })).status).toBe(200);
  });

  it("deletes the family when the superseded child comes later", async () => {
    const a = instance(10);
    const b = instance(10, a);
    const g = await grant(a);
    const lost = refreshOf(await refresh(a, g.token, { client_id: g.clientId }));
    a.clock.advance(5_000);
    const child = refreshOf(await refresh(a, g.token, { client_id: g.clientId }));
    a.clock.advance(1_000);
    // The superseded child, presented later, is a copy: the family goes on every instance.
    expect(await refresh(b, lost, { client_id: g.clientId })).toEqual(GRANT);
    expect(
      await a.storage.findMany("oauthToken", [{ field: "familyId", op: "eq", value: g.familyId }]),
    ).toEqual([]);
    expect(await refresh(a, child, { client_id: g.clientId })).toEqual(GRANT);

    // The client used its first child already, so a copy of the parent inside the window ends the family.
    const g2 = await grant(a);
    const first = refreshOf(await refresh(a, g2.token, { client_id: g2.clientId }));
    const grandchild = refreshOf(await refresh(a, first, { client_id: g2.clientId }));
    a.clock.advance(2_000);
    expect(await refresh(b, g2.token, { client_id: g2.clientId })).toEqual(GRANT);
    expect(await liveRows(a, g2.familyId)).toEqual([]);
    expect(await refresh(a, grandchild, { client_id: g2.clientId })).toEqual(GRANT);
  });

  it("deletes the family at once outside the window and with the window off", async () => {
    const a = instance(10);
    const b = instance(10, a);
    const g = await grant(a);
    const child = refreshOf(await refresh(a, g.token, { client_id: g.clientId }));
    // The window ends at usedAt + 10 s: a copy at that second is a reuse.
    a.clock.advance(10_000);
    expect(await refresh(b, g.token, { client_id: g.clientId })).toEqual(GRANT);
    expect(
      await a.storage.findMany("oauthToken", [{ field: "familyId", op: "eq", value: g.familyId }]),
    ).toEqual([]);
    expect(await refresh(a, child, { client_id: g.clientId })).toEqual(GRANT);

    // With no key and with 0, a copy in the same second of the use ends the family, as before plan 12e.
    for (const seconds of [undefined, 0]) {
      const off = instance(seconds);
      const offB = instance(seconds, off);
      expect(off.config.oauth?.refreshReuseSeconds).toBe(0);
      const o = await grant(off);
      const next = refreshOf(await refresh(off, o.token, { client_id: o.clientId }));
      expect(await refresh(offB, o.token, { client_id: o.clientId })).toEqual(GRANT);
      expect(
        await off.storage.findMany("oauthToken", [
          { field: "familyId", op: "eq", value: o.familyId },
        ]),
      ).toEqual([]);
      expect(await refresh(off, next, { client_id: o.clientId })).toEqual(GRANT);
    }
  });

  it("needs the client auth and the same DPoP key for a retry", async () => {
    const a = instance(10);
    const b = instance(10, a);

    // A confidential client: a copy without the secret ends nothing and gets nothing.
    const conf = await confidential(a, "client_secret_basic");
    const s = await signedIn(a, "grace@example.com");
    const p = await pkce();
    const { code } = await authorized(a, s.cookie, {
      clientId: conf.clientId,
      challenge: p.challenge,
      scope: "mcp:read offline_access",
    });
    const basic = { authorization: basicHeader(conf.clientId, conf.secret) };
    const issued = refreshOf(
      await answer(
        await a.auth.handle(
          tokenPost(
            {
              grant_type: "authorization_code",
              code,
              code_verifier: p.verifier,
              redirect_uri: "https://client.example.com/callback",
              resource: RESOURCE,
            },
            basic,
          ),
        ),
      ),
    );
    const confFamily = (await rowOf(a, issued))?.familyId ?? "";
    refreshOf(await refresh(a, issued, {}, basic));
    a.clock.advance(3_000);
    expect(await refresh(b, issued, { client_id: conf.clientId })).toEqual({
      status: 400,
      body: { error: "invalid_client" },
    });
    const wrong = { authorization: basicHeader(conf.clientId, `${conf.secret}x`) };
    expect((await refresh(b, issued, {}, wrong)).status).toBe(401);
    // Another client cannot retry the token either.
    const other = await grant(a);
    expect(await refresh(b, issued, { client_id: other.clientId })).toEqual(GRANT);
    expect((await liveRows(a, confFamily)).length).toBe(1);
    // The client with its secret retries and keeps one live branch.
    const confChild = refreshOf(await refresh(b, issued, {}, basic));
    expect(await liveRows(a, confFamily)).toMatchObject([{ id: (await rowOf(a, confChild))?.id }]);

    // A public client with a DPoP-bound grant: the binding check runs before the reuse check.
    const key = await dpopKey();
    const thief: DpopKey = await dpopKey();
    const proof = (k: DpopKey) =>
      k.proof({ htu: TOKEN_URL, iat: Math.floor(a.clock.now().getTime() / 1000) });
    const c = await publicCode(a);
    const bound = refreshOf(
      await answer(
        await a.auth.handle(
          tokenPost(
            {
              grant_type: "authorization_code",
              code: c.code,
              code_verifier: c.verifier,
              client_id: c.clientId,
              redirect_uri: "https://client.example.com/callback",
              resource: RESOURCE,
            },
            { dpop: await proof(key) },
          ),
        ),
      ),
    );
    const boundFamily = (await rowOf(a, bound))?.familyId ?? "";
    refreshOf(await refresh(a, bound, { client_id: c.clientId }, { dpop: await proof(key) }));
    a.clock.advance(3_000);
    expect(await refresh(b, bound, { client_id: c.clientId })).toEqual(BAD_PROOF);
    expect(
      await refresh(b, bound, { client_id: c.clientId }, { dpop: await proof(thief) }),
    ).toEqual(BAD_PROOF);
    expect((await liveRows(a, boundFamily)).length).toBe(1);
    const retry = await refresh(b, bound, { client_id: c.clientId }, { dpop: await proof(key) });
    expect(retry.body.token_type).toBe("DPoP");
    const boundChild = await rowOf(a, refreshOf(retry));
    expect(boundChild?.dpopJkt).toBe(key.jkt);
    expect(await liveRows(a, boundFamily)).toMatchObject([{ id: boundChild?.id }]);
  });

  it("gives two parallel retries on two instances one live child at most", async () => {
    const base = makeAuth();
    const g8 = gatedStorage(base.storage);
    const a = instance(10, { storage: g8.storage, clock: base.clock });
    const b = instance(10, a);
    const g = await grant(a);
    refreshOf(await refresh(a, g.token, { client_id: g.clientId }));
    a.clock.advance(4_000);
    // Both retries read the unspent child before either spends it.
    g8.hold();
    const answers = await Promise.all([
      refresh(a, g.token, { client_id: g.clientId }),
      refresh(b, g.token, { client_id: g.clientId }),
    ]);
    expect(g8.childReads()).toBe(2);
    const ok = answers.filter((r) => r.status === 200);
    expect(ok.length).toBeLessThanOrEqual(1);
    expect(answers.filter((r) => r.status !== 200)).toContainEqual(GRANT);
    for (const r of answers) if (r.status !== 200) expect(r).toEqual(GRANT);
    // Never a second branch: no live row is left but the token of a 200.
    const live = await liveRows(a, g.familyId);
    const answered = await Promise.all(ok.map(async (r) => (await rowOf(a, refreshOf(r)))?.id));
    for (const row of live) expect(answered).toContain(row.id);
    expect(live.length).toBeLessThanOrEqual(1);
  });
});
