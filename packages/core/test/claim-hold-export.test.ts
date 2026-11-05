import { describe, expect, it } from "vitest";
import type { AuthConfig, MailMessage, ResolvedConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import {
  CLAIM_LEASE_MS,
  ClaimLostError,
  claimLeaseId,
  holdClaim,
  releaseClaim,
} from "../src/engine/users.js";
import * as root from "../src/index.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import type { UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { d1Like } from "./d1-like.js";
import { APP_ORIGIN, BASE_URL, recordAddress, recordCredential, tokenFromMail } from "./helpers.js";
import { FAST } from "./password-helpers.js";

// The hold of a claim for a writer that is no claim (decision 5 of plan
// 12q). The importer takes it around the writes of an unverified user. On a
// store with no isolation it is the claim lease. On an isolated store it is
// the conditional update of the user row. Each user comes from a flow of the
// product: a password sign-up makes the unverified user, and a magic link
// makes the verified one. A held lease is the state of an import that holds
// the user, or of an import that stopped before its release.

const EMAIL = recordAddress("ada@example.com");
const PW = recordCredential("claimant password 1");

/** One memory store, one clock, and one mail list. */
function world() {
  let current = new Date("2026-11-05T00:00:00.000Z");
  const clock = { now: () => current };
  const mem = createMemoryAdapter();
  const limiter = createMemoryLimiter(clock);
  const mail: MailMessage[] = [];
  const config = (storage: StorageAdapter): AuthConfig => ({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    limiter,
    clock,
    mail: { send: async (m) => void mail.push(m) },
    password: { hash: FAST, uniformSignUp: false },
  });
  return {
    mem,
    clock,
    /** The engine on the memory store: no isolation, and no query limit. */
    auth: () => createAuth(config(mem)),
    /** The engine on the D1 view of the same store: no isolation, and a query limit. */
    d1: () => createAuth(config(d1Like({ storage: mem } as unknown as ResolvedConfig).storage)),
    /** The token of a magic link of `email`, mailed now. */
    async link(email: string): Promise<string> {
      expect((await createAuth(config(mem)).api.requestMagicLink({ email, ip: null })).ok).toBe(
        true,
      );
      return tokenFromMail(mail.findLast((m) => m.to === email)?.text ?? "");
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}
type World = ReturnType<typeof world>;

async function userAt(w: World, email: string): Promise<UserRow> {
  const user = await w.mem.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error(`no user at ${email}`);
  return user;
}

/** The claimant's password sign-up: an unverified user with one password row. */
async function signedUp(w: World): Promise<UserRow> {
  const out = await w
    .auth()
    .api.password?.signUp({ email: EMAIL, password: PW, ip: null, userAgent: null });
  expect(out?.ok).toBe(true);
  return userAt(w, EMAIL);
}

/** The owner's magic link: "ok a session", or the error code. */
async function ownerLink(w: World, auth: ReturnType<World["auth"]>): Promise<string> {
  const out = await auth.api.verifyMagicLink({
    token: await w.link(EMAIL),
    ip: null,
    userAgent: null,
  });
  return out.ok ? ("token" in out.value ? "ok a session" : "ok") : out.code;
}

const lease = (w: World, userId: string) =>
  w.mem.findOne("verification", [{ field: "id", op: "eq", value: claimLeaseId(userId) }]);

/**
 * A view of a transaction of the memory store that reads as isolated, as on
 * Postgres and MySQL. It records each call of the port.
 */
function isolatedView(tx: StorageAdapter, calls: string[]): StorageAdapter {
  return recordingView(tx, calls, true);
}

/** A view of a transaction that records each call of the port, as "<call> <model>". */
function recordingView(tx: StorageAdapter, calls: string[], isolated = false): StorageAdapter {
  return new Proxy(tx, {
    get(target, key) {
      if (key === "isolated") return isolated || target.isolated;
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(`${String(key)} ${String(args[0])}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as StorageAdapter;
}

describe("holdClaim and releaseClaim from the root entry", () => {
  it("are on the root entry, with ClaimLostError", () => {
    expect(root.holdClaim).toBe(holdClaim);
    expect(root.releaseClaim).toBe(releaseClaim);
    expect(root.ClaimLostError).toBe(ClaimLostError);
  });
});

describe("holdClaim and releaseClaim on a store with no isolation", () => {
  it("writes the claim lease of the user from the clock at the hold, and the release deletes it", async () => {
    const w = world();
    const user = await signedUp(w);
    w.advance(5_000);
    const until = await w.mem.transaction((tx) => holdClaim(tx, user.id, w.clock));
    expect(until).toEqual(new Date(w.clock.now().getTime() + CLAIM_LEASE_MS));
    expect(await lease(w, user.id)).toMatchObject({
      purpose: "claim-lease",
      identifier: user.id,
      expiresAt: until,
      consumedAt: null,
    });
    expect(await w.mem.transaction((tx) => releaseClaim(tx, user.id, until))).toBe(true);
    expect(await lease(w, user.id)).toBeNull();
  });

  it("throws ClaimLostError with held while a lease row stays, live or stale, and a claim takes the stale one", async () => {
    const w = world();
    const user = await signedUp(w);
    const hold = () =>
      w.mem
        .transaction((tx) => holdClaim(tx, user.id, w.clock))
        .then(() => null)
        .catch((e: unknown) => e);
    expect(await hold()).toBeNull();
    const live = await hold();
    expect(live).toBeInstanceOf(ClaimLostError);
    expect((live as ClaimLostError).held).toBe(true);
    // After its life the lease is stale: the lease of a stopped writer, or of
    // a claim that runs past its life. The hold takes no stale lease.
    w.advance(CLAIM_LEASE_MS + 1_000);
    const stale = await hold();
    expect(stale).toBeInstanceOf(ClaimLostError);
    expect((stale as ClaimLostError).held).toBe(true);
    // A claim takes the stale lease, so the owner waits for no sweep.
    expect(await ownerLink(w, w.d1())).toBe("ok a session");
    expect((await lease(w, user.id))?.expiresAt).toEqual(
      new Date(w.clock.now().getTime() + CLAIM_LEASE_MS),
    );
  });

  it("makes the owner's link answer 409 while it holds, and the link after the release claims", async () => {
    const w = world();
    const user = await signedUp(w);
    const until = await w.mem.transaction((tx) => holdClaim(tx, user.id, w.clock));
    // The memory store retries three times after a wait of 100 ms, then answers 409.
    expect(await ownerLink(w, w.auth())).toBe("conflict");
    // A store with a query limit runs no retry.
    expect(await ownerLink(w, w.d1())).toBe("conflict");
    // The claimant keeps the user while the hold lives: no claim wrote.
    expect((await userAt(w, EMAIL)).emailVerified).toBe(false);
    expect(await w.mem.findMany("password", [])).toHaveLength(1);
    await w.mem.transaction((tx) => releaseClaim(tx, user.id, until));
    expect(await ownerLink(w, w.d1())).toBe("ok a session");
    expect((await userAt(w, EMAIL)).emailVerified).toBe(true);
    expect(await w.mem.findMany("password", [])).toEqual([]);
  });

  it("throws ClaimLostError with no held for a user that a claim verified, after the sweep deleted the claim's lease, and leaves no lease", async () => {
    const w = world();
    const user = await signedUp(w);
    // The owner's claim verifies the user and leaves its lease on this store.
    expect(await ownerLink(w, w.d1())).toBe("ok a session");
    expect(await lease(w, user.id)).not.toBeNull();
    // The app's sweep deletes that lease after its life.
    w.advance(CLAIM_LEASE_MS + 1_000);
    await w.auth().api.sweepExpired();
    expect(await lease(w, user.id)).toBeNull();
    const calls: string[] = [];
    const thrown = await w.mem
      .transaction((tx) => holdClaim(recordingView(tx, calls), user.id, w.clock))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ClaimLostError);
    expect((thrown as ClaimLostError).held).toBe(false);
    // The lease create, the flag read, and the delete of its own lease.
    expect(calls).toEqual(["create verification", "update user", "delete verification"]);
    expect(await lease(w, user.id)).toBeNull();
  });

  it("deletes no lease of a claim that took the stale lease of the hold, and answers false", async () => {
    const w = world();
    const user = await signedUp(w);
    const until = await w.mem.transaction((tx) => holdClaim(tx, user.id, w.clock));
    // The writer waits past the life of its lease, and the owner's claim takes it.
    w.advance(CLAIM_LEASE_MS + 1_000);
    expect(await ownerLink(w, w.d1())).toBe("ok a session");
    const claims = await lease(w, user.id);
    expect(claims?.expiresAt).toEqual(new Date(w.clock.now().getTime() + CLAIM_LEASE_MS));
    // The release of the hold matches no row: the claim's lease has the same id and another expiry.
    expect(await w.mem.transaction((tx) => releaseClaim(tx, user.id, until))).toBe(false);
    expect(await lease(w, user.id)).toEqual(claims);
  });
});

describe("holdClaim and releaseClaim on an isolated store", () => {
  it("holds the user row with one conditional update, writes no lease, and the release sends nothing", async () => {
    const w = world();
    const user = await signedUp(w);
    const calls: string[] = [];
    await w.mem.transaction(async (tx) => {
      const view = isolatedView(tx, calls);
      expect(await holdClaim(view, user.id, w.clock)).toBeNull();
      expect(await releaseClaim(view, user.id, null)).toBe(true);
    });
    expect(calls).toEqual(["update user"]);
    expect(await lease(w, user.id)).toBeNull();
  });

  it("throws ClaimLostError with no held for a verified user", async () => {
    const w = world();
    // A magic link of an address that no user holds makes a verified user.
    expect(await ownerLink(w, w.auth())).toBe("ok a session");
    const user = await userAt(w, EMAIL);
    const calls: string[] = [];
    const thrown = await w.mem
      .transaction((tx) => holdClaim(isolatedView(tx, calls), user.id, w.clock))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ClaimLostError);
    expect((thrown as ClaimLostError).held).toBe(false);
    expect(calls).toEqual(["update user", "findOne user"]);
  });
});
