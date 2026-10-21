import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { startImpersonation } from "../src/engine/operator/impersonation.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { APP_ORIGIN, BASE_URL } from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture } from "./operator-helpers.js";
import { FAST } from "./password-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

// The two JWT doors of an impersonation session that an operator ban left
// for the sweep (ruling 52 c, the final review m1 of plan 12f): the mint of
// a session JWT and the live check of POST /token/live.

const TARGET = "ada@example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const UNAUTHORIZED = { ok: false, code: "unauthorized", status: 401 };

/**
 * The keys of the world that the engine view and `createAuth` share. A
 * session hook makes the ban end a page in its act (ruling 44). Every
 * request passes: 50 starts would fill the limit.
 */
async function shared(): Promise<Partial<AuthConfig>> {
  return {
    operator: {
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(OPERATOR_SECRETS.support),
          scopes: ["users", "sessions", "audit"],
        },
      ],
      users: true,
      impersonation: {},
    },
    jwtMint: {},
    hooks: { session: { afterEnd: () => {} } },
    limiter: { allow: async () => true },
  };
}

/** A platform operator, a target, and an app on the same storage and clock. */
async function world() {
  const keys = await shared();
  const f = await operatorFixture({ config: keys });
  const target = await verifiedSession(f.auth, TARGET);
  const app = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: f.auth.storage,
    mail: { send: async () => {} },
    clock: f.auth.clock,
    password: { hash: FAST, uniformSignUp: false },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    ...keys,
  });
  return { ...f, target, app };
}

/** The live check as a resource server sends it: a POST with the JWT as the bearer. */
async function live(w: Awaited<ReturnType<typeof world>>, jwt: string): Promise<unknown> {
  const res = await w.app.handle(
    new Request(`${BASE_URL}/auth/token/live`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
    }),
  );
  return res.json();
}

describe("the JWT doors of an impersonation session left by an operator ban (plan 12f)", () => {
  it("answers live false at POST /token/live and unauthorized at api.jwt.mint before the sweep", async () => {
    const w = await world();
    const jwtApi = w.app.api.jwt;
    if (!jwtApi) throw new Error("no jwt api");
    // 50 impersonation sessions, each with a session JWT minted while the operator acts.
    const jwts = new Map<string, string>();
    for (let i = 0; i < 50; i++) {
      const r = await startImpersonation(w.auth.config, {
        operator: w.operator,
        userId: w.target.user.id,
        reason: "Ticket 4711: the user cannot see the invoices",
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
      const minted = await jwtApi.mint({ userId: w.target.user.id, sessionId: r.value.session.id });
      if (!minted.ok) throw new Error(minted.code);
      jwts.set(r.value.session.id, minted.value.token);
    }
    const [firstId, firstJwt] = [...jwts][0] ?? [];
    if (!firstId || !firstJwt) throw new Error("no impersonation");
    expect(await live(w, firstJwt)).toEqual({ live: true });
    w.auth.clock.advance(1000);
    const r = await operatorApi(w.auth.config).users.ban({
      actor: APP,
      userId: w.operator.user.id,
      reason: "The operator left",
      ip: null,
      userAgent: null,
    });
    expect(r.ok).toBe(true);
    // The act ends a page; the rows that do not fit stay for the sweep.
    const left = await w.auth.storage.findMany("session", [
      { field: "actorId", op: "eq", value: w.operator.user.id },
    ]);
    expect(left.length).toBeGreaterThan(0);
    const row = left[0];
    const jwt = row ? jwts.get(row.id) : undefined;
    if (!row || !jwt) throw new Error("no left row");
    // The target is not banned: only the door of the operator refuses the row.
    expect(await live(w, jwt)).toEqual({ live: false });
    expect(await jwtApi.sessionLive({ sid: row.id })).toBe(false);
    expect(await jwtApi.mint({ userId: w.target.user.id, sessionId: row.id })).toEqual(
      UNAUTHORIZED,
    );
    // The two doors read the row and delete nothing; the target's own session still mints.
    expect(
      await w.auth.storage.findOne("session", [{ field: "id", op: "eq", value: row.id }]),
    ).not.toBeNull();
    expect(
      (await jwtApi.mint({ userId: w.target.user.id, sessionId: w.target.session.id })).ok,
    ).toBe(true);
  });
});
