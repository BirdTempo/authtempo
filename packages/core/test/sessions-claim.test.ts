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
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth, tokenFromMail } from "./helpers.js";
import { FAST } from "./password-helpers.js";
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
 * rows. A flow on this view does not wait for the memory adapter's
 * transaction lock, so it can run inside another flow's open transaction.
 */
function d1Like(config: ResolvedConfig): ResolvedConfig {
  const raw = config.storage;
  const view: StorageAdapter = { ...raw, transaction: (fn) => fn(view) };
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
 * Wraps the next `storage.transaction` call so that `afterUserCreate` runs
 * inside that transaction, just after its user insert and before any later
 * statement. Later transactions run unchanged.
 */
function interleaveAfterUserCreate(
  storage: StorageAdapter,
  afterUserCreate: () => Promise<void>,
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
          if (m === "user" && !fired) {
            fired = true;
            await afterUserCreate();
          }
          return row;
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
    const gate = interleaveAfterUserCreate(auth.storage, async () => {
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
    const auth = makeAuth({ password: { hash: FAST } });
    const link = await magicLinkToken(auth);

    // On D1 the owner's whole claim runs inside the claimant's open sign-up
    // transaction, just after its user create (the second create, after the
    // password create): the claim finds the new user, verifies it, deletes
    // the claimant's password row, and adds the email identity. A throw
    // would undo the user create and delete the owner's user row by id.
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    const gate = interleaveAfterUserCreate(auth.storage, async () => {
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
    const auth = makeAuth({ password: { hash: FAST } });
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
    const userId = proved.value.user.id;
    expect(userId).toBe(up.value.user.id);
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
    const auth = makeAuth({ password: { hash: FAST } });
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
    expect(users.map((u) => u.id)).toEqual([won.value.user.id]);
    const passwords = await inner.findMany("password", []);
    expect(passwords.map((p) => p.userId)).toEqual([won.value.user.id]);
    const sessions = await inner.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(won.value.token)]);
    expect(auth.mail).toHaveLength(1);
  });

  it("answers email_taken_unverified on the unique_violation retry when the winner is an unverified social user (plan 8)", async () => {
    const auth = makeAuth({ password: { hash: FAST } });
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
    const auth = makeAuth({ password: { hash: FAST } });
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
    const r = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: "owner password",
      ip: null,
      userAgent: null,
    });
    expect(gate.fired()).toBe(true);
    if (!r.ok) throw new Error(r.code);
    expect(await resolveSession(auth.config, r.value.token)).not.toBeNull();
  });

  it("answers invalid_token and keeps the owner's session when a claim lands inside the verify link (plan 8, verify fails closed)", async () => {
    const auth = makeAuth({ password: { hash: FAST } });
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
    expect(await auth.storage.findMany("password", [])).toEqual([]);
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    const [row] = await auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-verify" },
    ]);
    expect(row?.consumedAt).not.toBeNull();
  });

  it("leaves one user when two resets for an address with no user race (plan 8, reset unique_violation retry)", async () => {
    const auth = makeAuth({ password: { hash: FAST } });
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
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
            token: first ?? "",
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
      { token: second ?? "", password: "loser password", ip: null, userAgent: null },
    );
    expect(missed).toBe(true);
    const won = winner as Awaited<ReturnType<typeof resetPassword>> | null;
    if (!won?.ok) throw new Error("the winner's reset failed");
    if (!loser.ok) throw new Error(loser.code);
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
    const auth = makeAuth({ password: { hash: FAST } });
    await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
    const set = await resetPassword(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      password: "first password",
      ip: null,
      userAgent: null,
    });
    if (!set.ok) throw new Error(set.code);
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
    const auth = makeAuth({ password: { hash: FAST } });
    // Reachable: a verified user with no password, from a magic link.
    const link = await magicLinkToken(auth);
    const ml = await verifyMagicLink(auth.config, { token: link, ip: null, userAgent: null });
    if (!ml.ok) throw new Error(ml.code);
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
    const auth = makeAuth({ password: { hash: FAST } });
    // Reachable: a reset request mails a link for an address with no user.
    const link = await resetLinkToken(auth);

    // On D1 the owner's whole reset runs inside the claimant's open sign-up
    // transaction, just after its first create.
    let owner: Awaited<ReturnType<typeof resetPassword>> | null = null;
    const gate = interleaveAfterFirstCreate(auth.storage, async () => {
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
    expect(claimant).toMatchObject({ ok: false, code: "email_taken", status: 409 });
    const proved = owner as Awaited<ReturnType<typeof resetPassword>> | null;
    if (!proved?.ok) throw new Error("the owner's reset failed");
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
    // The claimant got no verify mail: the reset mail is the only one.
    expect(auth.mail).toHaveLength(1);
  });

  it("keeps the owner's new password when the owner's reset lands after the sign-up's two creates (plan 8 final review I-2)", async () => {
    const auth = makeAuth({ password: { hash: FAST } });
    const link = await resetLinkToken(auth);

    // On D1 the owner's whole reset runs inside the claimant's open sign-up
    // transaction, after both creates: it writes the owner's hash into the
    // claimant's password row, keeps that row id, and verifies the user.
    let owner: Awaited<ReturnType<typeof resetPassword>> | null = null;
    const gate = interleaveAfterUserCreate(auth.storage, async () => {
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
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect((await signInAs(auth, "owner password")).ok).toBe(true);
    expect(await signInAs(auth, "claimant password")).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
  });

  it("keeps the owner's new password when the owner's reset lands just before the sign-up's session insert (plan 8 final review I-2)", async () => {
    const auth = makeAuth({ password: { hash: FAST } });
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
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect((await signInAs(auth, "owner password")).ok).toBe(true);
    expect(await signInAs(auth, "claimant password")).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
  });

  it("leaves the claimant no session when the owner's magic link lands just before the sign-up's session insert (plan 8 final review M-2)", async () => {
    const auth = makeAuth({ password: { hash: FAST } });
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
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(
      await auth.storage.findOne("user", [{ field: "id", op: "eq", value: proved.value.user.id }]),
    ).toMatchObject({ email: EMAIL, emailVerified: true });
    expect(await auth.storage.findMany("password", [])).toEqual([]);
  });
});
