import { createPbkdf2PasswordHash, type StorageAdapter } from "@authtempo/core";
import { describe, expect, it, vi } from "vitest";
import { createAccessControl, defaultStatements } from "../src/access.js";
import { apiKey } from "../src/api-key.js";
import { BetterAuthCompatError } from "../src/compat-error.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { organization } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { moveBetterAuthApiKeys } from "../src/storage/api-keys.js";
import type { D1SchemaStorage, PostgresSchemaStorage } from "../src/storage/index.js";
import { rawReadOf, registerRawRead } from "../src/storage/raw.js";

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
function app(m: MoveDatabase, references: "user" | "organization", rateLimit = false) {
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
        rateLimit: { enabled: rateLimit },
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
    const move = (
      m: MoveDatabase,
      references: "user" | "organization",
      dryRun = false,
      movedPrefixes: readonly string[] = ["laaa_"],
      rateLimitEnabled = false,
    ) =>
      moveBetterAuthApiKeys(m.database, {
        names: m.database.names,
        references,
        dryRun,
        movedPrefixes,
        rateLimitEnabled,
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
          await keyRow(generatedKey("laaa_"), {
            id: "k_1",
            referenceId: ada.user.id,
            enabled: false,
          }),
        );
        await m.insertKey(
          await keyRow(generatedKey("laaa_"), {
            id: "k_2",
            referenceId: ada.user.id,
            expiresAt: past,
          }),
        );
        // disableKeyHashing was on: the column holds the clear key.
        const clear = generatedKey("laaa_");
        await m.insertKey({
          ...(await keyRow(clear, { id: "k_3", referenceId: ada.user.id })),
          key: clear,
        });
        const report = await move(m, "user");
        expect(report).toEqual({
          moved: 1,
          skipped: { disabled: 1, expired: 1, noDigest: 1, present: 0, noCreator: 0, noOwner: 0 },
          skippedKeys: [
            { id: "k_1", owner: ada.user.id, reason: "disabled" },
            { id: "k_2", owner: ada.user.id, reason: "expired" },
            { id: "k_3", owner: ada.user.id, reason: "noDigest" },
          ],
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
        // The plugin has rateLimit enabled false, so Better Auth used no window.
        expect(rows[0]?.rateLimitSeconds).toBeNull();
        expect(rows[0]?.rateLimitMax).toBeNull();
        // The hint is Better Auth's start: the first 6 characters, the prefix included.
        expect(rows[0]?.hint).toBe(live.slice(0, 6));
      }),
    );

    it(
      "refuses a stored prefix outside movedPrefixes and a row with no prefix before any write",
      fresh(async (m) => {
        const { auth, person } = app(m, "user");
        const ada = await person("ada@example.com");
        // Probe P3 of the Task 12 review: Better Auth accepts both keys.
        const ci = generatedKey("ci_");
        const bare = generatedKey("");
        await m.insertKey(await keyRow(ci, { referenceId: ada.user.id, prefix: "ci_" }));
        await m.insertKey(await keyRow(bare, { referenceId: ada.user.id, prefix: null }));
        await m.insertKey(await keyRow(generatedKey("laaa_"), { referenceId: ada.user.id }));
        for (const dryRun of [true, false]) {
          const error = await move(m, "user", dryRun).then(
            () => null,
            (e: unknown) => e,
          );
          expect(error).toBeInstanceOf(BetterAuthCompatError);
          expect((error as BetterAuthCompatError).refusals).toEqual([
            "moveBetterAuthApiKeys: apikey rows with no prefix: 1; such a key never reaches the lookup of the moved keys, so re-issue it and delete its row",
            "moveBetterAuthApiKeys: no moved prefix starts the stored prefixes ci_; put each one in authtempo.movedKeyPrefixes",
          ]);
        }
        // No write: not even the key whose prefix is listed moved.
        expect(
          await m.database.storage.findMany("apiToken", [
            { field: "userId", op: "eq", value: ada.user.id },
          ]),
        ).toEqual([]);
        // With ci_ listed, only the row with no prefix stops the move.
        await expect(move(m, "user", true, ["laaa_", "ci_"])).rejects.toThrow(
          "apikey rows with no prefix: 1",
        );
        expect((await auth.api.verifyApiKey({ body: { key: ci } })).valid).toBe(false);
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
      "keeps a revoked key refused when the move runs again",
      fresh(async (m) => {
        // Probe P1 of the Task 12 review: the second run brought the key back.
        const { auth, person } = app(m, "user");
        const ada = await person("ada@example.com");
        const key = generatedKey("laaa_");
        await m.insertKey(await keyRow(key, { referenceId: ada.user.id }));
        expect((await move(m, "user")).moved).toBe(1);
        const id = (await auth.api.listApiKeys({ headers: ada.headers }))[0]?.id ?? "";
        await auth.api.deleteApiKey({ body: { keyId: id }, headers: ada.headers });
        expect((await auth.api.verifyApiKey({ body: { key } })).valid).toBe(false);
        const again = await move(m, "user");
        expect({ moved: again.moved, present: again.skipped.present }).toEqual({
          moved: 0,
          present: 1,
        });
        expect((await auth.api.verifyApiKey({ body: { key } })).valid).toBe(false);
        expect(await auth.api.listApiKeys({ headers: ada.headers })).toEqual([]);
      }),
    );

    it(
      "moves each row once when a run stops halfway and runs again",
      fresh(async (m) => {
        const { auth, person } = app(m, "user");
        const ada = await person("ada@example.com");
        const keys = [generatedKey("laaa_"), generatedKey("laaa_"), generatedKey("laaa_")];
        for (const key of keys) await m.insertKey(await keyRow(key, { referenceId: ada.user.id }));
        // The second record write fails, as a process that stops inside the second row.
        const real = m.database.storage;
        let records = 0;
        const stopping: StorageAdapter = {
          ...real,
          transaction: (fn) =>
            real.transaction((tx) =>
              fn({
                ...tx,
                create: async (model, data) => {
                  if (model === "movedToken" && ++records === 2) throw new Error("stopped");
                  return tx.create(model, data);
                },
              } as StorageAdapter),
            ),
        };
        const halfway = { ...m.database, storage: stopping };
        registerRawRead(halfway, rawReadOf(m.database) ?? (async () => []));
        await expect(
          moveBetterAuthApiKeys(halfway, {
            names: m.database.names,
            references: "user",
            dryRun: false,
            movedPrefixes: ["laaa_"],
            rateLimitEnabled: false,
          }),
        ).rejects.toThrow("stopped");
        const byUser = [{ field: "userId" as const, op: "eq" as const, value: ada.user.id }];
        // The first row and its record committed; the second row's token went with its record.
        expect(await real.findMany("apiToken", byUser)).toHaveLength(1);
        const again = await move(m, "user");
        expect({ moved: again.moved, present: again.skipped.present }).toEqual({
          moved: 2,
          present: 1,
        });
        expect(await real.findMany("apiToken", byUser)).toHaveLength(3);
        expect(await real.findMany("movedToken", [])).toHaveLength(3);
        for (const key of keys)
          expect((await auth.api.verifyApiKey({ body: { key } })).valid).toBe(true);
      }),
    );

    it(
      "refills a moved key when the interval has passed, at the edge too (deviation of the refill rule)",
      fresh(async (m) => {
        const { auth, person } = app(m, "user");
        const ada = await person("ada@example.com");
        const at = new Date(Date.now() - 600_000);
        const row = (key: string) =>
          keyRow(key, {
            referenceId: ada.user.id,
            rateLimitEnabled: false,
            remaining: 0,
            refillAmount: 5,
            refillInterval: 60_000,
            lastRefillAt: at,
          });
        const early = generatedKey("laaa_");
        const edge = generatedKey("laaa_");
        await m.insertKey(await row(early));
        await m.insertKey(await row(edge));
        expect((await move(m, "user")).moved).toBe(2);
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          // One millisecond before the interval: no refill, so the count of 0 refuses.
          vi.setSystemTime(at.getTime() + 59_999);
          expect((await auth.api.verifyApiKey({ body: { key: early } })).error?.code).toBe(
            "USAGE_EXCEEDED",
          );
          // At the interval: core refills (now >= last + interval, plan 12k decision 6).
          // Better Auth 1.7.5 refills only after it (dist/index.mjs:1743), so it refuses here.
          vi.setSystemTime(at.getTime() + 60_000);
          const v = await auth.api.verifyApiKey({ body: { key: edge } });
          expect({ valid: v.valid, remaining: v.key?.remaining }).toEqual({
            valid: true,
            remaining: 4,
          });
        } finally {
          vi.useRealTimers();
        }
        const rows = await m.database.storage.findMany("apiToken", [
          { field: "userId", op: "eq", value: ada.user.id },
        ]);
        // Both set the count to refillAmount less the one use.
        expect(rows.map((r) => r.remaining).sort()).toEqual([0, 4]);
      }),
    );

    it(
      "moves a key window only while the plugin's rateLimit is enabled",
      fresh(async (m) => {
        // Probe P4 of the Task 12 review: the move added a window that Better Auth skipped.
        const window = { rateLimitEnabled: true, rateLimitTimeWindow: 60_000, rateLimitMax: 2 };
        const off = app(m, "user");
        const ada = await off.person("ada@example.com");
        const open = generatedKey("laaa_");
        await m.insertKey(await keyRow(open, { referenceId: ada.user.id, ...window }));
        expect((await move(m, "user", false, ["laaa_"], false)).moved).toBe(1);
        const codes = [];
        for (let i = 0; i < 4; i++)
          codes.push(
            (await off.auth.api.verifyApiKey({ body: { key: open } })).error?.code ?? "ok",
          );
        expect(codes).toEqual(["ok", "ok", "ok", "ok"]);
        // With the plugin's rateLimit on, the row's window moves and acts.
        const on = app(m, "user", true);
        const held = generatedKey("laaa_");
        await m.insertKey(await keyRow(held, { referenceId: ada.user.id, ...window }));
        expect((await move(m, "user", false, ["laaa_"], true)).moved).toBe(1);
        const limited = [];
        for (let i = 0; i < 3; i++)
          limited.push(
            (await on.auth.api.verifyApiKey({ body: { key: held } })).error?.code ?? "ok",
          );
        expect(limited).toEqual(["ok", "ok", "RATE_LIMITED"]);
      }),
    );

    it(
      "skips a key whose user or organization is gone, with its reason",
      fresh(async (m) => {
        const { person } = app(m, "user");
        const ada = await person("ada@example.com");
        // Probe P5 of the Task 12 review: such a key moved, counted, and then never acted.
        await m.insertKey(
          await keyRow(generatedKey("laaa_"), { id: "k_user", referenceId: "gone-user" }),
        );
        const user = await move(m, "user");
        expect({ moved: user.moved, keys: user.skippedKeys }).toEqual({
          moved: 0,
          keys: [{ id: "k_user", owner: "gone-user", reason: "noOwner" }],
        });
        await m.insertKey(
          await keyRow(generatedKey("laaa_"), {
            id: "k_org",
            referenceId: "gone-org",
            metadata: JSON.stringify({ createdByUserId: ada.user.id }),
          }),
        );
        const org = await move(m, "organization");
        expect({ moved: org.moved, noOwner: org.skipped.noOwner }).toEqual({
          moved: 0,
          noOwner: 2,
        });
        expect(await m.database.storage.findMany("organizationToken", [])).toEqual([]);
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
      "answers 200 at GET /organizations/tokens/current for a moved organization key",
      fresh(async (m) => {
        const { auth, person } = app(m, "organization");
        const ada = await person("ada@example.com");
        const org = await auth.tempo.api.createOrganization({
          user: ada.user,
          slug: "acme",
          name: "Acme",
        });
        if (!org.ok) throw new Error(org.code);
        const key = generatedKey("laaa_");
        await m.insertKey(
          await keyRow(key, {
            referenceId: org.value.organization.id,
            metadata: JSON.stringify({ createdByUserId: ada.user.id }),
          }),
        );
        expect((await move(m, "organization")).moved).toBe(1);
        const res = await auth.handler(
          new Request(`${BASE}/api/auth/organizations/tokens/current`, {
            headers: { authorization: `Bearer ${key}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { organization: { id: string } };
        expect(body.organization.id).toBe(org.value.organization.id);
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
