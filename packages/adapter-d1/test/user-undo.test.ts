import { env } from "cloudflare:test";
import {
  type AuthConfig,
  type Clock,
  createAuth,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { TABLES, USER_CHILD_MODELS } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

const t0 = new Date("2026-01-01T00:00:00.000Z");
const EMAIL = "ada@example.com";
const byId = (id: string) => [{ field: "id" as const, op: "eq" as const, value: id }];
const user = (id: string, emailVerified: boolean) => ({
  id,
  email: `${id}@example.com`,
  emailVerified,
  name: null,
  image: null,
  createdAt: t0,
  updatedAt: t0,
});

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

describe("the D1 undo of a user create (plan 9 Task 4)", () => {
  it("keeps a user row that another request verified inside the open transaction", async () => {
    const db = createD1Adapter(env.DB);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", user("u1", false));
        // Another request, outside this transaction: an owner's claim verifies the row.
        await db.update("user", byId("u1"), { emailVerified: true });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.findOne("user", byId("u1"))).toMatchObject({ emailVerified: true });
  });

  it("deletes a user row created unverified that is still unverified", async () => {
    const db = createD1Adapter(env.DB);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", user("u1", false));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.findOne("user", byId("u1"))).toBeNull();
  });

  it("deletes a user row created verified", async () => {
    const db = createD1Adapter(env.DB);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", user("u1", true));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.findOne("user", byId("u1"))).toBeNull();
  });
});

/**
 * Plan 8b: a user created verified (a social claim, a reset of an unknown
 * address) had an undo by id. On D1 another request can add a row that names
 * the user inside the open transaction, and a throw then deleted the user
 * under it. The undo now deletes the user only while no child row names it.
 */
