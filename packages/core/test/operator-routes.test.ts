import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { hookRefusal } from "../src/engine/hooks.js";
import { updateMemberRole } from "../src/engine/organizations.js";
import { passwordSignUp } from "../src/engine/password.js";
import { openSession } from "../src/engine/sessions.js";
import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteContract } from "../src/http/contract/types.js";
import { ROUTES } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { APP_ORIGIN, BASE_URL } from "./helpers.js";
import { OPERATOR_SECRETS, type OperatorAuth, operatorFixture } from "./operator-helpers.js";
import { enrolled, PASSWORD, verifiedSession } from "./totp-helpers.js";

beforeEach(() => {
  // The guard and the reads write one log line each; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The contract table, read as a plain record. */
const CONTRACT: Record<string, RouteContract> = ROUTE_CONTRACT;

/** The IP of every call, unless a call names another. */
const IP = "203.0.113.50";
/** The user agent of every call that sends an IP. */
const AGENT = "ops-test/1";
const REASON = "Support case 4711";

/**
 * The routes of plan 12f Task 10, typed here (spec 26 item 7, less the two
 * impersonation routes of Task 11), with the scope that a secret needs.
 */
const TOOL_ROUTES = [
  { key: "GET /operator/users", scope: "users" },
  { key: "GET /operator/users/search", scope: "users" },
  { key: "GET /operator/users/get", scope: "users" },
  { key: "POST /operator/users/ban", scope: "users" },
  { key: "POST /operator/users/unban", scope: "users" },
  { key: "POST /operator/users/platform-role", scope: "users" },
  { key: "POST /operator/users/second-factor/disable", scope: "users" },
  { key: "POST /operator/users/create-admin", scope: "users" },
  { key: "POST /operator/sessions/end-user", scope: "sessions" },
  { key: "POST /operator/sessions/end-all", scope: "sessions" },
  { key: "GET /operator/audit", scope: "audit" },
] as const;

type ToolKey = (typeof TOOL_ROUTES)[number]["key"];
type WriteKey = Extract<ToolKey, `POST ${string}`>;
const WRITES = TOOL_ROUTES.map((r) => r.key).filter((k): k is WriteKey => k.startsWith("POST "));

/** One call of a route: its query or body, and the headers beside the IP and the agent. */
interface Call {
  query?: Record<string, string>;
  body?: unknown;
  /** Send the body as a form, not as JSON. */
  form?: true;
  headers?: Record<string, string>;
  /** Null sends no `cf-connecting-ip` and no `user-agent`. */
  ip?: string | null;
}

function request(key: string, call: Call = {}): Request {
  const [method, path] = key.split(" ") as ["GET" | "POST", string];
  const url = new URL(`${BASE_URL}/auth${path}`);
  for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    ...(call.ip === null ? {} : { "cf-connecting-ip": call.ip ?? IP, "user-agent": AGENT }),
    ...call.headers,
  };
  if (method === "GET") return new Request(url, { headers });
  if (call.form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries((call.body ?? {}) as Record<string, unknown>))
      params.set(k, typeof v === "string" ? v : JSON.stringify(v));
    return new Request(url, {
      method,
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: params.toString(),
    });
  }
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(call.body ?? {}),
  });
}

/** What a route answered: the status, and the code of a JSON error. */
async function answerOf(res: Response): Promise<{ status: number; code: string | null }> {
  const body = (await res.clone().json()) as { error?: string };
  return { status: res.status, code: body.error ?? null };
}

/** `Authorization: Operator <secret>`. */
const secret = (s: string) => ({ authorization: `Operator ${s}` });
/** The scopes users, sessions, and audit. */
const SUPPORT = secret(OPERATOR_SECRETS.support);
/** The scopes keys and secrets: no scope of the user, session, and audit tools. */
const KEYS = secret(OPERATOR_SECRETS.keys);
/** The scope audit alone. */
const AUDIT = secret(OPERATOR_SECRETS.audit);
const WRONG = secret("operator-wrong-0123456789abcdef-0123456");

/**
 * The fixture of plan 12f: three named secrets, a fresh platform operator
 * with TOTP on, and the router of `createAuth` on the same config. A
 * `createAuth` builds the same three parts: the routes, the POST gate, and
 * the router.
 */
