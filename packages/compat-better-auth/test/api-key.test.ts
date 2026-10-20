import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createAccessControl, defaultStatements } from "../src/access.js";
import { apiKey } from "../src/api-key.js";
import { apiKeyClient } from "../src/client/api-key.js";
import { createAuthClient } from "../src/client/index.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, organization } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import type { ApiKeyOptions, BetterAuthOptions, CompatDatabase } from "../src/types.js";

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
const PASSWORD = "correct horse battery";
const KEY_ACTIONS = ["create", "read", "update", "delete"] as const;

const memory = (): CompatDatabase => ({
  kind: "authtempo-compat-database",
  dialect: "postgres",
  storage: createMemoryAdapter(),
  limiter: createMemoryLimiter(systemClock),
});

/** consumerb's organization access control (apps/api/src/auth.ts at f4518c7, read 2026-10-21). */
function consumerbOrganization() {
  const ac = createAccessControl({ ...defaultStatements, apiKey: KEY_ACTIONS });
  return organization({
    creatorRole: "owner",
    requireEmailVerificationOnInvitation: true,
    ac,
    roles: {
      owner: ac.newRole({ ...defaultStatements, apiKey: [...KEY_ACTIONS] }),
      admin: ac.newRole({ ...defaultStatements, apiKey: [...KEY_ACTIONS] }),
      member: ac.newRole({ apiKey: [] }),
      viewer: ac.newRole({ apiKey: [] }),
    },
    sendInvitationEmail: async () => {},
  });
}

/** consumerb's apiKey options, as its auth.ts passes them. */
const CONSUMER_B_KEYS: ApiKeyOptions = {
  defaultPrefix: "laaa_",
  enableMetadata: true,
  references: "organization",
  enableSessionForAPIKeys: false,
  rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
};

function options(keys: ApiKeyOptions, database: CompatDatabase = memory()): BetterAuthOptions {
  return {
    baseURL: BASE,
    basePath: "/api/auth",
    secret: SECRET,
    trustedOrigins: [],
    database,
    plugins: [consumerbOrganization(), apiKey(keys)],
    authtempo: { roleRanks: { viewer: 1, member: 2, admin: 3, owner: 4 } },
  };
}

