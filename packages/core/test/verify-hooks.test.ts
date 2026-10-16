import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import {
  requestEmailOtp,
  requestResetOtp,
  resetPasswordWithOtp,
  verifyEmailOtp,
} from "../src/engine/email-otp.js";
import { type HooksConfig, hookRefusal } from "../src/engine/hooks.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import {
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { completeSocial } from "../src/engine/social.js";
import { newId } from "../src/primitives/ids.js";
import type { Result } from "../src/result.js";
import { type IdentityRow, type ModelName, schema, type UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { tokenFromMail } from "./helpers.js";
import { FAST, recordNextTransaction } from "./password-helpers.js";
import {
  type FakeIdToken,
  fakeJwt,
  googleClaims,
  socialAuth,
  startGoogle,
} from "./social-helpers.js";

// Plan 12a, Task 18: `user.beforeVerify` and `user.afterVerify`.

afterEach(() => {
  vi.restoreAllMocks();
});

const EMAIL = "ada@example.com";

/**
 * Hooks that write the verify points as `before:<via>:<emailVerified>` and
 * `after:<via>:<emailVerified>`, and every point in order into `all`.
 * `refuse` makes `beforeVerify` refuse.
 */
function recorded() {
  /** `parallel` runs once from `beforeVerify`, as a parallel request on another connection. */
  const flag: { refuse: boolean; parallel: (() => Promise<void>) | null } = {
    refuse: false,
    parallel: null,
  };
  const verify: string[] = [];
  const all: string[] = [];
  const afterUsers: UserRow[] = [];
  const hooks: HooksConfig = {
    user: {
      beforeVerify: async (e) => {
        verify.push(`before:${e.via}:${e.user.emailVerified}`);
        all.push(`user.beforeVerify:${e.via}`);
        if (flag.refuse) throw hookRefusal("no");
        const parallel = flag.parallel;
        flag.parallel = null;
        if (parallel) await parallel();
      },
      afterVerify: (e) => {
        verify.push(`after:${e.via}:${e.user.emailVerified}`);
        all.push(`user.afterVerify:${e.via}`);
        afterUsers.push(e.user);
      },
      beforeCreate: (e) => {
        all.push(`user.beforeCreate:${e.via}`);
      },
      afterCreate: (e) => {
        all.push(`user.afterCreate:${e.via}`);
      },
    },
    identity: {
      beforeLink: (e) => {
        all.push(`identity.beforeLink:${e.via}`);
      },
      afterLink: (e) => {
        all.push(`identity.afterLink:${e.via}`);
      },
    },
    session: {
      beforeCreate: () => {
        all.push("session.beforeCreate");
      },
      afterCreate: () => {
        all.push("session.afterCreate");
      },
      afterEnd: (e) => {
        all.push(`session.afterEnd:${e.reason}`);
      },
    },
  };
  return { flag, verify, all, afterUsers, hooks };
}

/** One auth with every verify path on: social through a fake jwt seam, the detailed password sign-up. */
function world(extra: Partial<AuthConfig> = {}) {
  const r = recorded();
  const tokens: Record<string, FakeIdToken> = {};
  const auth = socialAuth(
    { hooks: r.hooks, password: { hash: FAST, uniformSignUp: false }, ...extra },
    fakeJwt(tokens),
  );
  return { ...r, auth, tokens };
}
type World = ReturnType<typeof world>;

function lastCode(w: World): string {
  return /\b(\d{6})\b/.exec(w.auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
}

/** A detailed password sign-up: an unverified user with a session and a verify link. */
async function signUp(w: World) {
  const up = await passwordSignUp(w.auth.config, {
    email: EMAIL,
    password: "correct horse battery",
    ip: null,
    userAgent: null,
  });
  if (!up.ok) throw new Error(up.code);
}

function verifyLink(w: World) {
  const mail = w.auth.mail.findLast((m) => m.subject.startsWith("Confirm"));
  return verifyPasswordEmail(w.auth.config, {
    token: tokenFromMail(mail?.text ?? ""),
    ip: null,
    userAgent: null,
  });
}

async function magicLink(w: World) {
  await requestMagicLink(w.auth.config, { email: EMAIL, ip: null });
  return verifyMagicLink(w.auth.config, {
    token: tokenFromMail(w.auth.mail.at(-1)?.text ?? ""),
    ip: null,
    userAgent: null,
  });
}

async function emailCode(w: World) {
  await requestEmailOtp(w.auth.config, { email: EMAIL, ip: null });
  return verifyEmailOtp(w.auth.config, {
    email: EMAIL,
    code: lastCode(w),
    ip: null,
    userAgent: null,
  });
}

async function google(w: World, claims: Record<string, unknown> = {}) {
  const s = await startGoogle(w.auth);
  w.tokens["idtok-default"] = googleClaims(s.nonce, claims);
  return completeSocial(w.auth.config, {
    provider: "google",
    state: s.state,
    code: "c",
    error: null,
    bindToken: s.bindToken,
    ip: null,
    userAgent: null,
  });
}

async function resetLink(w: World) {
  await requestPasswordReset(w.auth.config, { email: EMAIL, ip: null });
  return resetPassword(w.auth.config, {
    token: tokenFromMail(w.auth.mail.at(-1)?.text ?? ""),
    password: "a new long password",
    ip: null,
    userAgent: null,
  });
}

async function resetCode(w: World) {
  await requestResetOtp(w.auth.config, { email: EMAIL, ip: null });
  return resetPasswordWithOtp(w.auth.config, {
    email: EMAIL,
    code: lastCode(w),
    password: "a new long password",
    ip: null,
    userAgent: null,
  });
}

/** Every path that verifies an existing unverified user, with the setup that makes that user. */
const PATHS: {
  name: string;
  via: string;
  setup: (w: World) => Promise<unknown>;
  run: (w: World) => Promise<Result<unknown>>;
}[] = [
  { name: "the password verify link", via: "password_verify", setup: signUp, run: verifyLink },
  { name: "a magic link of an unverified user", via: "magic_link", setup: signUp, run: magicLink },
  {
    name: "an email code sign-in of an unverified user",
    via: "email_otp",
    setup: signUp,
    run: emailCode,
  },
  {
    name: "a Google sign-in with a verified address of an unverified user",
    via: "social",
    setup: signUp,
    run: (w) => google(w),
  },
  {
    name: "a Google sign-in through a linked identity that now proves the address",
    via: "social",
    setup: (w) => google(w, { email_verified: false }),
    run: (w) => google(w),
  },
  { name: "a reset of an unverified user", via: "password_reset", setup: signUp, run: resetLink },
  {
    name: "a reset by code of an unverified user",
    via: "password_reset",
    setup: signUp,
    run: resetCode,
  },
];

async function userRow(w: World): Promise<UserRow> {
  const user = await w.auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
  if (!user) throw new Error("no user");
  return user;
}

/** Every row of every table of the memory storage, except the tables in `skip`. */
async function tables(w: World, skip: ModelName[] = []) {
  const out: Record<string, unknown[]> = {};
  for (const model of Object.keys(schema) as ModelName[])
    if (!skip.includes(model)) out[model] = await w.auth.storage.findMany(model, []);
  return out;
}

/**
 * A world whose next identity create of `provider` meets a parallel flow on
 * another connection. That flow links the same identity and claims the
 * user. Its identity lands just before this attempt's create, so the create
 * fails on the unique key. Its flag lands after this attempt rolled back.
 * The rows at the end are the rows that the parallel flow commits.
 */
function winnerRace(provider: string) {
  const inner = createMemoryAdapter();
  const armed = { on: false };
  let winner: string | null = null;
  const wrap = (a: StorageAdapter): StorageAdapter => ({
    create: async (m, d) => {
      const row = d as unknown as IdentityRow;
      if (m === "identity" && armed.on && row.provider === provider) {
        armed.on = false;
        winner = row.userId;
        await inner.create("identity", { ...row, id: newId(new Date()) });
      }
      return a.create(m, d);
    },
    findOne: (m, w) => a.findOne(m, w),
    findMany: (m, w, o) => a.findMany(m, w, o),
    update: (m, w, d) => a.update(m, w, d),
    delete: (m, w) => a.delete(m, w),
    transaction: (fn) =>
      a
        .transaction((tx) => fn(wrap(tx)))
        .catch(async (e: unknown) => {
          if (winner) {
            await inner.update("user", [{ field: "id", op: "eq", value: winner }], {
              emailVerified: true,
            });
            winner = null;
          }
          throw e;
        }),
  });
  const made = world({ storage: wrap(inner) });
  const w: World = { ...made, auth: { ...made.auth, storage: inner } };
  return { w, armed };
}

describe("user.beforeVerify and user.afterVerify (plan 12a, Task 18)", () => {
  for (const path of PATHS) {
    it(`runs the pair once at ${path.name}`, async () => {
      const w = world();
      await path.setup(w);
      expect((await userRow(w)).emailVerified).toBe(false);
      expect(w.verify).toEqual([]);
      expect((await path.run(w)).ok).toBe(true);
      expect(w.verify).toEqual([`before:${path.via}:false`, `after:${path.via}:true`]);
      // afterVerify sees the stored row after the commit.
      expect(w.afterUsers).toEqual([await userRow(w)]);
    });

    it(`a refusal in beforeVerify at ${path.name} leaves the user unverified and changes no row but the spent proof`, async () => {
      const w = world();
      await path.setup(w);
      const before = await tables(w, ["verification"]);
      w.flag.refuse = true;
      expect(await path.run(w)).toMatchObject({ ok: false, code: "hook_refused", message: "no" });
      expect(w.verify).toEqual([`before:${path.via}:false`]);
      expect(await tables(w, ["verification"])).toEqual(before);
      expect((await userRow(w)).emailVerified).toBe(false);
    });
  }

  it("leaves the user unverified and writes nothing after a refusal in beforeVerify", async () => {
    const w = world();
    await signUp(w);
    const before = await tables(w);
    const link = (before.verification as { purpose: string }[] | undefined)?.find(
      (v) => v.purpose === "password-verify",
    );
    w.flag.refuse = true;
    const writes = recordNextTransaction(w.auth.storage);
    expect(await verifyLink(w)).toMatchObject({ ok: false, code: "hook_refused", message: "no" });
    // The hook runs before the first write of the transaction, so the
    // refusal writes nothing there.
    expect(writes).toEqual([]);
    // The one change is the spend of the link, which runs before the
    // transaction, as for a refusal of the session hook.
    if (!link) throw new Error("no verify link");
    expect(await tables(w)).toEqual({
      ...before,
      verification: (before.verification ?? []).map((v) =>
        v === link ? { ...link, consumedAt: expect.any(Date), updatedAt: expect.any(Date) } : v,
      ),
    });
    expect((await userRow(w)).emailVerified).toBe(false);
    expect(w.verify).toEqual(["before:password_verify:false"]);
  });

  it("runs neither point at a sign-in of a verified user, or at the create of a new verified user", async () => {
    const w = world();
    expect((await magicLink(w)).ok).toBe(true);
    expect(w.all).toContain("user.afterCreate:magic_link");
    expect((await magicLink(w)).ok).toBe(true);
    expect((await emailCode(w)).ok).toBe(true);
    expect((await google(w)).ok).toBe(true);
    expect((await google(w)).ok).toBe(true);
    expect((await resetLink(w)).ok).toBe(true);
    const created = world();
    expect((await google(created)).ok).toBe(true);
    expect(created.all).toContain("user.afterCreate:social");
    expect(w.verify).toEqual([]);
    expect(created.verify).toEqual([]);
  });

  for (const path of PATHS)
    it(`retries once and fires no afterVerify when a parallel proof claims first at ${path.name} (review M1)`, async () => {
      // The parallel flow's claim lands between this flow's read and its
      // claim: its first statement, the conditional flip of the flag, commits
      // on another connection. This flow's conditional flip then finds no
      // unverified row. It undoes its attempt, and the retry finds a verified user.
      const w = world();
      await path.setup(w);
      const user = await userRow(w);
      w.flag.parallel = async () => {
        await w.auth.storage.update(
          "user",
          [
            { field: "id", op: "eq", value: user.id },
            { field: "emailVerified", op: "eq", value: false },
          ],
          { emailVerified: true, updatedAt: new Date(user.updatedAt.getTime() + 1) },
        );
      };
      expect((await path.run(w)).ok).toBe(true);
      expect(w.verify).toEqual([`before:${path.via}:false`]);
      expect(w.afterUsers).toEqual([]);
      expect((await userRow(w)).emailVerified).toBe(true);
    });

  const ORDER: {
    name: string;
    setup: (w: World) => Promise<unknown>;
    run: (w: World) => Promise<Result<unknown>>;
    events: string[];
  }[] = [
    {
      name: "a Google sign-in that links and verifies",
      setup: signUp,
      run: (w) => google(w),
      events: [
        "user.beforeVerify:social",
        "identity.beforeLink:sign_in",
        "session.beforeCreate",
        "user.afterVerify:social",
        "identity.afterLink:sign_in",
        "session.afterEnd:claim",
        "session.afterCreate",
      ],
    },
    {
      name: "a Google sign-in through a linked identity that now proves the address",
      setup: (w) => google(w, { email_verified: false }),
      run: (w) => google(w),
      events: [
        "user.beforeVerify:social",
        "session.beforeCreate",
        "user.afterVerify:social",
        "session.afterEnd:claim",
        "session.afterCreate",
      ],
    },
    {
      name: "a magic link of an unverified user",
      setup: signUp,
      run: magicLink,
      events: [
        "user.beforeVerify:magic_link",
        "session.beforeCreate",
        "user.afterVerify:magic_link",
        "session.afterEnd:claim",
        "session.afterCreate",
      ],
    },
    {
      name: "the password verify link",
      setup: signUp,
      run: verifyLink,
      events: [
        "user.beforeVerify:password_verify",
        "session.beforeCreate",
        "user.afterVerify:password_verify",
        "session.afterEnd:claim",
        "session.afterCreate",
      ],
    },
  ];
  for (const path of ORDER)
    it(`runs the points in the order of rule 4 at ${path.name}`, async () => {
      const w = world();
      await path.setup(w);
      w.all.length = 0;
      expect((await path.run(w)).ok).toBe(true);
      expect(w.all).toEqual(path.events);
    });

  it("runs no verify point at the verify link of a user that a reset already verified (review L2)", async () => {
    const w = world();
    await signUp(w);
    expect((await resetLink(w)).ok).toBe(true);
    expect((await userRow(w)).emailVerified).toBe(true);
    w.verify.length = 0;
    // The reset keeps the password row id, so the old verify link still answers ok.
    expect(await verifyLink(w)).toMatchObject({ ok: true, value: { signedIn: null } });
    expect(w.verify).toEqual([]);
  });

  it("keeps the reset link after a refusal in beforeVerify: the same link passes once the app allows it (review L3)", async () => {
    const w = world();
    await signUp(w);
    await requestPasswordReset(w.auth.config, { email: EMAIL, ip: null });
    const input = {
      token: tokenFromMail(w.auth.mail.at(-1)?.text ?? ""),
      password: "a new long password",
      ip: null,
      userAgent: null,
    };
    w.flag.refuse = true;
    expect(await resetPassword(w.auth.config, input)).toMatchObject({
      ok: false,
      code: "hook_refused",
    });
    w.flag.refuse = false;
    expect((await resetPassword(w.auth.config, input)).ok).toBe(true);
    expect(w.verify).toEqual([
      "before:password_reset:false",
      "before:password_reset:false",
      "after:password_reset:true",
    ]);
  });

  it("fires no afterVerify when a social retry after a unique-key race finds the user verified by the winner", async () => {
    // A parallel Google sign-in of the same account links it and claims the user.
    const race = winnerRace("google");
    await signUp(race.w);
    race.armed.on = true;
    expect((await google(race.w)).ok).toBe(true);
    expect(race.armed.on).toBe(false);
    expect(race.w.verify).toEqual(["before:social:false"]);
    expect((await userRow(race.w)).emailVerified).toBe(true);
  });

  it("fires no afterVerify when a reset retry after a unique-key race finds the user verified by the winner", async () => {
    // A parallel magic link of the address writes the email identity and claims the user.
    const race = winnerRace("email");
    await signUp(race.w);
    race.armed.on = true;
    expect((await resetLink(race.w)).ok).toBe(true);
    expect(race.armed.on).toBe(false);
    expect(race.w.verify).toEqual(["before:password_reset:false"]);
    expect((await userRow(race.w)).emailVerified).toBe(true);
  });

  it("logs a throw of user.afterVerify in one line, and the verify stands", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({
      hooks: {
        user: {
          afterVerify: () => {
            throw new TypeError("mirror down for ada@example.com");
          },
        },
      },
    });
    await signUp(w);
    expect((await verifyLink(w)).ok).toBe(true);
    const user = await userRow(w);
    expect(user.emailVerified).toBe(true);
    expect(log.mock.calls).toEqual([
      ["authtempo: after hook failed", "user.afterVerify", user.id, "TypeError"],
    ]);
  });
});