async function world(options: { role?: string | null; config?: Partial<AuthConfig> } = {}) {
  const fx = await operatorFixture(options);
  const handle = createRouter(fx.auth.config, coreRoutes(fx.auth.config));
  return {
    auth: fx.auth as OperatorAuth,
    handle,
    operator: {
      userId: fx.operator.user.id,
      cookie: { cookie: `${fx.auth.config.cookieName}=${fx.operator.token}` },
    },
    rootId: fx.root.id,
  };
}

/** The headers of a platform operator's call: the session cookie, and the trusted Origin on a POST. */
function sessionHeaders(key: string, cookie: Record<string, string>): Record<string, string> {
  return key.startsWith("POST ") ? { ...cookie, origin: APP_ORIGIN } : cookie;
}

/** A proof of identity checked one hour before the fixture clock (2026-01-01). */
const PROOF = { method: "document", reference: "case-4711", checkedAt: "2025-12-31T23:00:00.000Z" };

/** A valid input of each route for a target user. */
function inputOf(key: ToolKey, userId: string): Call {
  switch (key) {
    case "GET /operator/users":
      return { query: { limit: "100" } };
    case "GET /operator/users/search":
      return { query: { id: userId } };
    case "GET /operator/users/get":
      return { query: { userId } };
    case "GET /operator/audit":
      return { query: {} };
    case "POST /operator/users/ban":
    case "POST /operator/users/unban":
    case "POST /operator/sessions/end-user":
      return { body: { userId, reason: REASON } };
    case "POST /operator/users/platform-role":
      return { body: { userId, grant: true, reason: REASON } };
    case "POST /operator/users/second-factor/disable":
      return { body: { userId, reason: REASON, proof: PROOF } };
    case "POST /operator/users/create-admin":
      return { body: { email: "first.admin@example.com", reason: REASON } };
    case "POST /operator/sessions/end-all":
      return { body: { reason: REASON } };
  }
}

/** A bad input of each route: a query or a body that the contract schema or the engine refuses. */
function badInputsOf(key: ToolKey, userId: string): Call[] {
  switch (key) {
    case "GET /operator/users":
      return [{ query: { limit: "abc" } }, { query: { limit: "0" } }, { query: { bogus: "1" } }];
    case "GET /operator/users/search":
      return [{ query: {} }, { query: { id: userId, email: "ada@example.com" } }];
    case "GET /operator/users/get":
      return [{ query: {} }, { query: { userId: "" } }];
    case "GET /operator/audit":
      return [{ query: { limit: "101" } }, { query: { targetUserId: "" } }];
    default: {
      const valid = inputOf(key, userId);
      // An empty body, an unknown key, a reason with a line feed, and the valid body as a form.
      return [
        { body: {} },
        { body: { ...(valid.body as object), bogus: 1 } },
        { body: { ...(valid.body as object), reason: "a\nb" } },
        { ...valid, form: true },
      ];
    }
  }
}

