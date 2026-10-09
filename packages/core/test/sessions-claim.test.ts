import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../src/config.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { completeSocial, resolveSocialUser, startSocial } from "../src/engine/social.js";
import { findOrCreateUserByEmail } from "../src/engine/users.js";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth, tokenFromMail } from "./helpers.js";
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
});