describe("the D1 undo of a user that a child row names (plan 8b)", () => {
  const day = new Date(t0.getTime() + 86_400_000);
  const childRows: Record<string, (db: StorageAdapter) => Promise<unknown>> = {
    identity: (db) =>
      db.create("identity", {
        id: "c1",
        userId: "u1",
        provider: "google",
        subject: "g-1",
        linkedAt: t0,
        createdAt: t0,
        updatedAt: t0,
      }),
    session: (db) =>
      db.create("session", {
        id: "c1",
        userId: "u1",
        tokenHash: "h-c1",
        expiresAt: day,
        lastSeenAt: t0,
        ip: null,
        userAgent: null,
        activeOrganizationId: null,
        createdAt: t0,
        updatedAt: t0,
      }),
    passkey: (db) =>
      db.create("passkey", {
        id: "c1",
        userId: "u1",
        credentialId: "cred-c1",
        publicKey: "pk",
        counter: 0,
        transports: null,
        deviceType: "singleDevice",
        backedUp: false,
        name: null,
        createdAt: t0,
        updatedAt: t0,
      }),
    member: async (db) => {
      await db.create("organization", {
        id: "o1",
        slug: "o1",
        name: "O1",
        metadata: null,
        createdAt: t0,
        updatedAt: t0,
      });
      return db.create("member", {
        id: "c1",
        organizationId: "o1",
        userId: "u1",
        role: "member",
        createdAt: t0,
        updatedAt: t0,
      });
    },
    password: (db) =>
      db.create("password", {
        id: "c1",
        userId: "u1",
        hash: "pbkdf2-sha256$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        createdAt: t0,
        updatedAt: t0,
      }),
    apiToken: (db) =>
      db.create("apiToken", {
        id: "c1",
        userId: "u1",
        name: "ci",
        tokenHash: "h-c1",
        hint: "abcdefgh",
        expiresAt: null,
        lastUsedAt: null,
        organizationId: null,
        createdAt: t0,
        updatedAt: t0,
      }),
    totp: (db) =>
      db.create("totp", {
        id: "c1",
        userId: "u1",
        secret: "sealed",
        enabledAt: null,
        lastStep: 0,
        backupCodes: [],
        createdAt: t0,
        updatedAt: t0,
        secretVersion: 1,
      }),
    trustedDevice: (db) =>
      db.create("trustedDevice", {
        id: "c1",
        userId: "u1",
        tokenHash: "h-c1",
        expiresAt: t0,
        lastSeenAt: t0,
        createdAt: t0,
        updatedAt: t0,
      }),
    oauthConsent: (db) =>
      db.create("oauthConsent", {
        id: "c1",
        userId: "u1",
        clientId: "cl_x",
        scopes: [],
        createdAt: t0,
        updatedAt: t0,
      }),
    oauthToken: (db) =>
      db.create("oauthToken", {
        id: "c1",
        tokenHash: "h-c1",
        familyId: "f1",
        userId: "u1",
        clientId: "cl_x",
        scopes: [],
        resource: "https://api.example.com/mcp",
        expiresAt: t0,
        usedAt: null,
        createdAt: t0,
        updatedAt: t0,
      }),
    secondFactor: (db) =>
      db.create("secondFactor", {
        id: "c1",
        userId: "u1",
        enabledAt: t0,
        methods: ["totp"],
        backupCodes: [],
        backupCodesVersion: 2,
        createdAt: t0,
        updatedAt: t0,
        secretVersion: 1,
      }),
  };

  it("covers every child model of the schema", () => {
    expect(Object.keys(childRows).sort()).toEqual([...USER_CHILD_MODELS].sort());
  });

  for (const [model, add] of Object.entries(childRows)) {
    it(`keeps a user created verified when another request adds a ${model} row inside the open transaction`, async () => {
      const db = createD1Adapter(env.DB);
      await expect(
        db.transaction(async (tx) => {
          await tx.create("user", user("u1", true));
          // Another request, outside this transaction.
          await add(db);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.findOne("user", byId("u1"))).not.toBeNull();
    });
  }

  it("keeps a user created unverified when another request adds a session row inside the open transaction", async () => {
    const db = createD1Adapter(env.DB);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", user("u1", false));
        // Another request, outside this transaction.
        await childRows.session?.(db);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.findOne("user", byId("u1"))).not.toBeNull();
  });

  it("still deletes a user whose only child rows are the transaction's own", async () => {
    const db = createD1Adapter(env.DB);
    await expect(
      db.transaction(async (tx) => {
        await tx.create("user", user("u1", true));
        await childRows.session?.(tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.findOne("user", byId("u1"))).toBeNull();
    expect(await db.findOne("session", byId("c1"))).toBeNull();
  });
});

/**
 * D1 transactions are not isolated (README, "Transactions"). The owner's
 * whole reset runs inside the claimant's open sign-up transaction, just after
 * one create of the sign-up. That is the interleave a real D1 database
 * allows between two requests.
 */
describe("a password sign-up on D1 while the owner resets the password (plan 8 I-1, plan 9 Task 4)", () => {
  function harness() {
    const base = createD1Adapter(env.DB);
    const clock: Clock = { now: () => t0 };
    const sent: MailMessage[] = [];
    let armed: { model: "user" | "password"; run: () => Promise<void> } | null = null;
    // The claimant's storage: its first create of the armed model runs the owner's flow.
    const wrapTx = (tx: StorageAdapter): StorageAdapter => ({
      ...tx,
      async create(model, data) {
        const row = await tx.create(model, data);
        if (armed && armed.model === model) {
          const run = armed.run;
          armed = null;
          await run();
        }
        return row;
      },
      transaction: (fn) => tx.transaction((inner) => fn(wrapTx(inner))),
    });
    const wrapped: StorageAdapter = {
      ...base,
      transaction: (fn) => base.transaction((tx) => fn(wrapTx(tx))),
    };
    const config = (storage: StorageAdapter): AuthConfig => ({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: ["https://app.example.com"],
      storage,
      mail: {
        send: async (m) => {
          sent.push(m);
        },
      },
      limiter: createMemoryLimiter(clock),
      clock,
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    });
    const passwords = (storage: StorageAdapter) => {
      const api = createAuth(config(storage)).api.password;
      if (!api) throw new Error("password sign-in is off");
      return api;
    };
    return {
      base,
      sent,
      owner: passwords(base),
      claimant: passwords(wrapped),
      arm: (model: "user" | "password", run: () => Promise<void>) => {
        armed = { model, run };
      },
      fired: () => armed === null,
    };
  }

  function tokenOf(text: string): string {
    const m = /token=([A-Za-z0-9_%-]+)/.exec(text);
    if (!m?.[1]) throw new Error("no link in the mail");
    return decodeURIComponent(m[1]);
  }

  const signIn = (h: ReturnType<typeof harness>, password: string) =>
    h.claimant.signIn({ email: EMAIL, password, ip: null, userAgent: null });

  it("keeps the owner's verified user and answers email_taken when the reset lands between the two creates", async () => {
    const h = harness();
    // Reachable: a reset request mails a link for an address with no user.
    expect((await h.owner.requestReset({ email: EMAIL, ip: null })).ok).toBe(true);
    const link = tokenOf(h.sent.at(-1)?.text ?? "");
    let owner: Awaited<ReturnType<typeof h.owner.reset>> | null = null;
    h.arm("user", async () => {
      owner = await h.owner.reset({
        token: link,
        password: "owner password",
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await h.claimant.signUp({
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
    expect(h.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken", status: 409 });
    const proved = owner as Awaited<ReturnType<typeof h.owner.reset>> | null;
    if (!proved?.ok) throw new Error("the owner's reset failed");
    const userId = proved.value.user.id;
    const users = await h.base.findMany("user", []);
    expect(users.map((u) => [u.id, u.emailVerified])).toEqual([[userId, true]]);
    const rows = await h.base.findMany("password", []);
    expect(rows.map((p) => p.userId)).toEqual([userId]);
    expect((await signIn(h, "owner password")).ok).toBe(true);
    expect(await signIn(h, "claimant password")).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
    // The claimant got no verify mail: the reset mail is the only one.
    expect(h.sent).toHaveLength(1);
  });

  it("keeps the owner's new password when the reset lands after the password create", async () => {
    const h = harness();
    expect((await h.owner.requestReset({ email: EMAIL, ip: null })).ok).toBe(true);
    const link = tokenOf(h.sent.at(-1)?.text ?? "");
    let owner: Awaited<ReturnType<typeof h.owner.reset>> | null = null;
    h.arm("password", async () => {
      owner = await h.owner.reset({
        token: link,
        password: "owner password",
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await h.claimant.signUp({
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
    expect(h.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof h.owner.reset>> | null;
    if (!proved?.ok) throw new Error("the owner's reset failed");
    expect((await h.base.findMany("user", [])).map((u) => u.emailVerified)).toEqual([true]);
    expect((await signIn(h, "owner password")).ok).toBe(true);
    expect(await signIn(h, "claimant password")).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
  });
});

describe("the D1 undo of an update (plan 9 final review M-1, R-1)", () => {
  it("restores only the columns the update set and keeps a column another request changed", async () => {
    const db = createD1Adapter(env.DB);
    await db.create("user", user("u1", false));
    await expect(
      db.transaction(async (tx) => {
        await tx.update("user", byId("u1"), { name: "Ada" });
        // Another request, outside this transaction: an owner's claim verifies the row.
        await env.DB.prepare(`UPDATE ${TABLES.user} SET email_verified = 1 WHERE id = ?`)
          .bind("u1")
          .run();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const back = await db.findOne("user", byId("u1"));
    expect(back?.name).toBeNull();
    expect(back?.emailVerified).toBe(true);
  });
});