/** The JSON body of a 200, held to the route's contract: the parse succeeds and changes nothing. */
async function fitted(key: ToolKey, res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  expect(res.status, `${key}: ${text}`).toBe(200);
  const body: unknown = JSON.parse(text);
  const answer = CONTRACT[key]?.answer;
  if (answer?.kind !== "json") throw new Error(`${key} has no JSON contract`);
  const parsed = answer.schema.safeParse(body);
  expect(parsed.success, `${key}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  expect(parsed.data, `${key}: the parse changed the answer`).toEqual(body);
  return body as Record<string, unknown>;
}

describe("the operator routes (plan 12f Task 10)", () => {
  it("lists the 12f routes in ROUTES with the feature operatorUsers and both credential forms", () => {
    const tagged = ROUTES.filter((r) => r.feature === "operatorUsers");
    expect(tagged.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      TOOL_ROUTES.map((r) => r.key).sort(),
    );
    for (const r of tagged)
      expect(r.auth, `${r.method} ${r.path}`).toEqual(["operator", "session"]);
  });

  it("answers 404 for every 12f route while operator.users is off", async () => {
    const off = await world({
      config: {
        operator: {
          secrets: [
            {
              name: "support",
              secretHash: await sha256Hex(OPERATOR_SECRETS.support),
              scopes: ["users", "sessions", "audit"],
            },
          ],
        },
      },
    });
    for (const { key } of TOOL_ROUTES)
      for (const headers of [SUPPORT, sessionHeaders(key, off.operator.cookie), {}]) {
        const res = await off.handle(request(key, { ...inputOf(key, off.rootId), headers }));
        expect(await answerOf(res), key).toEqual({ status: 404, code: "not_found" });
        expect(res.headers.get("cache-control"), key).toBe("no-store");
      }
  });

  it("answers 401 to a wrong secret, to no credential, and to two credentials", async () => {
    const w = await world();
    const cookie = w.operator.cookie;
    for (const { key } of TOOL_ROUTES) {
      const input = inputOf(key, w.rootId);
      const both = { ...SUPPORT, ...sessionHeaders(key, cookie) };
      // The scheme with no secret still names the operator credential, so with a cookie it is two.
      const schemeOnly = { authorization: "Operator", ...sessionHeaders(key, cookie) };
      for (const [name, headers] of [
        ["a wrong secret", WRONG],
        ["no credential", {}],
        ["a secret and a session", both],
        ["the scheme and a session", schemeOnly],
      ] as const) {
        const res = await w.handle(request(key, { ...input, headers }));
        expect(await answerOf(res), `${key}: ${name}`).toEqual({
          status: 401,
          code: "unauthorized",
        });
      }
    }
    // No act ran.
    expect(await w.auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });

  it("answers 403 to a secret without the route's scope", async () => {
    const w = await world();
    for (const { key, scope } of TOOL_ROUTES) {
      const input = inputOf(key, w.rootId);
      const keysOnly = await w.handle(request(key, { ...input, headers: KEYS }));
      expect(await answerOf(keysOnly), key).toEqual({ status: 403, code: "operator_required" });
      const auditOnly = await w.handle(request(key, { ...input, headers: AUDIT }));
      if (scope === "audit") expect(auditOnly.status, key).toBe(200);
      else
        expect(await answerOf(auditOnly), key).toEqual({ status: 403, code: "operator_required" });
    }
    expect(await w.auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });

  it("answers 403 to a session that fails a step of the operator user guard (spec 26 item 2)", async () => {
    const keys: string[] = [];
    const w = await world({
      config: {
        limiter: {
          allow: async (key: string) => {
            keys.push(key);
            return true;
          },
        },
      },
    });
    const name = w.auth.config.cookieName;
    const cookieOf = (token: string) => ({ cookie: `${name}=${token}` });
    const ada = await verifiedSession(w.auth, "ada@example.com");
    // A plain verified user: no platform role.
    const plain = await verifiedSession(w.auth, "plain@example.com");
    // A platform operator with no second factor: the secret grants the role to a verified user.
    const noFactor = await verifiedSession(w.auth, "nofactor@example.com");
    const granted = await w.handle(
      request("POST /operator/users/platform-role", {
        body: { userId: noFactor.user.id, grant: true, reason: REASON },
        headers: SUPPORT,
      }),
    );
    expect(granted.status).toBe(200);
    // A platform operator with an unverified address: a sign-up with no verify, then create-admin.
    const up = await passwordSignUp(w.auth.config, {
      email: "unverified@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    const admin = await w.handle(
      request("POST /operator/users/create-admin", {
        body: { email: "unverified@example.com", reason: REASON },
        headers: SUPPORT,
      }),
    );
    expect(await admin.json()).toMatchObject({ created: false });
    const cases: [string, Record<string, string>][] = [
      ["a plain verified user", cookieOf(plain.token)],
      ["a platform operator with no second factor", cookieOf(noFactor.token)],
      ["a platform operator with an unverified address", cookieOf(up.value.token)],
    ];
    const audit = async () => (await w.auth.storage.findMany("operatorAudit", [])).length;
    const state = async () => ({
      user: await w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: ada.user.id }]),
      sessions: (
        await w.auth.storage.findMany("session", [
          { field: "userId", op: "eq", value: ada.user.id },
        ])
      ).length,
      factor: await w.auth.storage.findOne("secondFactor", [
        { field: "userId", op: "eq", value: w.operator.userId },
      ]),
      members: await w.auth.storage.findMany("member", []),
      users: (await w.auth.storage.findMany("user", [])).length,
      all: (await w.auth.storage.findMany("session", [])).length,
    });
    const refusedAll = async (label: string, cookie: Record<string, string>) => {
      const rows = await audit();
      const before = await state();
      keys.length = 0;
      for (const { key } of TOOL_ROUTES) {
        const res = await w.handle(
          request(key, { ...inputOf(key, ada.user.id), headers: sessionHeaders(key, cookie) }),
        );
        expect(await answerOf(res), `${key}: ${label}`).toEqual({
          status: 403,
          code: "operator_required",
        });
      }
      // No act ran, nothing changed, and no operator key counted.
      expect(await audit(), label).toBe(rows);
      expect(await state(), label).toEqual(before);
      expect(
        keys.filter((k) => k.startsWith("operator")),
        label,
      ).toEqual([]);
    };
    for (const [label, cookie] of cases) await refusedAll(label, cookie);
    // A platform operator passes, and the call counts once on the user key.
    keys.length = 0;
    const passed = await w.handle(request("GET /operator/users", { headers: w.operator.cookie }));
    expect(passed.status).toBe(200);
    expect(keys.filter((k) => k.startsWith("operator"))).toEqual([
      `operator:user:${w.operator.userId}`,
    ]);
    // A session that is not fresh: the default window of session.freshMinutes is 1440 minutes.
    w.auth.clock.advance(1441 * 60_000);
    await refusedAll("a session that is not fresh", w.operator.cookie);
  });

  it("counts every secret call on its own key, and answers 429 at the 601st call of an hour", async () => {
    const w = await world();
    const users = "GET /operator/users";
    for (let i = 1; i <= 600; i++) {
      const res = await w.handle(request(users, { headers: WRONG }));
      if (res.status !== 401) throw new Error(`call ${i} answered ${res.status}`);
    }
    // The 601st call: a wrong secret and a right one both meet the limit, on every route.
    expect(await answerOf(await w.handle(request(users, { headers: WRONG })))).toEqual({
      status: 429,
      code: "rate_limited",
    });
    for (const { key } of TOOL_ROUTES) {
      const res = await w.handle(request(key, { ...inputOf(key, w.rootId), headers: SUPPORT }));
      expect(await answerOf(res), key).toEqual({ status: 429, code: "rate_limited" });
      expect(res.headers.get("cache-control"), key).toBe("no-store");
    }
    // Another IP has its own count.
    expect((await w.handle(request(users, { headers: SUPPORT, ip: "203.0.113.51" }))).status).toBe(
      200,
    );
    // keys/rotate keeps its own count of 5 per hour.
    expect((await w.handle(request("POST /operator/keys/rotate", { headers: KEYS }))).status).toBe(
      200,
    );
    // A platform operator counts on the user key, not on the IP key.
    expect((await w.handle(request(users, { headers: w.operator.cookie }))).status).toBe(200);
    // One hour later the IP counts from zero again.
    w.auth.clock.advance(3600_000);
    expect((await w.handle(request(users, { headers: SUPPORT }))).status).toBe(200);
  });

  it("holds a stolen secret to 600 calls per hour in total, from many addresses (ruling 38)", async () => {
    const w = await world();
    const users = "GET /operator/users";
    // One call from each of 600 addresses: no count per IP is near its limit.
    for (let i = 0; i < 600; i++) {
      const ip = `198.51.${Math.floor(i / 250)}.${i % 250}`;
      const res = await w.handle(request(users, { headers: SUPPORT, ip }));
      if (res.status !== 200) throw new Error(`call ${i + 1} answered ${res.status}`);
    }
    // The 601st call of the secret, from a new address, meets the count of the secret.
    const next = await w.handle(request(users, { headers: SUPPORT, ip: "198.51.9.1" }));
    expect(await answerOf(next)).toEqual({ status: 429, code: "rate_limited" });
    // Another secret has its own count, and a wrong secret matches no entry, so it counts on none.
    const audit = await w.handle(
      request("GET /operator/audit", { headers: AUDIT, ip: "198.51.9.2" }),
    );
    expect(audit.status).toBe(200);
    const wrong = await w.handle(request(users, { headers: WRONG, ip: "198.51.9.3" }));
    expect(await answerOf(wrong)).toEqual({ status: 401, code: "unauthorized" });
    // One hour later the secret counts from zero again.
    w.auth.clock.advance(3600_000);
    expect((await w.handle(request(users, { headers: SUPPORT, ip: "198.51.9.4" }))).status).toBe(
      200,
    );
  });

  it("fits a whole secret call of end-all with a hook and a full page in 50 calls (rulings 35 and 38)", async () => {
    const limited = { calls: 0 };
    const w = await world({
      config: {
        // The D1 limiter sends one statement per check.
        limiter: {
          allow: async () => {
            limited.calls++;
            return true;
          },
        },
        hooks: { session: { afterEnd: () => {} } },
      },
    });
    const user = (await verifiedSession(w.auth, "ada@example.com")).user;
    for (let i = 0; i < 60; i++)
      await openSession(w.auth.config, { user, ip: null, userAgent: null, via: "password" });
    // The D1 adapter checks the schema version with one query before the first call of an invocation.
    const SCHEMA_CHECK = 1;
    const sent = () => w.auth.storage.statementsSent?.() ?? 0;
    const start = sent();
    limited.calls = 0;
    const res = await w.handle(
      request("POST /operator/sessions/end-all", { body: { reason: REASON }, headers: SUPPORT }),
    );
    const body = (await res.json()) as { ended: number; more: boolean };
    // The two limiter checks and the schema check come before the act: 3, the reserve of a secret.
    // The work gets 46 calls: the read, the lock, the link read, and 43 deletes with the hook. The
    // audit row is the last call. Memory sends no lock, so the whole call makes 49; an adapter that sends it makes 50.
    expect({
      limiter: limited.calls,
      total: sent() - start + limited.calls + SCHEMA_CHECK,
      ended: body.ended,
      more: body.more,
    }).toEqual({ limiter: 2, total: 49, ended: 43, more: true });
  });

  it("serves each route to a secret with its scope and to a platform operator", async () => {
    const w = await world();
    const ada = (await verifiedSession(w.auth, "ada@example.com")).user.id;
    const bob = (await verifiedSession(w.auth, "bob@example.com")).user.id;
    const carol = (await enrolled(w.auth, "carol@example.com")).user.id;
    const dave = (await verifiedSession(w.auth, "dave@example.com")).user.id;
    const erin = (await enrolled(w.auth, "erin@example.com")).user.id;
    const asOperator = (key: ToolKey, call: Call) =>
      w.handle(request(key, { ...call, headers: sessionHeaders(key, w.operator.cookie) }));
    const asSecret = (key: ToolKey, call: Call) =>
      w.handle(request(key, { ...call, headers: SUPPORT }));
    const answered: string[] = [];

    for (const [actor, send, target, targetEmail, factor] of [
      ["user", asOperator, ada, "ada@example.com", carol],
      ["secret", asSecret, dave, "dave@example.com", erin],
    ] as const) {
      // The clock moves 1 ms before each call, so the ULID ids of the rows sort in the order of the writes.
      const run = async (key: ToolKey, call: Call) => {
        answered.push(`${actor} ${key}`);
        w.auth.clock.advance(1);
        return fitted(key, await send(key, call));
      };
      // A ban with no end; the three reads then show it.
      const at = new Date(w.auth.clock.now().getTime() + 1).toISOString();
      expect(
        await run("POST /operator/users/ban", { body: { userId: target, reason: REASON } }),
      ).toEqual({ auditId: expect.any(String) });
      const list = await run("GET /operator/users", { query: { limit: "100" } });
      const listed = (list.users as { id: string; ban: unknown }[]).find((u) => u.id === target);
      expect(listed?.ban).toEqual({ at, reason: REASON, until: null });
      expect(list.next).toBeNull();
      const found = await run("GET /operator/users/search", { query: { id: target } });
      expect((found.users as { id: string }[]).map((u) => u.id)).toEqual([target]);
      const one = await run("GET /operator/users/get", { query: { userId: target } });
      expect((one.user as { id: string; ban: unknown }).ban).toEqual({
        at,
        reason: REASON,
        until: null,
      });
      await run("POST /operator/users/unban", { body: { userId: target, reason: REASON } });
      // The ban ended every session; the target signs in again after the unban.
      await verifiedSession(w.auth, targetEmail);
      // The user actor grants bob the role; the secret then revokes it.
      await run("POST /operator/users/platform-role", {
        body: { userId: bob, grant: actor === "user", reason: REASON },
      });
      await run("POST /operator/users/second-factor/disable", {
        body: { userId: factor, reason: REASON, proof: PROOF },
      });
      expect(
        await w.auth.storage.findOne("secondFactor", [
          { field: "userId", op: "eq", value: factor },
        ]),
      ).toBeNull();
      expect(
        await run("POST /operator/sessions/end-user", { body: { userId: target, reason: REASON } }),
      ).toEqual({ ended: 1, more: false, auditId: expect.any(String) });
      if (actor === "secret")
        expect(
          await run("POST /operator/users/create-admin", {
            body: { email: "first.admin@example.com", reason: REASON },
          }),
        ).toEqual({ userId: expect.any(String), created: true, auditId: expect.any(String) });
      expect(await run("POST /operator/sessions/end-all", { body: { reason: REASON } })).toEqual({
        ended: expect.any(Number),
        more: false,
        auditId: expect.any(String),
      });
      // The end of all sessions keeps the session of a user actor.
      if (actor === "user") expect((await asOperator("GET /operator/users", {})).status).toBe(200);
      await run("GET /operator/audit", { query: {} });
    }
    // Every route for the secret; all but create-admin (a secret only) for the platform operator.
    expect(answered.filter((a) => a.startsWith("secret ")).length).toBe(11);
    expect(answered.filter((a) => a.startsWith("user ")).length).toBe(10);

    // The audit route lists the rows the writes made, oldest first, with the caller's IP and agent.
    const audit = await fitted(
      "GET /operator/audit",
      await asSecret("GET /operator/audit", { query: { limit: "100" } }),
    );
    type Row = {
      actorKind: string;
      actorId: string;
      action: string;
      targetUserId: string | null;
      ip: string | null;
      userAgent: string | null;
    };
    const rows = audit.rows as Row[];
    const op = w.operator.userId;
    expect(rows.map((r) => [r.actorKind, r.actorId, r.action, r.targetUserId])).toEqual([
      ["user", op, "ban", ada],
      ["user", op, "unban", ada],
      ["user", op, "platform_role_grant", bob],
      ["user", op, "second_factor_disable", carol],
      ["user", op, "sessions_end_user", ada],
      ["user", op, "sessions_end_all", null],
      ["secret", "support", "ban", dave],
      ["secret", "support", "unban", dave],
      ["secret", "support", "platform_role_revoke", bob],
      ["secret", "support", "second_factor_disable", erin],
      ["secret", "support", "sessions_end_user", dave],
      ["secret", "support", "create_admin", expect.any(String)],
      ["secret", "support", "sessions_end_all", null],
    ]);
    for (const r of rows) expect([r.ip, r.userAgent]).toEqual([IP, AGENT]);
    expect(audit.next).toBeNull();
    // A call with no IP and no agent writes both as null; the filter reads one user's rows.
    w.auth.clock.advance(1);
    await fitted(
      "POST /operator/users/unban",
      await w.handle(
        request("POST /operator/users/unban", {
          body: { userId: ada, reason: REASON },
          headers: SUPPORT,
          ip: null,
        }),
      ),
    );
    const adaRows = await fitted(
      "GET /operator/audit",
      await asSecret("GET /operator/audit", { query: { targetUserId: ada } }),
    );
    expect((adaRows.rows as Row[]).map((r) => [r.action, r.ip, r.userAgent])).toEqual([
      ["ban", IP, AGENT],
      ["unban", IP, AGENT],
      ["sessions_end_user", IP, AGENT],
      ["unban", null, null],
    ]);
  });

  it("refuses create-admin to a session caller", async () => {
    const w = await world();
    const key = "POST /operator/users/create-admin";
    const res = await w.handle(
      request(key, { ...inputOf(key, w.rootId), headers: sessionHeaders(key, w.operator.cookie) }),
    );
    expect(await answerOf(res)).toEqual({ status: 403, code: "operator_required" });
    expect(
      await w.auth.storage.findOne("user", [
        { field: "email", op: "eq", value: "first.admin@example.com" },
      ]),
    ).toBeNull();
    expect(await w.auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });

  it("answers no-store on every operator answer", async () => {
    const w = await world();
    const ada = (await verifiedSession(w.auth, "ada@example.com")).user.id;
    const statuses = new Set<number>();
    for (const { key } of TOOL_ROUTES)
      for (const call of [
        { ...inputOf(key, ada), headers: SUPPORT },
        { ...inputOf(key, ada), headers: sessionHeaders(key, w.operator.cookie) },
        { ...inputOf(key, ada), headers: KEYS },
        { ...inputOf(key, ada), headers: WRONG },
        { ...badInputsOf(key, ada)[0], headers: SUPPORT },
      ]) {
        const res = await w.handle(request(key, call));
        statuses.add(res.status);
        expect(res.headers.get("cache-control"), `${key} ${res.status}`).toBe("no-store");
      }
    // 200, 400, 401, and 403 here; the 404 and the 429 tests read the header too.
    expect([...statuses].sort()).toEqual([200, 400, 401, 403]);
  });

  it("answers invalid_body to a bad query or body on each route", async () => {
    const w = await world();
    const ada = (await verifiedSession(w.auth, "ada@example.com")).user.id;
    for (const { key } of TOOL_ROUTES)
      for (const call of badInputsOf(key, ada)) {
        const res = await w.handle(request(key, { ...call, headers: SUPPORT }));
        expect(await answerOf(res), `${key} ${JSON.stringify(call)}`).toEqual({
          status: 400,
          code: "invalid_body",
        });
      }
    // A repeated query key: the schema never sees a silent first or last value.
    for (const key of ["GET /operator/users", "GET /operator/audit"] as const) {
      const req = request(key, { headers: SUPPORT });
      const url = new URL(req.url);
      url.searchParams.append("limit", "10");
      url.searchParams.append("limit", "20");
      expect(await answerOf(await w.handle(new Request(url, req))), key).toEqual({
        status: 400,
        code: "invalid_body",
      });
    }
    expect(await w.auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });

  it("renews the session cookie of a platform operator after a sliding refresh", async () => {
    const w = await world({ config: { session: { slidingRefreshDays: 0.25 } } });
    const name = w.auth.config.cookieName;
    // Seven hours on: the refresh of 6 hours is due, and the window of 24 hours keeps the session fresh.
    w.auth.clock.advance(7 * 3600_000);
    for (const key of ["GET /operator/users", "POST /operator/sessions/end-all"] as const) {
      const res = await w.handle(
        request(key, {
          ...inputOf(key, w.rootId),
          headers: sessionHeaders(key, w.operator.cookie),
        }),
      );
      expect(res.status, key).toBe(200);
      expect(
        res.headers.getSetCookie().some((c) => c.startsWith(`${name}=`)),
        key,
      ).toBe(true);
      w.auth.clock.advance(7 * 3600_000);
    }
    // A secret caller gets no cookie.
    const secretCall = await w.handle(request("GET /operator/users", { headers: SUPPORT }));
    expect(secretCall.headers.getSetCookie()).toEqual([]);
  });

  it("refuses a cross-site form post of a session caller", async () => {
    const w = await world();
    const ada = (await verifiedSession(w.auth, "ada@example.com")).user.id;
    for (const key of WRITES) {
      // No Origin: the Fetch Metadata rule of plan 12b refuses the form.
      const res = await w.handle(
        request(key, {
          ...inputOf(key, ada),
          form: true,
          headers: { ...w.operator.cookie, "sec-fetch-site": "cross-site" },
        }),
      );
      expect(await answerOf(res), key).toEqual({ status: 403, code: "origin_not_trusted" });
    }
    expect(await w.auth.storage.findMany("operatorAudit", [])).toEqual([]);
    expect(
      (await w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: ada }]))?.bannedAt,
    ).toBeNull();
  });

  it("answers the refusals of each write through the router", async () => {
    const w = await world({
      config: {
        organizations: {
          platformRole: "operator",
          platformOrganization: "platform-co",
          ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
          // Root and the operator fill the platform organization.
          limits: { membersPerOrganization: 2 },
        },
      },
    });
    const ada = await verifiedSession(w.auth, "ada@example.com");
    const bob = (await verifiedSession(w.auth, "bob@example.com")).user.id;
    const asOperator = (key: WriteKey, body: unknown) =>
      w.handle(request(key, { body, headers: sessionHeaders(key, w.operator.cookie) }));
    const asSecret = (key: WriteKey, body: unknown) =>
      w.handle(request(key, { body, headers: SUPPORT }));
    // A user actor never acts on their own user.
    const self = w.operator.userId;
    for (const key of [
      "POST /operator/users/ban",
      "POST /operator/users/unban",
      "POST /operator/users/platform-role",
      "POST /operator/users/second-factor/disable",
      "POST /operator/sessions/end-user",
    ] as const)
      expect(await answerOf(await asOperator(key, inputOf(key, self).body)), key).toEqual({
        status: 409,
        code: "operator_self",
      });
    // A user actor never acts on another platform operator.
    expect(
      await answerOf(
        await asOperator("POST /operator/users/ban", { userId: w.rootId, reason: REASON }),
      ),
    ).toEqual({ status: 403, code: "operator_required" });
    // The grant needs a verified address: a sign-up with no verify.
    const up = await passwordSignUp(w.auth.config, {
      email: "new@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const fresh = await w.auth.storage.findOne("user", [
      { field: "email", op: "eq", value: "new@example.com" },
    ]);
    expect(
      await answerOf(
        await asSecret("POST /operator/users/platform-role", {
          userId: fresh?.id,
          grant: true,
          reason: REASON,
        }),
      ),
    ).toEqual({ status: 403, code: "email_unverified" });
    // A full platform organization takes no new member.
    expect(
      await answerOf(
        await asSecret("POST /operator/users/platform-role", {
          userId: bob,
          grant: true,
          reason: REASON,
        }),
      ),
    ).toEqual({ status: 409, code: "member_limit" });
    expect(
      await answerOf(
        await asSecret("POST /operator/users/create-admin", {
          email: "first.admin@example.com",
          reason: REASON,
        }),
      ),
    ).toEqual({ status: 409, code: "member_limit" });
    // The factor is off.
    expect(
      await answerOf(
        await asSecret("POST /operator/users/second-factor/disable", {
          userId: bob,
          reason: REASON,
          proof: PROOF,
        }),
      ),
    ).toEqual({ status: 400, code: "totp_not_enabled" });
    // A banned user gets no role and no admin row.
    expect(
      (await asSecret("POST /operator/users/ban", { userId: ada.user.id, reason: REASON })).status,
    ).toBe(200);
    expect(
      await answerOf(
        await asSecret("POST /operator/users/platform-role", {
          userId: ada.user.id,
          grant: true,
          reason: REASON,
        }),
      ),
    ).toEqual({ status: 403, code: "account_banned" });
    expect(
      await answerOf(
        await asSecret("POST /operator/users/create-admin", {
          email: "ada@example.com",
          reason: REASON,
        }),
      ),
    ).toEqual({ status: 403, code: "account_banned" });
    // The one ban is the only row.
    expect((await w.auth.storage.findMany("operatorAudit", [])).map((r) => r.action)).toEqual([
      "ban",
    ]);
  });

  it("answers last_owner to a revoke that leaves the platform organization with no owner", async () => {
    // No operator member: root is the one owner.
    const w = await world({ role: null });
    const root = await w.auth.storage.findOne("user", [{ field: "id", op: "eq", value: w.rootId }]);
    if (!root) throw new Error("no root");
    // Root leaves the owner part. The operator rank (5) is above the owner rank (4).
    const moved = await updateMemberRole(w.auth.config, {
      user: root,
      organizationId: "org-platform",
      userId: root.id,
      role: "operator",
    });
    if (!moved.ok) throw new Error(moved.code);
    const res = await w.handle(
      request("POST /operator/users/platform-role", {
        body: { userId: root.id, grant: false, reason: REASON },
        headers: SUPPORT,
      }),
    );
    expect(await answerOf(res)).toEqual({ status: 409, code: "last_owner" });
    expect(await w.auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });

  it("answers hook_refused and hook_failed of hooks.operator.beforeAction on each write", async () => {
    let mode: "refuse" | "throw" = "refuse";
    const w = await world({
      config: {
        hooks: {
          operator: {
            beforeAction() {
              if (mode === "refuse") throw hookRefusal("Not in the change window.");
              throw new Error("the change system is down");
            },
          },
        },
      },
    });
    const ada = (await verifiedSession(w.auth, "ada@example.com")).user.id;
    for (const [m, answer] of [
      ["refuse", { status: 403, code: "hook_refused" }],
      ["throw", { status: 500, code: "hook_failed" }],
    ] as const) {
      mode = m;
      for (const key of WRITES) {
        const res = await w.handle(request(key, { ...inputOf(key, ada), headers: SUPPORT }));
        expect(await answerOf(res), `${key} ${m}`).toEqual(answer);
      }
    }
    expect(await w.auth.storage.findMany("operatorAudit", [])).toEqual([]);
  });
});
