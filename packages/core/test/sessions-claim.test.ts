import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import {
  changePassword,
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { completeSocial, resolveSocialUser, startSocial } from "../src/engine/social.js";
import { findOrCreateUserByEmail } from "../src/engine/users.js";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import type { ModelName, UserRow } from "../src/schema.js";
import { type StorageAdapter, StorageError } from "../src/storage/port.js";
import { undoCreateWhere } from "../src/storage/sql.js";
import { makeAuth, tokenFromMail } from "./helpers.js";
import { FAST, sessionOnly, upSession } from "./password-helpers.js";
import { type FakeIdToken, fakeJwt, GOOGLE, socialAuth } from "./social-helpers.js";

const EMAIL = "ada@example.com";

/** Starts a Google flow and returns what the callback needs. */
async function started(auth: ReturnType<typeof socialAuth>) {
  const r = await startSocial(auth.config, { provider: "google", next: "/home", ip: "1.1.1.1" });
  if (!r.ok) throw new Error(`start failed: ${r.code}`);
  const url = new URL(r.value.location);
  return {
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    bindToken: r.value.bindToken,
  };
}

function googleToken(nonce: string, claims: Record<string, unknown>): FakeIdToken {
  return {
    audience: GOOGLE.clientId,
    issuer: "https://accounts.google.com",
    claims: { sub: "g-1", email: EMAIL, email_verified: true, nonce, ...claims },
  };
}

function complete(auth: ReturnType<typeof socialAuth>, s: Awaited<ReturnType<typeof started>>) {
  return completeSocial(auth.config, {
    provider: "google",
    state: s.state,
    code: "code-1",
    error: null,
    bindToken: s.bindToken,
    ip: "1.1.1.1",
    userAgent: "ua",
  });
}

/**
 * The config with a storage whose transactions are not isolated, as on D1:
 * each statement of the transaction function runs at once on the shared
 * rows, and a throw runs this transaction's own undo log in reverse, as the
 * D1 adapter does. The undo of a create deletes `undoCreateWhere(...)`, the
 * D1 adapter's rule: a user created unverified only while it is still
 * unverified. The undo of an update writes back only the fields the update
 * set, the D1 adapter's rule too. A nested call shares the log and a throw reverses only its own
 * entries. A failed entry does not stop the rest. When any entry fails, the
 * throw is one rollback_failed error with `{ original, failures }` as its
 * cause and `<model>:<op>` for each failed entry, as the D1 adapter's
 * `rethrowAfterUndo` throws, so a core test sees the error that real D1
 * answers (plan 9 Task 4 review M-1). A flow on this view does
 * not wait for the memory adapter's transaction lock, so it can run inside
 * another flow's open transaction.
 */
function d1Like(config: ResolvedConfig): ResolvedConfig {
  const raw = config.storage;
  type Undo = { model: ModelName; op: "create" | "update" | "delete"; run: () => Promise<unknown> };
  const rollback = async (entries: Undo[], original: unknown): Promise<never> => {
    const failures: unknown[] = [];
    const fields: string[] = [];
    for (const u of entries.reverse()) {
      try {
        await u.run();
      } catch (f) {
        failures.push(f);
        fields.push(`${u.model}:${u.op}`);
      }
    }
    if (failures.length === 0) throw original;
    const model = original instanceof StorageError ? original.model : "meta";
    throw new StorageError("rollback_failed", model, fields, { cause: { original, failures } });
  };
  const view: StorageAdapter = {
    ...raw,
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> {
      const log: Undo[] = [];
      const tx: StorageAdapter = {
        ...raw,
        async create(model, data) {
          const row = await raw.create(model, data);
          log.push({
            model,
            op: "create",
            run: () => raw.delete(model, undoCreateWhere(model, data)),
          });
          return row;
        },
        async update(model, where, data) {
          const before = await raw.findMany(model, where);
          const n = await raw.update(model, where, data);
          // The D1 adapter's rule (`SqlStatements.restoreRow`): the undo
          // writes back only the fields the update set, so a claim that
          // changed another field inside this transaction stays.
          const fields = Object.keys(data);
          for (const row of before) {
            const all = row as unknown as { id: string } & Record<string, unknown>;
            const back = Object.fromEntries(fields.map((f) => [f, all[f]]));
            log.push({
              model,
              op: "update",
              run: () =>
                raw.update(model, [{ field: "id", op: "eq", value: all.id }], back as never),
            });
          }
          return n;
        },
        async delete(model, where) {
          const before = await raw.findMany(model, where);
          const n = await raw.delete(model, where);
          for (const row of before)
            log.push({ model, op: "delete", run: () => raw.create(model, row) });
          return n;
        },
        async transaction<U>(inner: (t: StorageAdapter) => Promise<U>): Promise<U> {
          const mark = log.length;
          try {
            return await inner(tx);
          } catch (e) {
            return rollback(log.splice(mark), e);
          }
        },
      };
      try {
        return await fn(tx);
      } catch (e) {
        return rollback(log, e);
      }
    },
  };
  return { ...config, storage: view };
}

/**
 * Wraps the next `storage.transaction` call so that `beforeSessionInsert`
 * runs inside that transaction, just before its session insert. Later
 * transactions run unchanged.
 */
function interleaveBeforeSessionInsert(
  storage: StorageAdapter,
  beforeSessionInsert: () => Promise<void>,
): { fired: () => boolean } {
  const original = storage.transaction.bind(storage);
  let armed = true;
  let fired = false;
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!armed) return original(fn);
    armed = false;
    return original((tx) =>
      fn({
        ...tx,
        create: async (m, d) => {
          if (m === "session" && !fired) {
            fired = true;
            await beforeSessionInsert();
          }
          return tx.create(m, d);
        },
      }),
    );
  };
  return { fired: () => fired };
}

/**
 * Wraps the next `storage.transaction` call so that `afterIdentityRead`
 * runs inside that transaction, just after its first identity read. Later
 * transactions run unchanged.
 */
function interleaveAfterIdentityRead(
  storage: StorageAdapter,
  afterIdentityRead: () => Promise<void>,
): { fired: () => boolean } {
  const original = storage.transaction.bind(storage);
  let armed = true;
  let fired = false;
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!armed) return original(fn);
    armed = false;
    return original((tx) =>
      fn({
        ...tx,
        findOne: async (m, w) => {
          const row = await tx.findOne(m, w);
          if (m === "identity" && !fired) {
            fired = true;
            await afterIdentityRead();
          }
          return row;
        },
      }),
    );
  };
  return { fired: () => fired };
}

