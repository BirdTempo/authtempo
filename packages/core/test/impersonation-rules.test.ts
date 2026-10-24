import { beforeAll, describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import {
  actorCookieName,
  IMPERSONATION_ALLOWED,
  IMPERSONATION_REFUSED,
} from "../src/http/impersonation-rules.js";
import { ROUTES, type RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { type ModelName, schema } from "../src/schema.js";
import { BASE } from "./every-feature.js";
import { APP_ORIGIN, BASE_URL, post } from "./helpers.js";
import { OPERATOR_SECRETS, operatorFixture, sessionOf } from "./operator-helpers.js";
import { FAST } from "./password-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

const KEYS = ROUTES.map((r) => `${r.method} ${r.path}` as RouteKey);
/**
 * The routes whose entry declares `impersonation_session`. The refusal rows
 * read this list, not IMPERSONATION_REFUSED, so a key that leaves the list
 * keeps its row, and the row fails.
 */
const DECLARING = ROUTES.filter((r) =>
  (r.codes as readonly string[]).includes("impersonation_session"),
).map((r) => `${r.method} ${r.path}` as RouteKey);

/** Every feature of core with the operator fixture: each route of ROUTES is mounted. */
async function featureConfig(): Promise<Partial<AuthConfig>> {
  return {
    social: { google: { clientId: "g", clientSecret: "g" } },
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE] },
    handoff: { schemes: ["example://"] },
    oauth: {
      resources: [`${BASE}/mcp`],
      registration: { cimd: false, dynamic: true },
      device: {},
    },
    openapi: true,
    // The role and team routes of plan 12k mount with their two features.
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      dynamicRoles: {},
      teams: {},
    },
    operator: {
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(OPERATOR_SECRETS.support),
          scopes: ["users", "sessions", "audit", "keys", "secrets"],
        },
      ],
      users: true,
      impersonation: {},
    },
    // The domain routes of plan 12d mount with sso; no test here asks the resolver.
    sso: { dns: [{ name: "none", txt: async () => [] }] },
    // The SCIM token routes and the SCIM server of plan 12d Task 9b.
    scim: {},
  };
}

/**
 * One world for the file: a platform operator starts an impersonation of a
 * user through the route. A refused call writes nothing, so the rows share it.
 */
async function world() {
  const f = await operatorFixture({ config: await featureConfig() });
  const target = await verifiedSession(f.auth, "ada@example.com");
  const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
  const res = await handle(
    post(
      "/auth/operator/impersonate",
      { userId: target.user.id, reason: "Ticket 9: a support call" },
      { cookie: `__Host-tempo_session=${f.operator.token}` },
    ),
  );
  if (res.status !== 200) throw new Error(`the start answered ${res.status}`);
  const line = res.headers.getSetCookie().find((s) => s.startsWith("__Host-tempo_session="));
  const token = line?.slice("__Host-tempo_session=".length).split(";")[0];
  if (!token) throw new Error("the start set no session cookie");
  return { ...f, target, handle, token, impersonation: await sessionOf(f.auth, token) };
}
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  w = await world();
});

/** The rows of every model, so a test sees any write. */
async function dump(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const model of Object.keys(schema) as ModelName[])
    out[model] = await w.auth.storage.findMany(model, []);
  return out;
}

/**
 * A request to the route of `key` with the impersonation session: the
 * cookie, or the `ts_` token as a bearer. A POST is a trusted JSON post.
 */
function requestOf(key: RouteKey, via: "cookie" | "bearer" = "cookie"): Request {
  const [method, path = ""] = key.split(" ");
  const url = `/auth${path.replace(":provider", "google")}`;
  const credential =
    via === "cookie"
      ? { cookie: `__Host-tempo_session=${w.token}` }
      : { authorization: `Bearer ${w.token}` };
  if (method === "POST") return post(url, {}, credential);
  return new Request(`${BASE_URL}${url}`, { headers: { ...credential, origin: APP_ORIGIN } });
}

