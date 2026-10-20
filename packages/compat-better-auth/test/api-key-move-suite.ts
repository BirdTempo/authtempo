import { createPbkdf2PasswordHash } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createAccessControl, defaultStatements } from "../src/access.js";
import { apiKey } from "../src/api-key.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { organization } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { moveBetterAuthApiKeys } from "../src/storage/api-keys.js";
import type { D1SchemaStorage, PostgresSchemaStorage } from "../src/storage/index.js";

/** One database of the suite: the shim storage after the compat migrations, and a raw insert into apikey. */
export interface MoveDatabase {
  database: PostgresSchemaStorage | D1SchemaStorage;
  /** Writes one apikey row as Better Auth 1.7.5 does. The setup encodes dates and booleans for its dialect. */
  insertKey(row: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
const PASSWORD = "correct horse battery";
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A generated key in Better Auth's default form: the prefix and 64 letters (dist/index.mjs:2351). */
function generatedKey(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return prefix + [...bytes].map((b) => LETTERS[b % LETTERS.length]).join("");
}

/**
 * Better Auth's digest of a key: base64url SHA-256 of the whole key with no
 * padding (`defaultKeyHasher`). A real @better-auth/api-key 1.7.5 create
 * matched this rule on 2026-10-21 (script plan-12k-task-12-ddl.mjs).
 */
async function digestOf(key: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return btoa(String.fromCharCode(...hash))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const KEY_ACTIONS = ["create", "read", "update", "delete"] as const;

/** consumerb's access control (apps/api/src/auth.ts at f4518c7) plus one app resource. */
function access() {
  const ac = createAccessControl({
    ...defaultStatements,
    apiKey: KEY_ACTIONS,
    project: ["read", "write"],
  });
  return {
    ac,
    roles: {
      owner: ac.newRole({
        ...defaultStatements,
        apiKey: [...KEY_ACTIONS],
        project: ["read", "write"],
      }),
      member: ac.newRole({ project: ["read"] }),
    },
  };
}

/** A shim app on the suite's database, with passwords so a test signs people up as an app does. */
function app(m: MoveDatabase, references: "user" | "organization") {
  const mails: { email: string; token: string }[] = [];
  const { ac, roles } = access();
  const auth = betterAuth({
    baseURL: BASE,
    secret: SECRET,
    trustedOrigins: [],
    database: m.database,
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async (d) => void mails.push({ email: d.user.email, token: d.token }),
    },
    plugins: [
      organization({ ac, roles, sendInvitationEmail: async () => {} }),
      apiKey({
        defaultPrefix: "laaa_",
        enableMetadata: true,
        references,
        rateLimit: { enabled: false },
      }),
    ],
    authtempo: {
      roleRanks: { member: 1, owner: 2 },
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  });
  /** Signs up, confirms the verify link as a person does, and signs in. */
  const person = async (email: string) => {
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
    const link = mails.findLast((x) => x.email === email);
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
    return { token, user: caller.user, headers: new Headers({ authorization: `Bearer ${token}` }) };
  };
  return { auth, person, ac };
}

/** One apikey row as Better Auth 1.7.5's create writes it (dist/index.mjs:808 to :833). */
async function keyRow(key: string, over: Record<string, unknown>) {
  const now = new Date();
  return {
    id: `k_${crypto.randomUUID()}`,
    configId: "default",
    name: "deploy",
    start: key.slice(0, 6),
    prefix: "laaa_",
    key: await digestOf(key),
    refillInterval: null,
    refillAmount: null,
    lastRefillAt: null,
    enabled: true,
    rateLimitEnabled: true,
    rateLimitTimeWindow: 60_000,
    rateLimitMax: 600,
    requestCount: 0,
    remaining: null,
    lastRequest: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    permissions: null,
    metadata: null,
    ...over,
  };
}

export function apiKeyMoveSuite(label: string, setup: () => Promise<MoveDatabase>): void {
  describe(`moveBetterAuthApiKeys on ${label} (plan 12k Task 12)`, () => {
    /** Runs `body` on a fresh database and closes it. */
    const fresh = (body: (m: MoveDatabase) => Promise<void>) => async () => {
      const m = await setup();
      try {
        await body(m);
      } finally {
        await m.close();
      }
    };
    const move = (m: MoveDatabase, references: "user" | "organization", dryRun = false) =>
      moveBetterAuthApiKeys(m.database, {
        names: m.database.names,
        references,
        dryRun,
        statements: { project: ["read", "write"] },
      });

    it(
      "moves each live key and skips disabled, expired, and undigested rows",
      fresh(async (m) => {
        const { person } = app(m, "user");
        const ada = await person("ada@example.com");
        const past = new Date(Date.now() - 60_000);
        const live = generatedKey("laaa_");
        await m.insertKey(await keyRow(live, { referenceId: ada.user.id }));
        await m.insertKey(
          await keyRow(generatedKey("laaa_"), { referenceId: ada.user.id, enabled: false }),
        );
        await m.insertKey(
          await keyRow(generatedKey("laaa_"), { referenceId: ada.user.id, expiresAt: past }),
        );
        // disableKeyHashing was on: the column holds the clear key.
        const clear = generatedKey("laaa_");
        await m.insertKey({ ...(await keyRow(clear, { referenceId: ada.user.id })), key: clear });
        const report = await move(m, "user");
        expect(report).toEqual({
          moved: 1,
          skipped: { disabled: 1, expired: 1, noDigest: 1, present: 0, noCreator: 0 },
          byOwner: { [ada.user.id]: 1 },
          dropped: 0,
          ownerFallback: 0,
          prefixes: ["laaa_"],
        });
        const rows = await m.database.storage.findMany("apiToken", [
          { field: "userId", op: "eq", value: ada.user.id },
        ]);
        expect(rows).toHaveLength(1);
        // Ruling 2 of plan 12k: a moved row acts, so it holds no retired mark.
        expect(rows[0]?.retiredAt).toBeNull();
        expect(rows[0]?.rateLimitSeconds).toBe(60);
        expect(rows[0]?.rateLimitMax).toBe(600);
        // The hint is Better Auth's start: the first 6 characters, the prefix included.
        expect(rows[0]?.hint).toBe(live.slice(0, 6));
      }),
    );

    it(
      "is idempotent: a second run moves nothing",
      fresh(async (m) => {
        const { person } = app(m, "user");
        const ada = await person("ada@example.com");
        await m.insertKey(await keyRow(generatedKey("laaa_"), { referenceId: ada.user.id }));
        expect((await move(m, "user")).moved).toBe(1);
        const again = await move(m, "user");
        expect({ moved: again.moved, present: again.skipped.present }).toEqual({
          moved: 0,
          present: 1,
        });
        expect(
          await m.database.storage.findMany("apiToken", [
            { field: "userId", op: "eq", value: ada.user.id },
          ]),
        ).toHaveLength(1);
      }),
    );

    it(
      "writes nothing on a dry run and answers the same report",
      fresh(async (m) => {
        const { person } = app(m, "user");
        const ada = await person("ada@example.com");
        await m.insertKey(await keyRow(generatedKey("laaa_"), { referenceId: ada.user.id }));
        await m.insertKey(
          await keyRow(generatedKey("laaa_"), { referenceId: ada.user.id, enabled: false }),
        );
        const dry = await move(m, "user", true);
        expect(
          await m.database.storage.findMany("apiToken", [
            { field: "userId", op: "eq", value: ada.user.id },
          ]),
        ).toEqual([]);
        expect(await move(m, "user")).toEqual(dry);
      }),
    );

    it(
      "lets a moved key act under the same secret, as a user key and as an organization key",
      fresh(async (m) => {
        const { auth, person } = app(m, "organization");
        const ada = await person("ada@example.com");
        const org = await auth.tempo.api.createOrganization({
          user: ada.user,
          slug: "acme",
          name: "Acme",
        });
        if (!org.ok) throw new Error(org.code);
        const organizationId = org.value.organization.id;
        const key = generatedKey("laaa_");
        await m.insertKey(
          await keyRow(key, {
            referenceId: organizationId,
            metadata: JSON.stringify({ createdByUserId: ada.user.id, role: "owner" }),
            permissions: JSON.stringify({ project: ["read"] }),
          }),
        );
        // A key with no creator in its metadata gets the organization's first owner.
        await m.insertKey(await keyRow(generatedKey("laaa_"), { referenceId: organizationId }));
        const report = await move(m, "organization");
        expect({ moved: report.moved, ownerFallback: report.ownerFallback }).toEqual({
          moved: 2,
          ownerFallback: 1,
        });
        const moved = await m.database.storage.findMany("organizationToken", [
          { field: "organizationId", op: "eq", value: organizationId },
        ]);
        expect(moved.map((t) => t.createdById)).toEqual([ada.user.id, ada.user.id]);
        const v = await auth.api.verifyApiKey({
          body: { key, permissions: { project: ["read"] } },
        });
        expect({ valid: v.valid, error: v.error, referenceId: v.key?.referenceId }).toEqual({
          valid: true,
          error: null,
          referenceId: organizationId,
        });
        expect(v.key?.metadata).toEqual({ createdByUserId: ada.user.id, role: "owner" });
        // A user key moves into apiToken and acts for its user.
        const user = app(m, "user");
        const userKey = generatedKey("laaa_");
        await m.insertKey(await keyRow(userKey, { referenceId: ada.user.id }));
        expect((await move(m, "user")).moved).toBe(1);
        const caller = await user.auth.tempo.caller(
          new Request(BASE, { headers: { authorization: `Bearer ${userKey}` } }),
        );
        expect({
          kind: caller?.kind,
          user: caller?.kind === "token" ? caller.user.id : null,
        }).toEqual({ kind: "token", user: ada.user.id });
      }),
    );

    it(
      "answers token_retired for a key that did not move",
      fresh(async (m) => {
        const { auth, person } = app(m, "user");
        const ada = await person("ada@example.com");
        // Disabled in Better Auth, so the move skips it; its prefix stays a moved prefix.
        const key = generatedKey("laaa_");
        await m.insertKey(await keyRow(key, { referenceId: ada.user.id, enabled: false }));
        expect((await move(m, "user")).skipped.disabled).toBe(1);
        const request = () => new Request(BASE, { headers: { authorization: `Bearer ${key}` } });
        const r = await auth.tempo.authenticate(request());
        expect(r.ok ? null : { code: r.code, status: r.status }).toEqual({
          code: "token_retired",
          status: 401,
        });
        expect(await auth.tempo.caller(request())).toBeNull();
        expect(await auth.api.verifyApiKey({ body: { key } })).toEqual({
          valid: false,
          error: { code: "KEY_DISABLED", message: "This key was replaced. Create a new key." },
          key: null,
        });
      }),
    );

    it(
      "lists a moved key and lets its owner revoke it",
      fresh(async (m) => {
        const { auth, person } = app(m, "user");
        const ada = await person("ada@example.com");
        const key = generatedKey("laaa_");
        await m.insertKey(await keyRow(key, { referenceId: ada.user.id, name: "ci" }));
        await move(m, "user");
        const list = await auth.api.listApiKeys({ headers: ada.headers });
        expect(list.map((k) => ({ name: k.name, start: k.start, enabled: k.enabled }))).toEqual([
          { name: "ci", start: key.slice(0, 6), enabled: true },
        ]);
        const id = list[0]?.id ?? "";
        expect(await auth.api.deleteApiKey({ body: { keyId: id }, headers: ada.headers })).toEqual({
          success: true,
        });
        expect(await auth.api.listApiKeys({ headers: ada.headers })).toEqual([]);
        // The revoked key now answers as a moved prefix with no row.
        const v = await auth.api.verifyApiKey({ body: { key } });
        expect(v.error?.code).toBe("KEY_DISABLED");
      }),
    );

    it(
      "keeps no key, digest, or metadata in the report",
      fresh(async (m) => {
        const { person } = app(m, "user");
        const ada = await person("ada@example.com");
        const key = generatedKey("laaa_");
        const row = await keyRow(key, {
          referenceId: ada.user.id,
          metadata: JSON.stringify({ note: "metadata-marker" }),
        });
        await m.insertKey(row);
        const text = JSON.stringify(await move(m, "user"));
        for (const secret of [key, String(row.key), "metadata-marker", key.slice(5, 20)])
          expect(text.includes(secret)).toBe(false);
        expect(text.includes(ada.user.id)).toBe(true);
      }),
    );

    it(
      "drops an unknown resource from a moved key's permissions and counts it",
      fresh(async (m) => {
        const { person } = app(m, "user");
        const ada = await person("ada@example.com");
        await m.insertKey(
          await keyRow(generatedKey("laaa_"), {
            referenceId: ada.user.id,
            permissions: JSON.stringify({
              project: ["read", "erase"],
              ghost: ["read"],
              apiKey: ["read", "delete"],
            }),
          }),
        );
        const report = await move(m, "user");
        // ghost (one resource) and project:erase (one action) go.
        expect(report.dropped).toBe(2);
        const rows = await m.database.storage.findMany("apiToken", [
          { field: "userId", op: "eq", value: ada.user.id },
        ]);
        expect(rows[0]?.permissions).toEqual({ project: ["read"], apiToken: ["read", "revoke"] });
      }),
    );
  });
}