/**
 * Wraps the next `storage.transaction` call so that `after` runs inside
 * that transaction, just after its first insert of `model` and before any
 * later statement. Later transactions run unchanged.
 */
function interleaveAfterCreate(
  storage: StorageAdapter,
  model: ModelName,
  after: () => Promise<void>,
): { fired: () => boolean } {
  const original = storage.transaction.bind(storage);
  let armed = true;
  let fired = false;
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!armed) return original(fn);
    armed = false;
    return original((tx) =>
      fn({
        ...tx,
        create: async (m, d) => {
          const row = await tx.create(m, d);
          if (m === model && !fired) {
            fired = true;
            await after();
          }
          return row;
        },
      }),
    );
  };
  return { fired: () => fired };
}

/**
 * Wraps the next `storage.transaction` call so that `after` runs inside
 * that transaction, just after its first update of `model` and before any
 * later statement. Later transactions run unchanged.
 */
function interleaveAfterUpdate(
  storage: StorageAdapter,
  model: ModelName,
  after: () => Promise<void>,
): { fired: () => boolean } {
  const original = storage.transaction.bind(storage);
  let armed = true;
  let fired = false;
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!armed) return original(fn);
    armed = false;
    return original((tx) =>
      fn({
        ...tx,
        update: async (m, w, d) => {
          const n = await tx.update(m, w, d);
          if (m === model && !fired) {
            fired = true;
            await after();
          }
          return n;
        },
      }),
    );
  };
  return { fired: () => fired };
}

/**
 * Wraps the next `storage.transaction` call so that `afterFirstCreate`
 * runs inside that transaction, just after its first insert of any model
 * and before any later statement. In a sign-up, that is between its two
 * creates, whichever comes first. Later transactions run unchanged.
 */
function interleaveAfterFirstCreate(
  storage: StorageAdapter,
  afterFirstCreate: () => Promise<void>,
): { fired: () => boolean } {
  const original = storage.transaction.bind(storage);
  let armed = true;
  let fired = false;
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!armed) return original(fn);
    armed = false;
    return original((tx) =>
      fn({
        ...tx,
        create: async (m, d) => {
          const row = await tx.create(m, d);
          if (!fired) {
            fired = true;
            await afterFirstCreate();
          }
          return row;
        },
      }),
    );
  };
  return { fired: () => fired };
}

/**
 * Wraps the next `storage.transaction` call so that `afterUserRead` runs
 * inside that transaction, just after its first user read. Later
 * transactions run unchanged.
 */
function interleaveAfterUserRead(
  storage: StorageAdapter,
  afterUserRead: () => Promise<void>,
): { fired: () => boolean } {
  const original = storage.transaction.bind(storage);
  let armed = true;
  let fired = false;
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!armed) return original(fn);
    armed = false;
    return original((tx) =>
      fn({
        ...tx,
        findOne: async (m, w) => {
          const row = await tx.findOne(m, w);
          if (m === "user" && !fired) {
            fired = true;
            await afterUserRead();
          }
          return row;
        },
      }),
    );
  };
  return { fired: () => fired };
}

/** Runs `before` just before the next `storage.transaction` call starts. */
function interleaveBeforeNextTransaction(
  storage: StorageAdapter,
  before: () => Promise<void>,
): { fired: () => boolean } {
  const original = storage.transaction.bind(storage);
  let fired = false;
  storage.transaction = async <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!fired) {
      fired = true;
      await before();
    }
    return original(fn);
  };
  return { fired: () => fired };
}