describe("the impersonation lists (plan 12f Task 11)", () => {
  it("holds the two lists to ROUTES both ways", () => {
    const allowed = Object.keys(IMPERSONATION_ALLOWED);
    expect([...IMPERSONATION_REFUSED, ...allowed].sort()).toEqual([...KEYS].sort());
    expect(allowed.filter((k) => IMPERSONATION_REFUSED.has(k as RouteKey))).toEqual([]);
    for (const reason of Object.values(IMPERSONATION_ALLOWED))
      expect(typeof reason === "string" && reason.length > 0).toBe(true);
  });

  it("declares impersonation_session at exactly the refused routes", () => {
    expect([...DECLARING].sort()).toEqual([...IMPERSONATION_REFUSED].sort());
  });

  it("names the actor cookie after the session cookie", () => {
    expect(actorCookieName(w.auth.config)).toBe("__Host-tempo_session_actor");
  });

  it.each([...DECLARING].sort())(
    "refuses every route of IMPERSONATION_REFUSED to an impersonation session: %s",
    async (key) => {
      const before = await dump();
      const res = await w.handle(requestOf(key));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "impersonation_session" });
      expect(await dump()).toEqual(before);
    },
  );

  it.each([...DECLARING].sort())(
    "refuses every route of IMPERSONATION_REFUSED to a bearer impersonation session: %s",
    async (key) => {
      const before = await dump();
      const res = await w.handle(requestOf(key, "bearer"));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "impersonation_session" });
      expect(await dump()).toEqual(before);
    },
  );

  it("lets an impersonation session read what the user sees", async () => {
    for (const key of [
      "GET /session",
      "GET /sessions",
      "GET /passkeys",
      "GET /tokens",
      "GET /organizations",
    ] as const) {
      const res = await w.handle(requestOf(key));
      expect(res.status, key).toBe(200);
    }
    const session = await w.handle(requestOf("GET /session"));
    const body = (await session.json()) as { user: { id: string } };
    expect(body.user.id).toBe(w.target.user.id);
  });

  it("refuses an impersonation session in the in-process calls of the refused acts", async () => {
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: w.auth.storage,
      mail: { send: async () => {} },
      clock: w.auth.clock,
      password: { hash: FAST, uniformSignUp: false },
      organizations: {
        platformRole: "operator",
        platformOrganization: "platform-co",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      },
      ...(await featureConfig()),
    });
    const session = w.impersonation;
    const net = { ip: null, userAgent: null };
    const { api } = auth;
    if (!api.password || !api.totp) throw new Error("the config has no password");
    const answers = {
      reauthenticate: await api.session.reauthenticate({
        session,
        proof: { password: "x" },
        ip: null,
      }),
      requestReauthCode: await api.session.requestReauthCode({ session }),
      reauthPasskeyOptions: await api.session.reauthPasskeyOptions({ session, ip: null }),
      totpEnable: await api.totp.enable({ session, code: "123456" }),
      changeEmail: await api.user.changeEmail({ session, newEmail: "new@example.com" }),
      verifyEmailChange: await api.user.verifyEmailChange({ session, code: "123456", ...net }),
      delete: await api.user.delete({ session, ...net }),
      confirmDelete: await api.user.confirmDelete({ session, token: "x", ...net }),
      unlink: await api.identities.unlink({ session, id: "x", ...net }),
      startLink: await api.startLink({ provider: "google", session, ip: null }),
      passwordChange: await api.password.change({ session, newPassword: "a new password 1" }),
      impersonate: await api.operator.impersonate({
        operator: session,
        userId: w.operator.user.id,
        reason: "Ticket 9",
        ...net,
      }),
    };
    for (const [name, r] of Object.entries(answers))
      expect([name, r]).toEqual([name, { ok: false, code: "impersonation_session", status: 403 }]);
    // The session is still the impersonation of the target.
    expect((await auth.api.getSession(w.token))?.session.actorId).toBe(w.operator.user.id);
  });
});
