import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AuthConfig,
  ConfigError,
  type OperatorConfig,
  type OperatorScope,
  type ResolvedOperator,
  resolveConfig,
} from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { requireScope } from "../src/engine/operator/guards.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";

const SECRET = "operator-secret-0123456789abcdef-0123456789";
const HASH = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PLATFORM = {
  organizations: {
    platformRole: "operator",
    platformOrganization: "platform-co",
    ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
  },
} satisfies Partial<AuthConfig>;

const base = {
  baseURL: "https://api.example.com",
  secret: "0123456789abcdef0123456789abcdef",
  trustedOrigins: [],
  storage: createMemoryAdapter(),
  mail: { send: async () => {} },
};

/** One app with an operator block, on one storage, clock, and limiter. */
function operatorApp(operator: OperatorConfig, extra: Partial<AuthConfig> = {}) {
  const engine = makeAuth();
  return createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: engine.storage,
    mail: { send: async () => {} },
    clock: engine.clock,
    limiter: engine.config.limiter,
    operator,
    ...extra,
  });
}

/** A call of one operator route from one IP with `Operator <secret>`. */
function call(method: "GET" | "POST", path: string, secret: string) {
  return new Request(`${BASE_URL}/auth${path}`, {
    method,
    headers: {
      "cf-connecting-ip": "203.0.113.40",
      authorization: `Operator ${secret}`,
      ...(method === "POST" ? { "content-type": "application/json", origin: APP_ORIGIN } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}

const ROUTES = [
  ["POST", "/operator/keys/rotate", "keys"],
  ["GET", "/operator/secrets/status", "secrets"],
  ["POST", "/operator/secrets/rewrap", "secrets"],
  ["GET", "/operator/info", null],
] as const;

describe("the operator config of plan 12f", () => {
  it("gives the 11c secret the keys and secrets scopes only", async () => {
    const resolved = resolveConfig({
      ...base,
      ...PLATFORM,
      operator: { secretHash: HASH, users: true },
    }).operator;
    expect(resolved?.secrets).toEqual([
      { name: "default", secretHash: HASH, scopes: ["keys", "secrets"] },
    ]);
    expect(resolved?.users).toBe(true);
    const entry = resolved?.secrets[0];
    if (!entry) throw new Error("no entry");
    const actor = { kind: "secret", name: entry.name, scopes: entry.scopes } as const;
    expect(requireScope(actor, "users")).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
    expect(requireScope(actor, "keys")).toEqual({ ok: true, value: true });
    // The 11c secret still opens each route of 11c and 11c2 (ruling 17).
    const app = operatorApp({ secretHash: await sha256Hex(SECRET), users: true }, PLATFORM);
    for (const [method, path] of ROUTES)
      expect((await app.handle(call(method, path, SECRET))).status, path).toBe(200);
  });

  it("answers 403 operator_required to a named secret with no scope for the route", async () => {
    const usersOnly = "operator-users-0123456789abcdef-0123456";
    const keysOnly = "operator-keysonly-0123456789abcdef-0123";
    const app = operatorApp({
      secrets: [
        { name: "support", secretHash: await sha256Hex(usersOnly), scopes: ["users"] },
        { name: "rotate", secretHash: await sha256Hex(keysOnly), scopes: ["keys"] },
      ],
      users: true,
    });
    for (const [method, path, scope] of ROUTES) {
      const refused = await app.handle(call(method, path, usersOnly));
      // The info route gives no value, so any entry opens it.
      expect(refused.status, path).toBe(scope === null ? 200 : 403);
      if (scope !== null) expect(await refused.json()).toEqual({ error: "operator_required" });
    }
    expect((await app.handle(call("POST", "/operator/keys/rotate", keysOnly))).status).toBe(200);
    expect((await app.handle(call("GET", "/operator/secrets/status", keysOnly))).status).toBe(403);
    const wrong = await app.handle(
      call("GET", "/operator/info", "operator-wrong-0123456789abcdef-0123456"),
    );
    expect(wrong.status).toBe(401);
  });

  const entry = (name: string, secretHash = HASH, scopes: OperatorScope[] = ["users"]) => ({
    name,
    secretHash,
    scopes,
  });
  const refusals: [string, unknown, Partial<AuthConfig>, string][] = [
    [
      "both secret keys",
      { secretHash: HASH, secrets: [entry("a")] },
      {},
      "operator.secretHash and operator.secrets are both set",
    ],
    ["an empty secret list", { secrets: [] }, {}, "operator.secrets must list one entry"],
    ["a name with a capital", { secrets: [entry("Support")] }, {}, "operator.secrets[].name"],
    [
      "a name of 33 characters",
      { secrets: [entry("a".repeat(33))] },
      {},
      "operator.secrets[].name",
    ],
    ["a name that starts with -", { secrets: [entry("-a")] }, {}, "operator.secrets[].name"],
    [
      "two entries with one name",
      { secrets: [entry("a"), entry("a", HASH_B)] },
      {},
      "operator.secrets[].name must be unique",
    ],
    [
      "two entries with one hash",
      { secrets: [entry("a"), entry("b")] },
      {},
      "operator.secrets[].secretHash must be unique",
    ],
    [
      "an unknown scope",
      { secrets: [entry("a", HASH, ["users", "admin"] as never)] },
      {},
      "operator.secrets[].scopes",
    ],
    ["an empty scope list", { secrets: [entry("a", HASH, [])] }, {}, "operator.secrets[].scopes"],
    [
      "a hash in capitals",
      { secrets: [entry("a", "A".repeat(64))] },
      {},
      "operator.secrets[].secretHash must be the SHA-256",
    ],
    [
      "a hash of 63 characters",
      { secrets: [entry("a", "a".repeat(63))] },
      {},
      "operator.secrets[].secretHash must be the SHA-256",
    ],
    [
      "another key in an entry",
      { secrets: [{ ...entry("a"), secret: "x" }] },
      {},
      "operator.secrets[].secret is not an option",
    ],
    [
      "impersonation without users",
      { secretHash: HASH, impersonation: {} },
      PLATFORM,
      "operator.impersonation needs operator.users",
    ],
    [
      "impersonation without the platform role",
      { secrets: [entry("a")], users: true, impersonation: {} },
      {},
      "operator.impersonation needs organizations.platformRole",
    ],
    [
      "ttlMinutes of 4",
      { secretHash: HASH, users: true, impersonation: { ttlMinutes: 4 } },
      PLATFORM,
      "operator.impersonation.ttlMinutes",
    ],
    [
      "ttlMinutes of 241",
      { secretHash: HASH, users: true, impersonation: { ttlMinutes: 241 } },
      PLATFORM,
      "operator.impersonation.ttlMinutes",
    ],
    [
      "ttlMinutes of 60.5",
      { secretHash: HASH, users: true, impersonation: { ttlMinutes: 60.5 } },
      PLATFORM,
      "operator.impersonation.ttlMinutes",
    ],
    [
      "a notice that is not a boolean",
      { secretHash: HASH, users: true, impersonation: { notice: "yes" } },
      PLATFORM,
      "operator.impersonation.notice",
    ],
    [
      "another key of impersonation",
      { secretHash: HASH, users: true, impersonation: { ttl: 5 } },
      PLATFORM,
      "operator.impersonation.ttl is not an option",
    ],
    [
      "users that is not true",
      { secretHash: HASH, users: false },
      PLATFORM,
      "operator.users must be true",
    ],
    [
      "users with no actor: no users scope and no platform role",
      { secrets: [entry("a", HASH, ["keys", "audit"])], users: true },
      {},
      "operator.users needs",
    ],
    ["users with no secret and no platform role", { users: true }, {}, "operator.users needs"],
    [
      "users with the 11c secret and no platform role",
      { secretHash: HASH, users: true },
      {},
      "operator.users needs",
    ],
  ];

  it.each(refusals)(
    "refuses each bad operator config with a text that names the key: %s",
    (_, operator, extra, text) => {
      let thrown: unknown = null;
      try {
        resolveConfig({ ...base, ...extra, operator: operator as never });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message).toContain(text);
    },
  );

  it("turns the user tools on only on request", () => {
    const off = resolveConfig({ ...base, operator: { secrets: [entry("a", HASH, ["keys"])] } });
    expect(off.operator).toEqual({
      secrets: [{ name: "a", secretHash: HASH, scopes: ["keys"] }],
      users: false,
      impersonation: null,
      // Plan 12f2 Task 3: the invitation life, 72 hours by default.
      invite: { ttlHours: 72 },
    });
    const on = resolveConfig({
      ...base,
      ...PLATFORM,
      operator: { secrets: [entry("a", HASH, ["keys"])], users: true, impersonation: {} },
    });
    expect(on.operator?.users).toBe(true);
    expect(on.operator?.impersonation).toEqual({ ttlMinutes: 60, notice: true });
    const set = resolveConfig({
      ...base,
      ...PLATFORM,
      operator: { secretHash: HASH, users: true, impersonation: { ttlMinutes: 5, notice: false } },
    });
    expect(set.operator?.impersonation).toEqual({ ttlMinutes: 5, notice: false });
    // A secret with the users scope is an actor with no platform role.
    const secretOnly = resolveConfig({
      ...base,
      operator: { secrets: [entry("a", HASH, ["users"])], users: true },
    });
    expect(secretOnly.operator?.users).toBe(true);
  });

  it("accepts the user tools with a platform role and no secret", async () => {
    // Spec 26 item 3 and the plan ask for an actor, not a secret (ruling 21).
    const resolved = resolveConfig({ ...base, ...PLATFORM, operator: { users: true } });
    expect(resolved.operator).toEqual({
      secrets: [],
      users: true,
      impersonation: null,
      invite: { ttlHours: 72 },
    });
    // With no secret entry the secret routes are a tool that is off. They answer 404, as a
    // path that does not exist (ruling 22 of plan 12f, spec 26 item 7).
    const app = operatorApp({ users: true }, PLATFORM);
    for (const [method, path] of ROUTES) {
      const res = await app.handle(call(method, path, SECRET));
      expect({ status: res.status, body: await res.json() }, path).toEqual({
        status: 404,
        body: { error: "not_found" },
      });
    }
  });

  it("freezes the scope list of each resolved secret", () => {
    expectTypeOf<ResolvedOperator["secrets"][number]["scopes"]>().toEqualTypeOf<
      readonly OperatorScope[]
    >();
    const named = resolveConfig({ ...base, operator: { secrets: [entry("a", HASH, ["audit"])] } });
    const legacy = resolveConfig({ ...base, operator: { secretHash: HASH_B } });
    for (const resolved of [named, legacy]) {
      const scopes = resolved.operator?.secrets[0]?.scopes;
      if (!scopes) throw new Error("no entry");
      const before = [...scopes];
      // @ts-expect-error: the resolved scope list is readonly.
      expect(() => scopes.push("users")).toThrow(TypeError);
      expect(scopes).toEqual(before);
    }
    expect(named.operator?.secrets[0]?.scopes).toEqual(["audit"]);
    expect(legacy.operator?.secrets[0]?.scopes).toEqual(["keys", "secrets"]);
  });
});