/** An unverified user, as a provider that does not verify the address creates, with a handoff code minted for it. */
async function unverifiedHandoffCode(auth: ReturnType<typeof makeAuth>) {
  const now = auth.clock.now();
  const user = await auth.storage.create("user", {
    id: "01CLAIMANT",
    email: EMAIL,
    emailVerified: false,
    name: null,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
  const verifier = randomBase64Url(32);
  const start = await startHandoff(auth.config, {
    challenge: await sha256Base64Url(verifier),
    redirect: "consumera://auth",
    ip: null,
  });
  if (!start.ok) throw new Error(start.code);
  const browser = await createSession(auth.config, { userId: user.id, ip: null, userAgent: null });
  const cont = await continueHandoff(auth.config, {
    handoffId: start.value.handoffId,
    userId: user.id,
    sessionId: browser.session.id,
  });
  if (!cont.ok) throw new Error(cont.code);
  const code = new URL(cont.value.location).searchParams.get("code") ?? "";
  return { user, code, verifier };
}

async function magicLinkToken(auth: ReturnType<typeof makeAuth>): Promise<string> {
  await requestMagicLink(auth.config, { email: EMAIL, ip: null });
  return tokenFromMail(auth.mail.at(-1)?.text ?? "");
}

// The password sign-ups below set `uniformSignUp: false`: they pin the races
// of the detailed answer of plan 8 (a session at sign-up, `email_taken`). The
// uniform answer has its own tests in uniform-sign-up.test.ts (plan 12b).
describe("the session is created inside the claim transaction (plan 7 input, Review Focus 1)", () => {
  it("leaves no claimant session when the claimant's callback races the owner's magic link", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    const now = auth.clock.now();
    // The claimant holds an unverified account for the owner's address, and a session on it.
    const claim = await resolveSocialUser(
      auth.storage,
      "google",
      {
        subject: "attacker",
        email: EMAIL,
        emailVerified: false,
        name: null,
        image: null,
      },
      now,
    );
    if (!claim.ok) throw new Error("no claimant");
    const userId = claim.value.id;
    await createSession(auth.config, { userId, ip: null, userAgent: null });

    // The claimant's second callback is in flight.
    const s = await started(auth);
    tokens["idtok-default"] = googleToken(s.nonce, { sub: "attacker", email_verified: false });
    const link = await magicLinkToken(auth);

    // The memory adapter runs one transaction at a time, so it cannot
    // interleave statements of two transactions. The wrapper simulates the
    // interleaving at transaction granularity: the owner's magic link verify
    // runs in the gap after the claimant's resolution transaction commits and
    // before completeSocial returns, the gap where the old order created the
    // claimant's session after the claim. The statement-level window inside
    // the transaction is the next test.
    const original = auth.storage.transaction.bind(auth.storage);
    let armed = true;
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    auth.storage.transaction = async <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
      const value = await original(fn);
      if (armed) {
        armed = false;
        owner = await verifyMagicLink(auth.config, { token: link, ip: null, userAgent: null });
      }
      return value;
    };

    const claimant = await complete(auth, s);
    expect(armed).toBe(false);
    expect(claimant.ok).toBe(true);
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok || !claimant.ok) throw new Error("a flow failed");
    if (!("token" in claimant.value)) throw new Error("the sign-in answered a challenge");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    expect(proved.value.user.id).toBe(userId);

    // Exactly the owner's session survives. Nothing older, and nothing the claimant wrote.
    const sessions = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: userId },
    ]);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(await resolveSession(auth.config, claimant.value.token)).toBeNull();
    expect(await resolveSession(auth.config, proved.value.token)).not.toBeNull();
  });

  /** Records, for each session write, whether it went through a transaction's `tx`. */
  function recordSessionWrites(storage: StorageAdapter): ("tx" | "raw")[] {
    const seen: ("tx" | "raw")[] = [];
    const rawCreate = storage.create.bind(storage);
    const rawTransaction = storage.transaction.bind(storage);
    storage.create = (m, d) => {
      if (m === "session") seen.push("raw");
      return rawCreate(m, d);
    };
    storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      rawTransaction((tx) =>
        fn({
          ...tx,
          create: (m, d) => {
            if (m === "session") seen.push("tx");
            return tx.create(m, d);
          },
        }),
      );
    return seen;
  }

  it("writes the magic link session through the transaction's tx", async () => {
    const auth = socialAuth();
    const link = await magicLinkToken(auth);
    const seen = recordSessionWrites(auth.storage);
    const r = await verifyMagicLink(auth.config, { token: link, ip: null, userAgent: null });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["tx"]);
  });

  it("writes the social session through the transaction's tx", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    const s = await started(auth);
    tokens["idtok-default"] = googleToken(s.nonce, {});
    const seen = recordSessionWrites(auth.storage);
    const r = await complete(auth, s);
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["tx"]);
  });

  it("undoes the claimant's social session when the claim lands inside the claimant's transaction (review finding 1)", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    const now = auth.clock.now();
    const claim = await resolveSocialUser(
      auth.storage,
      "google",
      { subject: "attacker", email: EMAIL, emailVerified: false, name: null, image: null },
      now,
    );
    if (!claim.ok) throw new Error("no claimant");
    const userId = claim.value.id;
    const s = await started(auth);
    tokens["idtok-default"] = googleToken(s.nonce, { sub: "attacker", email_verified: false });
    const link = await magicLinkToken(auth);

    // On D1 the claimant's transaction reads the user as unverified, then the
    // owner's whole claim runs, then the claimant's session insert lands
    // after the claim's session delete. The memory adapter cannot interleave
    // two transactions, so the owner's verify runs on a D1-like view inside
    // the claimant's open transaction, just before its session insert.
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveBeforeSessionInsert(auth.storage, async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await complete(auth, s);
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const sessions = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: userId },
    ]);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(
      (await auth.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]))
        ?.emailVerified,
    ).toBe(true);
  });

  it("keeps the owner's user row when the claim lands inside the claimant's new-user transaction (final review I-1)", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    // No account exists for the address. The claimant's callback creates the
    // user, an unverified identity, and a session in one transaction.
    const s = await started(auth);
    tokens["idtok-default"] = googleToken(s.nonce, { sub: "attacker", email_verified: false });
    const link = await magicLinkToken(auth);

    // On D1 the owner's whole claim runs inside the claimant's open
    // transaction, just before its session insert: it finds the new user,
    // adds the email identity, verifies the user, and deletes the claimant's
    // identity. A throw would undo the user create and delete the owner's
    // user row by id.
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveBeforeSessionInsert(auth.storage, async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await complete(auth, s);
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const userId = proved.value.user.id;
    expect(
      await auth.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]),
    ).toMatchObject({ email: EMAIL, emailVerified: true });
    expect(
      await auth.storage.findOne("identity", [
        { field: "provider", op: "eq", value: "email" },
        { field: "subject", op: "eq", value: EMAIL },
      ]),
    ).toMatchObject({ userId });
    expect(
      await auth.storage.findMany("identity", [{ field: "subject", op: "eq", value: "attacker" }]),
    ).toEqual([]);
    const sessions = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: userId },
    ]);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(await resolveSession(auth.config, proved.value.token)).not.toBeNull();
  });

  it("links nothing to the owner's account when the claim lands between the claimant's user create and identity create (re-review R-1)", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    const s = await started(auth);
    tokens["idtok-default"] = googleToken(s.nonce, { sub: "attacker", email_verified: false });
    const link = await magicLinkToken(auth);

    // On D1 the owner's whole claim runs inside the claimant's open
    // transaction, just after its user create: the claim finds the new user,
    // adds the email identity, and verifies the user before the claimant's
    // identity exists, so a guard on that identity would pass.
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveAfterCreate(auth.storage, "user", async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await complete(auth, s);
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const userId = proved.value.user.id;
    expect(
      await auth.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]),
    ).toMatchObject({ email: EMAIL, emailVerified: true });
    const identities = await auth.storage.findMany("identity", [
      { field: "userId", op: "eq", value: userId },
    ]);
    expect(identities.map((x) => [x.provider, x.subject])).toEqual([["email", EMAIL]]);
    const sessions = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: userId },
    ]);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(await resolveSession(auth.config, proved.value.token)).not.toBeNull();
  });

  it("undoes the handoff redeem session of an unverified user when the claim lands inside the redeem (review finding 1)", async () => {
    const auth = makeAuth({ handoff: { schemes: ["consumera://"] } });
    const now = auth.clock.now();
    // An unverified user, as a provider that does not verify the address creates.
    const user = await auth.storage.create("user", {
      id: "01CLAIMANT",
      email: EMAIL,
      emailVerified: false,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    const verifier = randomBase64Url(32);
    const start = await startHandoff(auth.config, {
      challenge: await sha256Base64Url(verifier),
      redirect: "consumera://auth",
      ip: null,
    });
    if (!start.ok) throw new Error(start.code);
    const browser = await createSession(auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    const cont = await continueHandoff(auth.config, {
      handoffId: start.value.handoffId,
      userId: user.id,
      sessionId: browser.session.id,
    });
    if (!cont.ok) throw new Error(cont.code);
    const code = new URL(cont.value.location).searchParams.get("code") ?? "";
    await requestMagicLink(auth.config, { email: EMAIL, ip: null });
    const link = tokenFromMail(auth.mail.at(-1)?.text ?? "");

    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveBeforeSessionInsert(auth.storage, async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });

    const r = await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null });
    expect(gate.fired()).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "invalid_token" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const sessions = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
  });

  it("claims an unverified winner on the unique_violation retry and creates the session there (review finding 2)", async () => {
    const auth = makeAuth();
    const inner = auth.storage;
    const now = auth.clock.now();
    const winner: UserRow = {
      id: "01WINNER",
      email: EMAIL,
      emailVerified: false,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    };
    // The first user read inside a transaction misses. On that miss a
    // concurrent unverified sign-up (a claimant) commits the winner and a
    // session through the outer adapter. The transaction's user create then
    // fails with unique_violation.
    let missed = false;
    const wrap = (a: StorageAdapter): StorageAdapter => ({
      create: (m, d) => a.create(m, d),
      findOne: async (m, w) => {
        if (m === "user" && !missed) {
          missed = true;
          await inner.create("user", winner);
          await createSession(auth.config, { userId: winner.id, ip: null, userAgent: null }, inner);
          return null;
        }
        return a.findOne(m, w);
      },
      findMany: (m, w, o) => a.findMany(m, w, o),
      update: (m, w, d) => a.update(m, w, d),
      delete: (m, w) => a.delete(m, w),
      transaction: (fn) => a.transaction((tx) => fn(wrap(tx))),
    });
    const r = await findOrCreateUserByEmail(wrap(inner), EMAIL, now, (tx, u) =>
      createSession(auth.config, { userId: u.id, ip: null, userAgent: null }, tx),
    );
    expect(missed).toBe(true);
    expect(r.created).toBe(false);
    expect(r.user).toMatchObject({ id: "01WINNER", emailVerified: true });
    const stored = await inner.findOne("user", [{ field: "id", op: "eq", value: "01WINNER" }]);
    expect(stored?.emailVerified).toBe(true);
    const sessions = await inner.findMany("session", [
      { field: "userId", op: "eq", value: "01WINNER" },
    ]);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(r.after.token)]);
  });

  it("undoes the claimant's social session when the claim commits between the identity read and the user read (re-review finding A)", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    const now = auth.clock.now();
    const claim = await resolveSocialUser(
      auth.storage,
      "google",
      { subject: "attacker", email: EMAIL, emailVerified: false, name: null, image: null },
      now,
    );
    if (!claim.ok) throw new Error("no claimant");
    const userId = claim.value.id;
    const s = await started(auth);
    tokens["idtok-default"] = googleToken(s.nonce, { sub: "attacker", email_verified: false });
    const link = await magicLinkToken(auth);

    // The claimant reads its identity. Then the owner's whole claim runs, on
    // a D1-like view inside the claimant's open transaction. Then the
    // claimant reads the user, which is verified now.
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveAfterIdentityRead(auth.storage, async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await complete(auth, s);
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const sessions = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: userId },
    ]);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
  });

  it("undoes the handoff redeem session when the claim commits between the consume and the user read (re-review finding A)", async () => {
    const auth = makeAuth({ handoff: { schemes: ["consumera://"] } });
    const { user, code, verifier } = await unverifiedHandoffCode(auth);
    const link = await magicLinkToken(auth);

    // The redeem consumes the code. Then the owner's claim commits whole.
    // Then the redeem's transaction reads the user, which is verified now.
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveBeforeNextTransaction(auth.storage, async () => {
      owner = await verifyMagicLink(auth.config, { token: link, ip: null, userAgent: null });
    });

    const r = await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null });
    expect(gate.fired()).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "invalid_token" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const sessions = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
  });

  it("writes nothing to the user row on an unverified social sign-in (re-review finding B)", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    const now = auth.clock.now();
    const claim = await resolveSocialUser(
      auth.storage,
      "google",
      { subject: "attacker", email: EMAIL, emailVerified: false, name: null, image: null },
      now,
    );
    if (!claim.ok) throw new Error("no claimant");
    const s = await started(auth);
    tokens["idtok-default"] = googleToken(s.nonce, {
      sub: "attacker",
      email_verified: false,
      name: "Mallory",
      picture: "https://p/m.png",
    });
    const userWrites: string[] = [];
    const rawTransaction = auth.storage.transaction.bind(auth.storage);
    auth.storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      rawTransaction((tx) =>
        fn({
          ...tx,
          update: (m, w, d) => {
            userWrites.push(m);
            return tx.update(m, w, d);
          },
        }),
      );
    const r = await complete(auth, s);
    expect(r.ok).toBe(true);
    expect(userWrites.filter((m) => m === "user")).toEqual([]);
    const stored = await auth.storage.findOne("user", [
      { field: "id", op: "eq", value: claim.value.id },
    ]);
    expect(stored).toMatchObject({ emailVerified: false, name: null, image: null });
  });

  it("undoes the handoff code when the claim deletes the checked browser session before the mint (re-review finding C)", async () => {
    const auth = makeAuth({ handoff: { schemes: ["consumera://"] } });
    const now = auth.clock.now();
    const user = await auth.storage.create("user", {
      id: "01CLAIMANT",
      email: EMAIL,
      emailVerified: false,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    // The claimant's browser session passed the continue route's check.
    const browser = await createSession(auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    const start = await startHandoff(auth.config, {
      challenge: await sha256Base64Url(randomBase64Url(32)),
      redirect: "consumera://auth",
      ip: null,
    });
    if (!start.ok) throw new Error(start.code);
    const link = await magicLinkToken(auth);

    // Inside the continue's transaction, before its user read, the owner's
    // whole claim runs on a D1-like view: it deletes the browser session and
    // the handoff codes and verifies the user. The continue then reads the
    // user verified and writes a code that would skip the redeem guard.
    const original = auth.storage.transaction.bind(auth.storage);
    let fired = false;
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    auth.storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      original((tx) =>
        fn({
          ...tx,
          findOne: async (m, w) => {
            if (m === "user" && !fired) {
              fired = true;
              owner = await verifyMagicLink(d1Like(auth.config), {
                token: link,
                ip: null,
                userAgent: null,
              });
            }
            return tx.findOne(m, w);
          },
        }),
      );

    const r = await continueHandoff(auth.config, {
      handoffId: start.value.handoffId,
      userId: user.id,
      sessionId: browser.session.id,
    });
    expect(fired).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "invalid_token" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    expect(proved?.ok).toBe(true);
    expect(
      await auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "handoff-code" },
        { field: "identifier", op: "eq", value: user.id },
      ]),
    ).toEqual([]);
    // The undo also reverses the start row's consume: the row is live again.
    // The claimant's browser session is gone, so a second continue shows
    // the sign-in page.
    const startRow = await auth.storage.findOne("verification", [
      { field: "valueHash", op: "eq", value: await sha256Hex(start.value.handoffId) },
    ]);
    expect(startRow?.consumedAt).toBeNull();
    expect(
      await auth.storage.findOne("session", [{ field: "id", op: "eq", value: browser.session.id }]),
    ).toBeNull();
  });

  it("leaves no password on the owner's account when the claim lands just after the sign-up's user create (plan 8, Review Focus 4)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const link = await magicLinkToken(auth);

    // On D1 the owner's whole claim runs inside the claimant's open sign-up
    // transaction, just after its user create (the first create): the claim
    // finds the new user, verifies it, and adds the email identity. The
    // claimant's password create then succeeds, and its guard deletes that
    // row and its session and commits.
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveAfterCreate(auth.storage, "user", async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await passwordSignUp(auth.config, {
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const userId = proved.value.user.id;
    expect(
      await auth.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]),
    ).toMatchObject({ email: EMAIL, emailVerified: true });
    const identities = await auth.storage.findMany("identity", [
      { field: "userId", op: "eq", value: userId },
    ]);
    expect(identities.map((x) => [x.provider, x.subject])).toEqual([["email", EMAIL]]);
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(await resolveSession(auth.config, proved.value.token)).not.toBeNull();
    // The claimant got no verify mail: the magic link mail is the only one.
    expect(auth.mail).toHaveLength(1);
    expect(
      await auth.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "password-verify" },
      ]),
    ).toEqual([]);
  });

  it("undoes the claimant's password sign-in session when the claim lands inside it (plan 8, Review Focus 2)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    // Reachable: the claimant signs up and never uses the verify link.
    const up = await passwordSignUp(auth.config, {
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const link = await magicLinkToken(auth);

    // On D1 the owner's whole claim runs inside the claimant's open sign-in
    // transaction, after the password verify and before the session
    // insert: the claim verifies the user and deletes the password row and
    // every session. The claimant's session insert comes after it.
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveBeforeSessionInsert(auth.storage, async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "invalid_credentials" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const userId = proved.value.user.id;
    expect(userId).toBe(upSession(up.value).user.id);
    expect(
      await auth.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]),
    ).toMatchObject({ email: EMAIL, emailVerified: true });
    const identities = await auth.storage.findMany("identity", [
      { field: "userId", op: "eq", value: userId },
    ]);
    expect(identities.map((x) => [x.provider, x.subject])).toEqual([["email", EMAIL]]);
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(await resolveSession(auth.config, proved.value.token)).not.toBeNull();
  });

  it("answers the loser of two sign-ups for one new address with email_taken and keeps one user (plan 8, unique_violation retry)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const inner = auth.storage;
    // The loser's first user read misses. On that miss the winner's whole
    // sign-up commits through the outer adapter, as a second isolate would.
    // The loser's user create then fails with unique_violation.
    let winner: Awaited<ReturnType<typeof passwordSignUp>> | null = null;
    let missed = false;
    const wrap = (a: StorageAdapter): StorageAdapter => ({
      create: (m, d) => a.create(m, d),
      findOne: async (m, w) => {
        if (m === "user" && !missed) {
          missed = true;
          winner = await passwordSignUp(d1Like(auth.config), {
            email: EMAIL,
            password: "winner password",
            ip: null,
            userAgent: null,
          });
          return null;
        }
        return a.findOne(m, w);
      },
      findMany: (m, w, o) => a.findMany(m, w, o),
      update: (m, w, d) => a.update(m, w, d),
      delete: (m, w) => a.delete(m, w),
      transaction: (fn) => a.transaction((tx) => fn(wrap(tx))),
    });
    const loser = await passwordSignUp(
      { ...auth.config, storage: wrap(inner) },
      { email: EMAIL, password: "loser password", ip: null, userAgent: null },
    );
    expect(missed).toBe(true);
    const won = winner as Awaited<ReturnType<typeof passwordSignUp>> | null;
    if (!won?.ok) throw new Error("the winner's sign-up failed");
    expect(loser).toMatchObject({ ok: false, code: "email_taken", status: 409 });
    const users = await inner.findMany("user", []);
    expect(users.map((u) => u.id)).toEqual([upSession(won.value).user.id]);
    const passwords = await inner.findMany("password", []);
    expect(passwords.map((p) => p.userId)).toEqual([upSession(won.value).user.id]);
    const sessions = await inner.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(upSession(won.value).token)]);
    expect(auth.mail).toHaveLength(1);
  });

  it("answers email_taken_unverified on the unique_violation retry when the winner is an unverified social user (plan 8)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const inner = auth.storage;
    // The winner is a social sign-in whose provider does not verify the
    // address. It commits on the loser's first user read. The retry reads
    // the winner's rows and answers by the sign-up's own rules.
    let missed = false;
    const wrap = (a: StorageAdapter): StorageAdapter => ({
      create: (m, d) => a.create(m, d),
      findOne: async (m, w) => {
        if (m === "user" && !missed) {
          missed = true;
          const social = await resolveSocialUser(
            d1Like(auth.config).storage,
            "google",
            { subject: "g-1", email: EMAIL, emailVerified: false, name: null, image: null },
            auth.clock.now(),
          );
          if (!social.ok) throw new Error(social.code);
          return null;
        }
        return a.findOne(m, w);
      },
      findMany: (m, w, o) => a.findMany(m, w, o),
      update: (m, w, d) => a.update(m, w, d),
      delete: (m, w) => a.delete(m, w),
      transaction: (fn) => a.transaction((tx) => fn(wrap(tx))),
    });
    const loser = await passwordSignUp(
      { ...auth.config, storage: wrap(inner) },
      { email: EMAIL, password: "loser password", ip: null, userAgent: null },
    );
    expect(missed).toBe(true);
    expect(loser).toMatchObject({ ok: false, code: "email_taken_unverified", status: 409 });
    expect(await inner.findMany("user", [])).toHaveLength(1);
    expect(await inner.findMany("password", [])).toEqual([]);
    expect(await inner.findMany("session", [])).toEqual([]);
    expect(auth.mail).toEqual([]);
  });

  it("keeps a password sign-in when the verify link that confirms this password lands inside it (plan 8, Review Focus 2)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const up = await passwordSignUp(auth.config, {
      email: EMAIL,
      password: "owner password",
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    const gate = interleaveBeforeSessionInsert(auth.storage, async () => {
      const v = await verifyPasswordEmail(d1Like(auth.config), {
        token,
        ip: null,
        userAgent: null,
      });
      if (!v.ok) throw new Error(v.code);
    });
    const r = await sessionOnly(
      passwordSignIn(auth.config, {
        email: EMAIL,
        password: "owner password",
        ip: null,
        userAgent: null,
      }),
    );
    expect(gate.fired()).toBe(true);
    if (!r.ok) throw new Error(r.code);
    expect(await resolveSession(auth.config, r.value.token)).not.toBeNull();
  });

  it("answers invalid_token and keeps the owner's session when a claim lands inside the verify link (plan 8, verify fails closed)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    // Reachable: a sign-up, then the owner of the address uses a magic link
    // while the sign-up's verify link runs, as on D1.
    const up = await passwordSignUp(auth.config, {
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const verify = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    const link = await magicLinkToken(auth);
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveAfterUserRead(auth.storage, async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });
    const r = await verifyPasswordEmail(auth.config, { token: verify, ip: null, userAgent: null });
    expect(gate.fired()).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "invalid_token" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    const [row] = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-verify" },
    ]);
    expect(row?.consumedAt).not.toBeNull();
  });

  it("leaves one user when two resets for an address with no user race (plan 8, reset unique_violation retry)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    // A new millisecond, so the second link's id sorts after the first. The
    // loser deletes the older pending rows first (plan 12c, Task 12), so the
    // winner takes the newer link and the loser the older one.
    auth.clock.advance(1);
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const [first, second] = auth.mail.map((m) => tokenFromMail(m.text));
    const inner = auth.storage;
    // The loser's first user read misses. On that miss the winner's whole
    // reset commits through the outer adapter, as a second isolate would.
    // The loser's user create then fails with unique_violation.
    let winner: Awaited<ReturnType<typeof resetPassword>> | null = null;
    let missed = false;
    const wrap = (a: StorageAdapter): StorageAdapter => ({
      create: (m, d) => a.create(m, d),
      findOne: async (m, w) => {
        if (m === "user" && !missed) {
          missed = true;
          winner = await resetPassword(d1Like(auth.config), {
            token: second ?? "",
            password: "winner password",
            ip: null,
            userAgent: null,
          });
          return null;
        }
        return a.findOne(m, w);
      },
      findMany: (m, w, o) => a.findMany(m, w, o),
      update: (m, w, d) => a.update(m, w, d),
      delete: (m, w) => a.delete(m, w),
      transaction: (fn) => a.transaction((tx) => fn(wrap(tx))),
    });
    const loser = await resetPassword(
      { ...auth.config, storage: wrap(inner) },
      { token: first ?? "", password: "loser password", ip: null, userAgent: null },
    );
    expect(missed).toBe(true);
    const won = winner as Awaited<ReturnType<typeof resetPassword>> | null;
    if (!won?.ok) throw new Error("the winner's reset failed");
    if (!loser.ok) throw new Error(loser.code);
    if (!("token" in loser.value)) throw new Error("the reset answered a challenge");
    expect(loser.value.user.id).toBe(won.value.user.id);
    expect(await inner.findMany("user", [])).toHaveLength(1);
    expect(await inner.findMany("password", [])).toHaveLength(1);
    expect(await inner.findMany("identity", [])).toHaveLength(1);
    // The last reset wins: its password signs in, and its session is the only one.
    const sessions = await inner.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(loser.value.token)]);
    expect(
      (
        await passwordSignIn(auth.config, {
          email: EMAIL,
          password: "loser password",
          ip: null,
          userAgent: null,
        })
      ).ok,
    ).toBe(true);
  });

  it("answers conflict when another change wins between the verify and the write (plan 8, change conflict)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const set = await resetPassword(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      password: "first password",
      ip: null,
      userAgent: null,
    });
    if (!set.ok) throw new Error(set.code);
    if (!("token" in set.value)) throw new Error("the reset answered a challenge");
    const session = await resolveSession(auth.config, set.value.token);
    if (!session) throw new Error("no session");
    let other: Awaited<ReturnType<typeof changePassword>> | null = null;
    const gate = interleaveBeforeNextTransaction(auth.storage, async () => {
      other = await changePassword(auth.config, {
        session,
        currentPassword: "first password",
        newPassword: "other password",
      });
    });
    const r = await changePassword(auth.config, {
      session,
      currentPassword: "first password",
      newPassword: "loser password",
    });
    expect(gate.fired()).toBe(true);
    expect(other).toEqual({ ok: true, value: { ok: true } });
    expect(r).toMatchObject({ ok: false, code: "conflict", status: 409 });
    const signIn = (password: string) =>
      passwordSignIn(auth.config, { email: EMAIL, password, ip: null, userAgent: null });
    expect((await signIn("other password")).ok).toBe(true);
    expect(await signIn("loser password")).toMatchObject({ code: "invalid_credentials" });
  });

  it("answers conflict when a reset sets the first password between the read and the create (plan 8, change conflict)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    // Reachable: a verified user with no password, from a magic link.
    const link = await magicLinkToken(auth);
    const ml = await verifyMagicLink(auth.config, { token: link, ip: null, userAgent: null });
    if (!ml.ok) throw new Error(ml.code);
    if (!("token" in ml.value)) throw new Error("the sign-in answered a challenge");
    const session = await resolveSession(auth.config, ml.value.token);
    if (!session) throw new Error("no session");
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const reset = tokenFromMail(auth.mail.at(-1)?.text ?? "");
    const gate = interleaveBeforeNextTransaction(auth.storage, async () => {
      const r = await resetPassword(auth.config, {
        token: reset,
        password: "reset password",
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
    });
    const r = await changePassword(auth.config, { session, newPassword: "change password" });
    expect(gate.fired()).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "conflict", status: 409 });
    const rows = await auth.storage.findMany("password", []);
    expect(rows).toHaveLength(1);
    expect(
      (
        await passwordSignIn(auth.config, {
          email: EMAIL,
          password: "reset password",
          ip: null,
          userAgent: null,
        })
      ).ok,
    ).toBe(true);
  });

  /** A reset link for EMAIL, requested before the sign-up, as the owner holds it. */
  async function resetLinkToken(auth: ReturnType<typeof makeAuth>): Promise<string> {
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    return tokenFromMail(auth.mail.at(-1)?.text ?? "");
  }

  function signInAs(auth: ReturnType<typeof makeAuth>, password: string) {
    return passwordSignIn(auth.config, { email: EMAIL, password, ip: null, userAgent: null });
  }

  it("keeps the owner's user, identity, session, and password when the owner's reset lands between the sign-up's two creates (plan 8 final review I-1)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    // Reachable: a reset request mails a link for an address with no user.
    const link = await resetLinkToken(auth);

    // On D1 the owner's whole reset runs inside the claimant's open sign-up
    // transaction, just after its first create (the user create): the reset
    // finds the unverified user, writes the owner's password row for it, and
    // verifies it. The claimant's password create fails on the `userId`
    // unique key, its undo keeps the verified user, and the retry answers
    // email_taken.
    const claimantConfig = d1Like(auth.config);
    let owner: Awaited<ReturnType<typeof resetPassword>> | null = null;
    const gate = interleaveAfterFirstCreate(claimantConfig.storage, async () => {
      owner = await resetPassword(d1Like(auth.config), {
        token: link,
        password: "owner password",
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await passwordSignUp(claimantConfig, {
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken", status: 409 });
    const proved = owner as Awaited<ReturnType<typeof resetPassword>> | null;
    if (!proved?.ok) throw new Error("the owner's reset failed");
    if (!("token" in proved.value)) throw new Error("the reset answered a challenge");
    const userId = proved.value.user.id;
    const users = await auth.storage.findMany("user", []);
    expect(users.map((u) => [u.id, u.email, u.emailVerified])).toEqual([[userId, EMAIL, true]]);
    const identities = await auth.storage.findMany("identity", []);
    expect(identities.map((x) => [x.userId, x.provider, x.subject])).toEqual([
      [userId, "email", EMAIL],
    ]);
    const passwords = await auth.storage.findMany("password", []);
    expect(passwords.map((p) => p.userId)).toEqual([userId]);
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(await resolveSession(auth.config, proved.value.token)).not.toBeNull();
    expect((await signInAs(auth, "owner password")).ok).toBe(true);
    expect(await signInAs(auth, "claimant password")).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
    // The claimant got no verify mail. The reset mail and the owner's reset
    // notice (plan 12a) are the only ones, both to the owner's address.
    expect(auth.mail.map((m) => [m.to, m.subject])).toEqual([
      [EMAIL, "Reset your password for api.example.com"],
      [EMAIL, "Security notice for your api.example.com account"],
    ]);
  });

  it("keeps the owner's new password when the owner's reset lands after the sign-up's two creates (plan 8 final review I-2)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const link = await resetLinkToken(auth);

    // On D1 the owner's whole reset runs inside the claimant's open sign-up
    // transaction, after both creates: it writes the owner's hash into the
    // claimant's password row, keeps that row id, and verifies the user.
    const claimantConfig = d1Like(auth.config);
    let owner: Awaited<ReturnType<typeof resetPassword>> | null = null;
    const gate = interleaveAfterCreate(claimantConfig.storage, "password", async () => {
      owner = await resetPassword(d1Like(auth.config), {
        token: link,
        password: "owner password",
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await passwordSignUp(claimantConfig, {
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof resetPassword>> | null;
    if (!proved?.ok) throw new Error("the owner's reset failed");
    if (!("token" in proved.value)) throw new Error("the reset answered a challenge");
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect((await signInAs(auth, "owner password")).ok).toBe(true);
    expect(await signInAs(auth, "claimant password")).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
  });

  it("keeps the owner's new password when the owner's reset lands just before the sign-up's session insert (plan 8 final review I-2)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const link = await resetLinkToken(auth);

    let owner: Awaited<ReturnType<typeof resetPassword>> | null = null;
    const gate = interleaveBeforeSessionInsert(auth.storage, async () => {
      owner = await resetPassword(d1Like(auth.config), {
        token: link,
        password: "owner password",
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await passwordSignUp(auth.config, {
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof resetPassword>> | null;
    if (!proved?.ok) throw new Error("the owner's reset failed");
    if (!("token" in proved.value)) throw new Error("the reset answered a challenge");
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect((await signInAs(auth, "owner password")).ok).toBe(true);
    expect(await signInAs(auth, "claimant password")).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
  });

  it("leaves the claimant no session when the owner's magic link lands just before the sign-up's session insert (plan 8 final review M-2)", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const link = await magicLinkToken(auth);

    // On D1 the owner's whole claim runs inside the claimant's open sign-up
    // transaction, after both creates and before the session insert. The
    // claim deletes the sessions that exist then; the claimant's session
    // comes after it, so only the guard after the insert removes it.
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveBeforeSessionInsert(auth.storage, async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await passwordSignUp(auth.config, {
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(
      await auth.storage.findOne("user", [{ field: "id", op: "eq", value: proved.value.user.id }]),
    ).toMatchObject({ email: EMAIL, emailVerified: true });
    expect(await auth.storage.findMany("password", [])).toEqual([]);
  });
});

/**
 * The sign-up writes its password row with a pending marker and activates
 * it as its last statement, after the guard proved the user still
 * unverified. On D1 an owner's claim can land between the user create and
 * the password create: it finds no password row to delete. Without the
 * marker, a claimant sign-in in that window proves the sign-up password
 * and keeps a session on the owner's verified user (plan 9 Task 4 review I-1).
 */
describe("the sign-up password row stays pending until the guard (plan 9 Task 4 review I-1)", () => {
  const signUp = (config: ResolvedConfig) =>
    passwordSignUp(config, {
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    });
  const signIn = (config: ResolvedConfig, password: string) =>
    passwordSignIn(config, { email: EMAIL, password, ip: null, userAgent: null });

  it("refuses a claimant sign-in when the owner's magic link lands between the sign-up's two creates", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const link = await magicLinkToken(auth);
    const claimantConfig = d1Like(auth.config);
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    let early: Awaited<ReturnType<typeof passwordSignIn>> | null = null;
    // The owner's claim runs just after the user create. The claimant's
    // sign-in runs just after the password create, before the guard.
    const claim = interleaveAfterCreate(claimantConfig.storage, "user", async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });
    const race = interleaveAfterCreate(claimantConfig.storage, "password", async () => {
      early = await signIn(d1Like(auth.config), "claimant password");
    });

    const claimant = await signUp(claimantConfig);
    expect(claim.fired()).toBe(true);
    expect(race.fired()).toBe(true);
    expect(early).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const users = await auth.storage.findMany("user", []);
    expect(users.map((u) => [u.id, u.emailVerified])).toEqual([[proved.value.user.id, true]]);
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    expect(await signIn(auth.config, "claimant password")).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
  });

  it("runs the dummy verify for a sign-in against a pending row, as for no row", async () => {
    const seen: string[] = [];
    const hash = {
      ...FAST,
      verify: async (plain: string, stored: string) => {
        seen.push(stored);
        return FAST.verify(plain, stored);
      },
    };
    const auth = makeAuth({ password: { hash, uniformSignUp: false } });
    const claimantConfig = d1Like(auth.config);
    let early: Awaited<ReturnType<typeof passwordSignIn>> | null = null;
    // Reachable on D1: a sign-in runs inside the open sign-up, after its password create.
    const race = interleaveAfterCreate(claimantConfig.storage, "password", async () => {
      early = await signIn(d1Like(auth.config), "claimant password");
    });

    expect((await signUp(claimantConfig)).ok).toBe(true);
    expect(race.fired()).toBe(true);
    expect(early).toMatchObject({ ok: false, code: "invalid_credentials" });
    // The flat cost: the one verify ran against the seam's dummy string.
    expect(seen).toEqual([await FAST.dummy()]);
  });

  it("activates the password row of a plain sign-up, so a later sign-in works", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const created = await signUp(d1Like(auth.config));
    expect(created.ok).toBe(true);
    const rows = await auth.storage.findMany("password", []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hash.startsWith("pending$")).toBe(false);
    expect((await signIn(auth.config, "claimant password")).ok).toBe(true);
  });

  it("answers email_taken_unverified with no session when a claim lands between the guard and the activation", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const link = await magicLinkToken(auth);
    const claimantConfig = d1Like(auth.config);
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    // The sign-up's first user update is the guard.
    const gate = interleaveAfterUpdate(claimantConfig.storage, "user", async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });

    const claimant = await signUp(claimantConfig);
    expect(gate.fired()).toBe(true);
    expect(claimant).toMatchObject({ ok: false, code: "email_taken_unverified" });
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    expect(auth.mail).toHaveLength(1);
  });
});

describe("an update undo restores only the columns the update set (plan 9 final review M-1, R-1)", () => {
  it("keeps the owner's verified user and session when the sign-up's activation throws after the owner's claim", async () => {
    const auth = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const link = await magicLinkToken(auth);
    const claimantConfig = d1Like(auth.config);
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    // The sign-up's first user update is the guard. Its undo entry holds the
    // user row with `emailVerified` false. The owner's claim runs just after it.
    const gate = interleaveAfterUpdate(claimantConfig.storage, "user", async () => {
      owner = await verifyMagicLink(d1Like(auth.config), {
        token: link,
        ip: null,
        userAgent: null,
      });
    });
    // The activation, the sign-up's password update, throws once, as a
    // transient D1 error does. The undo log then runs.
    const transient = new Error("transient D1 error");
    const original = claimantConfig.storage.transaction.bind(claimantConfig.storage);
    let thrown = false;
    claimantConfig.storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>) =>
      original((tx) =>
        fn({
          ...tx,
          update: async (m, w, d) => {
            if (m === "password" && !thrown) {
              thrown = true;
              throw transient;
            }
            return tx.update(m, w, d);
          },
        }),
      );

    const err = await passwordSignUp(claimantConfig, {
      email: EMAIL,
      password: "claimant password",
      ip: null,
      userAgent: null,
    }).catch((e: unknown) => e);
    expect(gate.fired()).toBe(true);
    expect(thrown).toBe(true);
    expect(err).toBe(transient);
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok) throw new Error("the owner's verify failed");
    if (!("token" in proved.value)) throw new Error("the sign-in answered a challenge");
    const users = await auth.storage.findMany("user", []);
    expect(users.map((u) => [u.id, u.emailVerified])).toEqual([[proved.value.user.id, true]]);
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => [x.userId, x.tokenHash])).toEqual([
      [proved.value.user.id, await sha256Hex(proved.value.token)],
    ]);
    expect(await auth.storage.findMany("password", [])).toEqual([]);
  });
});

describe("the D1-like test view (plan 9 Task 4 review M-1)", () => {
  it("surfaces a failed undo entry as rollback_failed, as the D1 adapter does", async () => {
    const auth = makeAuth();
    const raw = auth.config.storage;
    const at = auth.clock.now();
    const user = {
      id: "u1",
      email: "u1@example.com",
      emailVerified: false,
      name: null,
      image: null,
      createdAt: at,
      updatedAt: at,
    };
    await raw.create("user", user);
    const original = new Error("boom");
    const err = await d1Like(auth.config)
      .storage.transaction(async (tx) => {
        await tx.delete("user", [{ field: "id", op: "eq", value: "u1" }]);
        // Another request takes the id before the rollback, so the re-insert fails.
        await raw.create("user", { ...user, email: "other@example.com" });
        throw original;
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err).toMatchObject({ code: "rollback_failed", model: "meta", fields: ["user:delete"] });
    expect((err as StorageError).cause).toMatchObject({ original });
  });
});
