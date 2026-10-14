import { describe, expect, it, vi } from "vitest";
import { ConfigError, type LegacyVerifyConfig, resolveConfig } from "../src/config.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import {
  LEGACY_VERIFY_HASH,
  passwordSignIn,
  requestPasswordReset,
  resetPassword,
} from "../src/engine/password.js";
import { newId } from "../src/primitives/ids.js";
import { currentSecret } from "../src/primitives/keyring.js";
import { makeAuth, tokenFromMail } from "./helpers.js";
import { FAST, pwAuth } from "./password-helpers.js";

const EMAIL = "ada@example.com";
const PW = "correct horse battery";

/**
 * The rows an importer writes for a Cognito user (plan 9b): the user, the
 * `email` identity when the source says the address is verified, and a
 * password row that holds the marker. The importer is a product path, so
 * this state is reachable.
 */
async function importedUser(auth: ReturnType<typeof makeAuth>, emailVerified = true) {
  const now = auth.clock.now();
  const user = await auth.storage.create("user", {
    id: newId(now),
    email: EMAIL,
    emailVerified,
    name: null,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
  if (emailVerified) {
    await auth.storage.create("identity", {
      id: newId(now),
      userId: user.id,
      provider: "email",
      subject: EMAIL,
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  const row = await auth.storage.create("password", {
    id: newId(now),
    userId: user.id,
    hash: LEGACY_VERIFY_HASH,
    createdAt: now,
    updatedAt: now,
  });
  return { user, row };
}

/**
 * A verified user with no password row: the user and its `email` identity,
 * as core writes them on every verify (and as the importer writes them for
 * a verified source row).
 */
async function verifiedUser(auth: ReturnType<typeof makeAuth>, email: string) {
  const user = await auth.seedUser(email);
  const now = auth.clock.now();
  await auth.storage.create("identity", {
    id: newId(now),
    userId: user.id,
    provider: "email",
    subject: email,
    linkedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return user;
}

/** A fake old system: the one right password per address, and a record of every call. */
function oldSystem(right: Record<string, string>) {
  const calls: { email: string; password: string; signal: AbortSignal }[] = [];
  const verify = vi.fn(async (email: string, password: string, signal: AbortSignal) => {
    calls.push({ email, password, signal });
    return right[email] === password;
  });
  return { verify, calls };
}

function legacyAuth(legacyVerify: LegacyVerifyConfig) {
  return pwAuth({ legacyVerify });
}

const signIn = (auth: ReturnType<typeof makeAuth>, email: string, password: string) =>
  passwordSignIn(auth.config, { email, password, ip: "1.1.1.1", userAgent: "ua" });

describe("password.legacyVerify (spec 17.4)", () => {
  it("signs in through the old system once, then writes a real hash over the marker", async () => {
    const old = oldSystem({ [EMAIL]: PW });
    const auth = legacyAuth({ verify: old.verify, timeoutMs: 100 });
    const { row } = await importedUser(auth);
    const first = await signIn(auth, " Ada@Example.com ", PW);
    expect(first.ok).toBe(true);
    // The normalized address, the password as typed, and a live signal.
    expect(old.calls).toHaveLength(1);
    expect(old.calls[0]?.email).toBe(EMAIL);
    expect(old.calls[0]?.password).toBe(PW);
    expect(old.calls[0]?.signal.aborted).toBe(false);
    const after = await auth.storage.findOne("password", [
      { field: "id", op: "eq", value: row.id },
    ]);
    expect(after?.hash).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(await auth.storage.findMany("session", [])).toHaveLength(1);
    // The second sign-in reads the real hash. The old system is not asked again.
    expect((await signIn(auth, EMAIL, PW)).ok).toBe(true);
    expect(old.verify).toHaveBeenCalledTimes(1);
  });

  it("answers invalid_credentials and keeps the marker when the old system says no", async () => {
    const old = oldSystem({ [EMAIL]: PW });
    const auth = legacyAuth({ verify: old.verify, timeoutMs: 100 });
    const { row } = await importedUser(auth);
    expect(await signIn(auth, EMAIL, "wrong horse battery")).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
    const after = await auth.storage.findOne("password", [
      { field: "id", op: "eq", value: row.id },
    ]);
    expect(after?.hash).toBe(LEGACY_VERIFY_HASH);
    expect(await auth.storage.findMany("session", [])).toHaveLength(0);
  });

  it("answers invalid_credentials when the old system throws or answers a value that is not true", async () => {
    for (const verify of [
      async () => {
        throw new Error("the old system is down");
      },
      async () => "true" as unknown as boolean,
      async () => 1 as unknown as boolean,
    ]) {
      const auth = legacyAuth({ verify, timeoutMs: 100 });
      await importedUser(auth);
      expect(await signIn(auth, EMAIL, PW)).toMatchObject({
        ok: false,
        code: "invalid_credentials",
      });
    }
  });

  it("answers invalid_credentials when the old system does not answer in time, and aborts the call", async () => {
    let signal: AbortSignal | null = null;
    const auth = legacyAuth({
      verify: (_e, _p, s) => {
        signal = s;
        return new Promise<boolean>(() => {});
      },
      timeoutMs: 150,
    });
    await importedUser(auth);
    const t0 = Date.now();
    expect(await signIn(auth, EMAIL, PW)).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  it("answers every failure no earlier than timeoutMs, so a legacy row looks like an unknown address (Review Focus 3)", async () => {
    const old = oldSystem({ [EMAIL]: PW });
    const auth = legacyAuth({ verify: old.verify, timeoutMs: 300 });
    await importedUser(auth);
    // A user with a real PBKDF2 hash: a wrong password on it gets the floor too.
    const bob = await verifiedUser(auth, "bob@example.com");
    const now = auth.clock.now();
    await auth.storage.create("password", {
      id: newId(now),
      userId: bob.id,
      hash: await FAST.hash("another horse"),
      createdAt: now,
      updatedAt: now,
    });
    // t0 is read before the sign-in starts, so the time from t0 is never less
    // than the time from the check's start. The 5 ms margin is for the
    // rounding of Date.now against the timer.
    const timed = async (a: ReturnType<typeof makeAuth>, email: string, password: string) => {
      const t0 = Date.now();
      expect(await signIn(a, email, password)).toMatchObject({
        ok: false,
        code: "invalid_credentials",
      });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(295);
    };
    for (const [email, password] of [
      [EMAIL, "wrong horse battery"],
      ["bob@example.com", "wrong horse battery"],
      ["nobody@example.com", PW],
      ["not an address", PW],
    ] as const) {
      await timed(auth, email, password);
    }
    // An old system that throws at once, and one that never answers.
    const throws = legacyAuth({
      verify: async () => {
        throw new Error("the old system is down");
      },
      timeoutMs: 300,
    });
    await importedUser(throws);
    await timed(throws, EMAIL, PW);
    const silent = legacyAuth({ verify: () => new Promise<boolean>(() => {}), timeoutMs: 300 });
    await importedUser(silent);
    await timed(silent, EMAIL, PW);
    // A right password is not held back.
    const t0 = Date.now();
    expect((await signIn(auth, EMAIL, PW)).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(295);
  });

  it("runs the dummy verify on the legacy path, so its CPU equals a wrong password's", async () => {
    const old = oldSystem({ [EMAIL]: PW });
    const auth = legacyAuth({ verify: old.verify, timeoutMs: 100 });
    const verify = vi.spyOn(FAST, "verify");
    try {
      await importedUser(auth);
      await signIn(auth, EMAIL, "wrong horse battery");
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledWith("wrong horse battery", await FAST.dummy());
    } finally {
      verify.mockRestore();
    }
  });

  it("applies the sign-in limits before the old system is asked", async () => {
    const old = oldSystem({ [EMAIL]: PW });
    const auth = legacyAuth({ verify: old.verify, timeoutMs: 100 });
    await importedUser(auth);
    for (let i = 0; i < 10; i++) await signIn(auth, EMAIL, "wrong horse battery");
    expect(old.verify).toHaveBeenCalledTimes(10);
    expect(await signIn(auth, EMAIL, PW)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(old.verify).toHaveBeenCalledTimes(10);
  });

  it("never asks the old system for a user with no password row, or with a real hash", async () => {
    const old = oldSystem({ [EMAIL]: PW, "bob@example.com": PW });
    const auth = legacyAuth({ verify: old.verify, timeoutMs: 100 });
    await verifiedUser(auth, EMAIL);
    expect(await signIn(auth, EMAIL, PW)).toMatchObject({ ok: false, code: "invalid_credentials" });
    const bob = await verifiedUser(auth, "bob@example.com");
    const now = auth.clock.now();
    await auth.storage.create("password", {
      id: newId(now),
      userId: bob.id,
      hash: await FAST.hash("another horse"),
      createdAt: now,
      updatedAt: now,
    });
    expect(await signIn(auth, "bob@example.com", PW)).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
    expect(old.verify).not.toHaveBeenCalled();
  });

  it("refuses the marker with no old system configured, with the dummy cost", async () => {
    const auth = pwAuth();
    // The counting seam: every verify call and its stored-hash argument.
    const verify = vi.spyOn(FAST, "verify");
    try {
      await importedUser(auth);
      expect(await signIn(auth, EMAIL, PW)).toMatchObject({
        ok: false,
        code: "invalid_credentials",
      });
      // One verify, against dummy(): the legacy branch refused. Without that
      // branch the sign-in verifies against the marker itself.
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledWith(PW, await FAST.dummy());
      expect(verify).not.toHaveBeenCalledWith(PW, LEGACY_VERIFY_HASH);
    } finally {
      verify.mockRestore();
    }
  });

  it("loses the old password when the mailbox owner claims an unverified import", async () => {
    const old = oldSystem({ [EMAIL]: PW });
    const auth = legacyAuth({ verify: old.verify, timeoutMs: 100 });
    await importedUser(auth, false);
    await requestMagicLink(auth.config, { email: EMAIL, ip: null });
    const ml = await verifyMagicLink(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    expect(ml.ok).toBe(true);
    expect(await auth.storage.findMany("password", [])).toHaveLength(0);
    // The claimant who knew the old system's password does not get in.
    expect(await signIn(auth, EMAIL, PW)).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(old.verify).not.toHaveBeenCalled();
  });

  it("ends a silent old system at the floor, not timeoutMs after the call (Review I-1)", async () => {
    // A hash seam whose verify takes 100 ms: the lookups and the dummy
    // verify run before the old system is asked, as on a real deployment.
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const slow = {
      hash: (plain: string) => FAST.hash(plain),
      verify: async (plain: string, stored: string) => {
        await sleep(100);
        return FAST.verify(plain, stored);
      },
      dummy: () => FAST.dummy(),
    };
    const auth = pwAuth({
      hash: slow,
      legacyVerify: { verify: () => new Promise<boolean>(() => {}), timeoutMs: 300 },
    });
    await importedUser(auth);
    const t0 = Date.now();
    expect(await signIn(auth, EMAIL, PW)).toMatchObject({ ok: false, code: "invalid_credentials" });
    const took = Date.now() - t0;
    // At the floor: an unknown address answers at 300 ms too. A timer from
    // the call would answer at about 400 ms.
    expect(took).toBeGreaterThanOrEqual(295);
    expect(took).toBeLessThan(350);
  });

  it("commits no session when the owner claims the address while the old system answers (Review M-1)", async () => {
    const auth = legacyAuth({
      verify: async (_e, _p, signal) => {
        // The mailbox owner's magic link, while the claimant's check runs.
        await requestMagicLink(auth.config, { email: EMAIL, ip: null });
        const ml = await verifyMagicLink(auth.config, {
          token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
          ip: null,
          userAgent: null,
        });
        if (!ml.ok) throw new Error(ml.code);
        answered = !signal.aborted;
        return true;
      },
      timeoutMs: 1000,
    });
    let answered = false;
    await importedUser(auth, false);
    expect(await signIn(auth, EMAIL, PW)).toMatchObject({ ok: false, code: "invalid_credentials" });
    // The old system answered true before the timeout; the refusal is the row check.
    expect(answered).toBe(true);
    expect(await auth.storage.findMany("password", [])).toHaveLength(0);
    // Only the owner's magic-link session.
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions).toHaveLength(1);
    expect(await auth.storage.findMany("identity", [])).toMatchObject([
      { provider: "email", subject: EMAIL, userId: sessions[0]?.userId },
    ]);
  });

  it("keeps the owner's reset when it lands while the old system answers (Review M-1)", async () => {
    let resetSession: string | null = null;
    let answered = false;
    const auth = legacyAuth({
      verify: async (_e, _p, signal) => {
        // The owner's reset, while the claimant's check runs.
        await requestPasswordReset(auth.config, { email: EMAIL, ip: null });
        const r = await resetPassword(auth.config, {
          token: tokenFromMail(
            auth.mail.filter((m) => m.subject.startsWith("Reset")).at(-1)?.text ?? "",
          ),
          password: "the owner's new password",
          ip: null,
          userAgent: null,
        });
        if (!r.ok) throw new Error(r.code);
        if (!("token" in r.value)) throw new Error("the reset answered a challenge");
        resetSession = r.value.session.id;
        answered = !signal.aborted;
        return true;
      },
      timeoutMs: 1000,
    });
    const { row } = await importedUser(auth);
    expect(await signIn(auth, EMAIL, PW)).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(answered).toBe(true);
    // The row holds the reset's hash, not the claimant's old password.
    const after = await auth.storage.findOne("password", [
      { field: "id", op: "eq", value: row.id },
    ]);
    expect(after?.hash).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect((await FAST.verify("the owner's new password", after?.hash ?? "")).ok).toBe(true);
    expect((await FAST.verify(PW, after?.hash ?? "")).ok).toBe(false);
    // Only the reset's session.
    const sessions = await auth.storage.findMany("session", []);
    expect(sessions.map((s) => s.id)).toEqual([resetSession]);
  });

  it("refuses a timeoutMs outside 100 to 30000", () => {
    const base = makeAuth().config;
    for (const timeoutMs of [99, 30_001, 1.5]) {
      expect(() =>
        resolveConfig({
          baseURL: base.baseURL,
          secret: currentSecret(base.keyring),
          trustedOrigins: [],
          storage: base.storage,
          mail: base.mail,
          password: { legacyVerify: { verify: async () => false, timeoutMs } },
        }),
      ).toThrow(ConfigError);
    }
  });
});