/** A shim app with passwords, so a test signs people up as an app does. */
function app(keys: ApiKeyOptions) {
  const mails: { email: string; token: string }[] = [];
  const auth = betterAuth({
    ...options(keys),
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async (d) => void mails.push({ email: d.user.email, token: d.token }),
    },
    plugins: [bearer(), consumerbOrganization(), apiKey(keys)],
    authtempo: {
      roleRanks: { viewer: 1, member: 2, admin: 3, owner: 4 },
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  });
  const person = async (email: string) => {
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
    const link = mails.findLast((m) => m.email === email);
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/password/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
        body: new URLSearchParams({ token: link?.token ?? "" }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    const token = (await auth.api.signInEmail({ body: { email, password: PASSWORD } })).token;
    const caller = await auth.tempo.caller(
      new Request(BASE, { headers: { authorization: `Bearer ${token}` } }),
    );
    if (caller?.kind !== "session") throw new Error(`no session caller for ${email}`);
    return { token, user: caller.user };
  };
  return { auth, person };
}

describe("the api-key shim (spec 29 item 20, plan 12k Task 12)", () => {
  it("constructs consumerb's apiKey options with no refusal", () => {
    const o = options(CONSUMER_B_KEYS);
    expect(checkOptions(o).refusals).toEqual([]);
    expect(() => betterAuth(o)).not.toThrow();
    const config = mapOptions(o).config;
    expect(config.tokens).toEqual({
      defaultRateLimit: { seconds: 60, max: 600 },
      movedPrefixes: ["laaa_"],
    });
    // Better Auth's apiKey:delete is core's apiToken:revoke (role-map.ts).
    const org = config.organizations;
    if (!org) throw new Error("no organizations config");
    expect(org.roles?.owner?.permissions.apiToken).toEqual(["create", "read", "update", "revoke"]);
  });

  it("refuses enableSessionForAPIKeys true, disableKeyHashing true, and a custom generator", () => {
    const refusals = checkOptions(
      options({
        enableSessionForAPIKeys: true,
        disableKeyHashing: true,
        customKeyGenerator: () => "k",
      }),
    ).refusals;
    expect(refusals).toEqual([
      "plugins[api-key].customKeyGenerator: core makes each key from 32 random bytes (spec 29 item 20)",
      "plugins[api-key].disableKeyHashing: core keeps the SHA-256 of a key, never the key (spec 29 item 20)",
      "plugins[api-key].enableSessionForAPIKeys: a key never acts as a session, spec 8.8 item 6",
    ]);
    expect(() => betterAuth(options({ enableSessionForAPIKeys: true }))).toThrowError(
      /a key never acts as a session, spec 8\.8 item 6/,
    );
  });

  it("creates an organization key with no permissions and verifies it with valid true", async () => {
    const { auth, person } = app(CONSUMER_B_KEYS);
    const ada = await person("ada@example.com");
    const org = await auth.tempo.api.createOrganization({
      user: ada.user,
      slug: "acme",
      name: "Acme",
    });
    if (!org.ok) throw new Error(org.code);
    const organizationId = org.value.organization.id;
    const metadata = { organizationId, createdByUserId: ada.user.id, role: "owner" };
    // consumerb's server call: no headers, the creator in userId (routes/api-keys.ts).
    const created = await auth.api.createApiKey({
      body: {
        name: "ci",
        prefix: "laaa_",
        userId: ada.user.id,
        organizationId,
        metadata,
        rateLimitEnabled: true,
        rateLimitTimeWindow: 60_000,
        rateLimitMax: 600,
        expiresIn: 30 * 86_400,
      },
    });
    expect(created.key.startsWith("to_")).toBe(true);
    expect(created.permissions).toEqual({});
    expect(created.referenceId).toBe(organizationId);
    const v = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect({ valid: v.valid, error: v.error, id: v.key?.id, metadata: v.key?.metadata }).toEqual({
      valid: true,
      error: null,
      id: created.id,
      metadata,
    });
    expect(v.key?.rateLimitTimeWindow).toBe(60_000);
  });

  it("maps the plugin rateLimit onto the default window and answers RATE_LIMITED over it", async () => {
    const { auth, person } = app({
      references: "user",
      rateLimit: { timeWindow: 60_000, maxRequests: 2 },
    });
    const ada = await person("ada@example.com");
    const { key } = await auth.api.createApiKey({ body: { name: "ci", userId: ada.user.id } });
    expect((await auth.api.verifyApiKey({ body: { key } })).valid).toBe(true);
    expect((await auth.api.verifyApiKey({ body: { key } })).valid).toBe(true);
    expect(await auth.api.verifyApiKey({ body: { key } })).toEqual({
      valid: false,
      error: { code: "RATE_LIMITED", message: "Rate limit exceeded." },
      key: null,
    });
  });

  it("spends remaining and answers the usage code at zero", async () => {
    const { auth, person } = app({ rateLimit: { enabled: false } });
    const ada = await person("ada@example.com");
    const created = await auth.api.createApiKey({
      body: { name: "ci", userId: ada.user.id, remaining: 2 },
    });
    expect(created.remaining).toBe(2);
    expect((await auth.api.verifyApiKey({ body: { key: created.key } })).key?.remaining).toBe(1);
    expect((await auth.api.verifyApiKey({ body: { key: created.key } })).key?.remaining).toBe(0);
    expect(await auth.api.verifyApiKey({ body: { key: created.key } })).toEqual({
      valid: false,
      error: { code: "USAGE_EXCEEDED", message: "API Key has reached its usage limit" },
      key: null,
    });
    // A client with headers may not set the quota (dist/index.mjs:734).
    const signedIn = new Headers({
      authorization: `Bearer ${(await person("bo@example.com")).token}`,
    });
    await expect(
      auth.api.createApiKey({ body: { name: "ci", remaining: 5 }, headers: signedIn }),
    ).rejects.toMatchObject({ body: { code: "SERVER_ONLY_PROPERTY" } });
  });

  it("serves core's /tokens routes in the shim", async () => {
    const { auth, person } = app({ references: "user" });
    const ada = await person("ada@example.com");
    const call = (method: string, path: string, token: string, body?: unknown) =>
      auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            origin: BASE,
            "content-type": "application/json",
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      );
    const made = await call("POST", "/tokens", ada.token, { name: "cli" });
    expect(made.status).toBe(200);
    const { token, apiToken } = (await made.json()) as { token: string; apiToken: { id: string } };
    expect(token.startsWith("tk_")).toBe(true);
    const current = await call("GET", "/tokens/current", token);
    expect(current.status).toBe(200);
    expect(((await current.json()) as { user: { id: string } }).user.id).toBe(ada.user.id);
    const list = await call("GET", "/tokens", ada.token);
    expect(((await list.json()) as { tokens: unknown[] }).tokens).toHaveLength(1);
    expect((await call("POST", "/tokens/revoke", ada.token, { id: apiToken.id })).status).toBe(200);
    expect((await call("GET", "/tokens/current", token)).status).toBe(401);
  });

  it("creates, lists, gets, updates, and deletes a key through authClient.apiKey", async () => {
    const { auth, person } = app({ references: "user" });
    const ada = await person("ada@example.com");
    const client = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [apiKeyClient()],
      fetchOptions: {
        customFetchImpl: async (input, init) => auth.handler(new Request(input, init)),
        headers: { authorization: `Bearer ${ada.token}` },
      },
    });
    const created = await client.apiKey.create({ name: "laptop", expiresIn: 30 * 86_400 });
    expect(created.error).toBeNull();
    const id = created.data?.id ?? "";
    expect(created.data?.key.startsWith("tk_")).toBe(true);
    expect((await client.apiKey.list()).data?.map((k) => k.id)).toEqual([id]);
    expect((await client.apiKey.get({ query: { id } })).data?.name).toBe("laptop");
    expect((await client.apiKey.update({ keyId: id, name: "desk" })).data?.name).toBe("desk");
    expect((await client.apiKey.create({ name: "x", remaining: 3 })).error?.code).toBe(
      "SERVER_ONLY_PROPERTY",
    );
    expect((await client.apiKey.delete({ keyId: id })).data).toEqual({ success: true });
    expect((await client.apiKey.get({ query: { id } })).error?.code).toBe("KEY_NOT_FOUND");
  });
});
