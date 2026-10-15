import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, ConfigError } from "../src/config.js";
import { patchedNewUser } from "../src/engine/create-steps.js";
import {
  requestEmailOtp,
  requestResetOtp,
  resetPasswordWithOtp,
  verifyEmailOtp,
} from "../src/engine/email-otp.js";
import { HookStop, type HooksConfig, hookRefusal } from "../src/engine/hooks.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { passwordSignUp, requestPasswordReset, resetPassword } from "../src/engine/password.js";
import { completeSocial } from "../src/engine/social.js";
import { validImageUrl } from "../src/engine/users.js";
import { newId } from "../src/primitives/ids.js";
import type { Result } from "../src/result.js";
import type { IdentityRow, UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth, post, tokenFromMail } from "./helpers.js";
import { FAST, pwHandle } from "./password-helpers.js";
import {
  type FakeIdToken,
  fakeJwt,
  googleClaims,
  socialAuth,
  startGoogle,
} from "./social-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Hooks that write each event as `point:detail`, and answer `patch` from `user.beforeCreate`. */
function recorded(patch?: unknown) {
  const events: string[] = [];
  const hooks: HooksConfig = {
    user: {
      beforeCreate: (e) => {
        events.push(`user.beforeCreate:${e.via}:${e.user.email}`);
        return patch as never;
      },
      afterCreate: (e) => {
        events.push(`user.afterCreate:${e.via}:${e.user.name ?? "-"}`);
      },
    },
    identity: {
      beforeLink: (e) => {
        events.push(`identity.beforeLink:${e.via}:${e.identity.provider}`);
      },
      afterLink: (e) => {
        events.push(`identity.afterLink:${e.via}:${e.identity.provider}`);
      },
    },
    session: {
      beforeCreate: () => {
        events.push("session.beforeCreate");
      },
      afterCreate: () => {
        events.push("session.afterCreate");
      },
    },
  };
  return { events, hooks };
}

/** One auth with every create path on: social through a fake jwt seam, password with a fast hash. */
function world(hooks: HooksConfig, extra: Partial<AuthConfig> = {}) {
  const tokens: Record<string, FakeIdToken> = {};
  const auth = socialAuth({ hooks, password: { hash: FAST }, ...extra }, fakeJwt(tokens));
  return { auth, tokens };
}
type World = ReturnType<typeof world>;
/** The auth of a plain test or of a world: the flows need only these fields. */
type Auth = ReturnType<typeof makeAuth>;

async function magicLink(auth: Auth, email: string) {
  await requestMagicLink(auth.config, { email, ip: null });
  return verifyMagicLink(auth.config, {
    token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
    ip: null,
    userAgent: null,
  });
}

function lastCode(auth: Auth): string {
  return /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
}

async function emailCode(auth: Auth, email: string) {
  await requestEmailOtp(auth.config, { email, ip: null });
  return verifyEmailOtp(auth.config, { email, code: lastCode(auth), ip: null, userAgent: null });
}

async function social(w: World, claims: Record<string, unknown> = {}) {
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

function signUp(auth: Auth, email: string) {
  return passwordSignUp(auth.config, {
    email,
    password: "correct horse battery",
    ip: null,
    userAgent: null,
  });
}

async function resetLink(auth: Auth, email: string) {
  await requestPasswordReset(auth.config, { email, ip: null });
  return resetPassword(auth.config, {
    token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
    password: "a new long password",
    ip: null,
    userAgent: null,
  });
}

async function resetCode(auth: Auth, email: string) {
  await requestResetOtp(auth.config, { email, ip: null });
  return resetPasswordWithOtp(auth.config, {
    email,
    code: lastCode(auth),
    password: "a new long password",
    ip: null,
    userAgent: null,
  });
}

/** Every path that creates a user, with the auth options it needs and the events of a new user. */
const PATHS: {
  name: string;
  extra: Partial<AuthConfig>;
  run: (w: World, email: string) => Promise<Result<unknown>>;
  events: (email: string) => string[];
  /** The answer to a refusal. The uniform sign-up hides it (lead ruling, 2026-10-15). */
  refused?: unknown;
}[] = [
  {
    name: "the magic link",
    extra: {},
    run: (w, email) => magicLink(w.auth, email),
    events: (email) => [
      `user.beforeCreate:magic_link:${email}`,
      "session.beforeCreate",
      "user.afterCreate:magic_link:-",
      "session.afterCreate",
    ],
  },
  {
    name: "the email code",
    extra: {},
    run: (w, email) => emailCode(w.auth, email),
    events: (email) => [
      `user.beforeCreate:email_otp:${email}`,
      "session.beforeCreate",
      "user.afterCreate:email_otp:-",
      "session.afterCreate",
    ],
  },
  {
    name: "a social sign-up",
    extra: {},
    run: (w, email) => social(w, { email }),
    events: (email) => [
      `user.beforeCreate:social:${email}`,
      "identity.beforeLink:sign_in:google",
      "session.beforeCreate",
      "user.afterCreate:social:Ada",
      "identity.afterLink:sign_in:google",
      "session.afterCreate",
    ],
  },
  {
    name: "the uniform password sign-up",
    extra: {},
    run: (w, email) => signUp(w.auth, email),
    events: (email) => [`user.beforeCreate:password:${email}`, "user.afterCreate:password:-"],
    refused: { ok: true, value: { sent: true } },
  },
  {
    name: "the password sign-up with uniformSignUp off",
    extra: { password: { hash: FAST, uniformSignUp: false } },
    run: (w, email) => signUp(w.auth, email),
    events: (email) => [
      `user.beforeCreate:password:${email}`,
      "session.beforeCreate",
      "user.afterCreate:password:-",
      "session.afterCreate",
    ],
  },
  {
    name: "the reset link",
    extra: {},
    run: (w, email) => resetLink(w.auth, email),
    events: (email) => [
      `user.beforeCreate:password_reset:${email}`,
      "session.beforeCreate",
      "user.afterCreate:password_reset:-",
      "session.afterCreate",
    ],
  },
  {
    name: "the reset code",
    extra: {},
    run: (w, email) => resetCode(w.auth, email),
    events: (email) => [
      `user.beforeCreate:password_reset:${email}`,
      "session.beforeCreate",
      "user.afterCreate:password_reset:-",
      "session.afterCreate",
    ],
  },
];

async function allRows(storage: StorageAdapter) {
  return {
    users: await storage.findMany("user", []),
    identities: await storage.findMany("identity", []),
    sessions: await storage.findMany("session", []),
  };
}

describe("hooks.user (plan 12a, spec 8.9)", () => {
  it("runs user.beforeCreate before the session hook, and its patch sets the name and the image", async () => {
    const seen: UserRow[] = [];
    const r = recorded({ name: "Ada", image: "https://img.example.com/a.png" });
    const hooks = {
      ...r.hooks,
      user: {
        ...r.hooks.user,
        afterCreate: (e: { user: UserRow; via: string }) => {
          seen.push(e.user);
          r.events.push(`user.afterCreate:${e.via}:${e.user.name ?? "-"}`);
        },
      },
    };
    const auth = makeAuth({ hooks });
    const v = await magicLink(auth, "new@example.com");
    expect(v.ok).toBe(true);
    expect(r.events).toEqual([
      "user.beforeCreate:magic_link:new@example.com",
      "session.beforeCreate",
      "user.afterCreate:magic_link:Ada",
      "session.afterCreate",
    ]);
    const row = await auth.storage.findOne("user", [
      { field: "email", op: "eq", value: "new@example.com" },
    ]);
    expect(row).toMatchObject({ name: "Ada", image: "https://img.example.com/a.png" });
    // afterCreate sees the stored row, with the id that core minted before the hook.
    expect(seen).toEqual([row]);
  });

  it("runs no user hook for a sign-in of a user that exists", async () => {
    const r = recorded();
    const auth = makeAuth({ hooks: r.hooks });
    expect((await magicLink(auth, "old@example.com")).ok).toBe(true);
    r.events.length = 0;
    expect((await magicLink(auth, "old@example.com")).ok).toBe(true);
    expect((await emailCode(auth, "old@example.com")).ok).toBe(true);
    expect(r.events).toEqual([
      "session.beforeCreate",
      "session.afterCreate",
      "session.beforeCreate",
      "session.afterCreate",
    ]);
  });

  for (const path of PATHS) {
    it(`fires each point once with its via on ${path.name}`, async () => {
      const r = recorded();
      const w = world(r.hooks, path.extra);
      expect((await path.run(w, "new@example.com")).ok).toBe(true);
      expect(r.events).toEqual(path.events("new@example.com"));
    });

    it(`a user.beforeCreate refusal on ${path.name} leaves no user, no identity, and no session`, async () => {
      const w = world(
        {
          user: {
            beforeCreate: () => {
              throw hookRefusal("Sign-ups are closed.");
            },
          },
        },
        path.extra,
      );
      expect(await path.run(w, "no@example.com")).toEqual(
        path.refused ?? {
          ok: false,
          code: "hook_refused",
          status: 403,
          message: "Sign-ups are closed.",
        },
      );
      expect(await allRows(w.auth.storage)).toEqual({ users: [], identities: [], sessions: [] });
    });
  }

  it("a refused reset keeps its link: the stop undoes the consume", async () => {
    const w = world({
      user: {
        beforeCreate: () => {
          throw hookRefusal("Not yet.");
        },
      },
    });
    expect((await resetLink(w.auth, "no@example.com")).ok).toBe(false);
    const links = await w.auth.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-reset" },
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]?.consumedAt).toBeNull();
  });

  it("an identity.beforeLink refusal on a social sign-up leaves no user and no identity", async () => {
    const w = world({
      identity: {
        beforeLink: () => {
          throw hookRefusal("No links today.");
        },
      },
    });
    expect(await social(w)).toMatchObject({
      ok: false,
      code: "hook_refused",
      message: "No links today.",
    });
    expect(await allRows(w.auth.storage)).toEqual({ users: [], identities: [], sessions: [] });
  });

  it("runs the sign-up rule before user.beforeCreate, so a closed sign-up fires no user hook", async () => {
    const r = recorded();
    const w = world(r.hooks, { signUp: false });
    expect(await magicLink(w.auth, "new@example.com")).toMatchObject({
      ok: false,
      code: "sign_up_closed",
    });
    expect(await emailCode(w.auth, "code@example.com")).toMatchObject({
      ok: false,
      code: "sign_up_closed",
    });
    expect(await social(w)).toMatchObject({ ok: false, code: "sign_up_closed" });
    expect(await resetLink(w.auth, "reset@example.com")).toMatchObject({
      ok: false,
      code: "sign_up_closed",
    });
    expect(r.events).toEqual([]);
  });

  it("fires no afterCreate when a retry after a unique-key race finds the winner's user", async () => {
    const r = recorded();
    const inner = createMemoryAdapter();
    // A parallel sign-in creates the same address first, through another connection.
    let armed = false;
    const wrap = (a: StorageAdapter): StorageAdapter => ({
      create: (m, d) => a.create(m, d),
      findOne: async (m, w) => {
        if (m === "user" && armed) {
          armed = false;
          const now = new Date();
          const winner = await inner.create("user", {
            id: newId(now),
            email: "new@example.com",
            emailVerified: true,
            name: null,
            image: null,
            createdAt: now,
            updatedAt: now,
          });
          await inner.create("identity", {
            id: newId(now),
            userId: winner.id,
            provider: "email",
            subject: winner.email,
            linkedAt: now,
            createdAt: now,
            updatedAt: now,
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
    const auth = makeAuth({ hooks: r.hooks, storage: wrap(inner) });
    await requestMagicLink(auth.config, { email: "new@example.com", ip: null });
    armed = true;
    const v = await verifyMagicLink(auth.config, {
      token: tokenFromMail(auth.mail.at(-1)?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    expect(v.ok).toBe(true);
    expect(armed).toBe(false);
    expect(r.events).toEqual([
      "user.beforeCreate:magic_link:new@example.com",
      "session.beforeCreate",
      "session.beforeCreate",
      "session.afterCreate",
    ]);
    expect(await inner.findMany("user", [])).toHaveLength(1);
  });

  it("logs a throw of user.afterCreate in one line, and the sign-in answers its success", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = makeAuth({
      hooks: {
        user: {
          afterCreate: () => {
            throw new TypeError("mirror down for new@example.com");
          },
        },
      },
    });
    expect((await magicLink(auth, "new@example.com")).ok).toBe(true);
    const row = await auth.storage.findOne("user", [
      { field: "email", op: "eq", value: "new@example.com" },
    ]);
    expect(log.mock.calls).toEqual([
      ["authtempo: after hook failed", "user.afterCreate", row?.id, "TypeError"],
    ]);
  });

  it("a patch with another field or a bad image answers hook_failed with one line", async () => {
    for (const patch of [{ email: "x@example.com" }, { image: "data:image/png;base64,AAAA" }]) {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const auth = makeAuth({ hooks: recorded(patch).hooks });
      expect(await magicLink(auth, "bad@example.com")).toMatchObject({
        ok: false,
        code: "hook_failed",
      });
      expect(log.mock.calls.filter((c) => c[0] === "authtempo: user patch refused")).toHaveLength(
        1,
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain("x@example.com");
      expect(JSON.stringify(log.mock.calls)).not.toContain("AAAA");
      expect(await allRows(auth.storage)).toEqual({ users: [], identities: [], sessions: [] });
      log.mockRestore();
    }
  });
});

describe("patchedNewUser (plan 12a)", () => {
  const minted: UserRow = {
    id: "01MINTED",
    email: "ada@example.com",
    emailVerified: true,
    name: "Old",
    image: "https://img.example.com/old.png",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it("keeps the row for no patch, and changes only name and image", () => {
    expect(patchedNewUser(minted, undefined)).toEqual(minted);
    expect(patchedNewUser(minted, null)).toEqual(minted);
    expect(patchedNewUser(minted, {})).toEqual(minted);
    expect(patchedNewUser(minted, { name: "Ada" })).toEqual({ ...minted, name: "Ada" });
    expect(patchedNewUser(minted, { name: null, image: null })).toEqual({
      ...minted,
      name: null,
      image: null,
    });
    expect(patchedNewUser(minted, { image: "https://img.example.com/a.png" })).toEqual({
      ...minted,
      image: "https://img.example.com/a.png",
    });
    expect(patchedNewUser(minted, { name: "x".repeat(200) }).name).toHaveLength(200);
  });

  it("stops with hook_failed and one line for a key outside UserCreatePatch or a bad value", () => {
    const refused: [unknown, string][] = [
      ["Ada", "a value that is not an object"],
      [5, "a value that is not an object"],
      [["Ada"], "a value that is not an object"],
      [{ email: "x@example.com" }, "a field other than name and image"],
      [{ emailVerified: false }, "a field other than name and image"],
      [{ id: "01OTHER" }, "a field other than name and image"],
      [{ name: "" }, "a name that breaks the name rule"],
      [{ name: "x".repeat(201) }, "a name that breaks the name rule"],
      [{ name: "a\u0000b" }, "a name that breaks the name rule"],
      [{ name: 5 }, "a name that breaks the name rule"],
      [{ image: "http://img.example.com/a.png" }, "an image that breaks the image rule"],
      [{ image: "https://u:p@img.example.com/a.png" }, "an image that breaks the image rule"],
      [{ image: 5 }, "an image that breaks the image rule"],
    ];
    for (const [patch, line] of refused) {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      let stop: unknown = null;
      try {
        patchedNewUser(minted, patch);
      } catch (e) {
        stop = e;
      }
      expect(stop).toBeInstanceOf(HookStop);
      expect((stop as HookStop).result).toEqual({ ok: false, code: "hook_failed", status: 500 });
      expect(log.mock.calls).toEqual([["authtempo: user patch refused", line]]);
      log.mockRestore();
    }
  });
});

describe("validImageUrl (plan 12a)", () => {
  const base = "https://img.example.com/";

  it("takes an https URL of at most 2048 characters", () => {
    expect(validImageUrl(`${base}a.png`)).toBe(true);
    expect(validImageUrl(base + "a".repeat(2048 - base.length))).toBe(true);
    // The scheme is case-insensitive; a port, a query, a fragment, and an escape are a URL's own parts.
    for (const value of [
      "HTTPS://img.example.com/a.png",
      "https://img.example.com:8443/a.png?s=96#x",
      "https://img.example.com/a%20b.png",
      "https://img.example.com",
      "https://192.0.2.1/a.png",
      "https://[2001:db8::1]/a.png",
      "https://bücher.example/a.png",
    ])
      expect(validImageUrl(value), value).toBe(true);
  });

  it("refuses a longer URL, another scheme, credentials, a control character, and no URL", () => {
    for (const value of [
      base + "a".repeat(2049 - base.length),
      "http://img.example.com/a.png",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "https://u:p@img.example.com/a.png",
      "https://u@img.example.com/a.png",
      "https://:p@img.example.com/a.png",
      "https://img.example.com/a\u0001.png",
      "/a.png",
      "not a url",
      "",
    ])
      expect(validImageUrl(value), value).toBe(false);
  });

  // Review L2 of Task 5: the URL parser drops or rewrites these, so the stored text would differ.
  it.each([
    ["a space", "https://img.example.com/a b.png"],
    ["a leading space", " https://img.example.com/a.png"],
    ["a trailing space", "https://img.example.com/a.png "],
    ["a tab", "https://img.example.com/a\t.png"],
    ["a line feed", "https://img.example.com/a\n.png"],
    ["a no-break space", "https://img.example.com/a\u00a0.png"],
    ["an ideographic space", "https://img.example.com/a\u3000.png"],
    ["a line separator", "https://img.example.com/a\u2028.png"],
    ["DEL", "https://img.example.com/a\u007f.png"],
    ["a C1 control (NEL)", "https://img.example.com/a\u0085.png"],
    ["a C1 control (CSI)", "https://img.example.com/a\u009b.png"],
    ["a right-to-left override", "https://img.example.com/\u202egnp.a"],
    ["a left-to-right mark", "https://img.example.com/a\u200e.png"],
    ["a right-to-left isolate", "https://img.example.com/a\u2067.png"],
    ["an Arabic letter mark", "https://img.example.com/a\u061c.png"],
    ["a zero-width space", "https://img.example.com/a\u200b.png"],
    ["a zero-width joiner", "https://img.example.com/a\u200d.png"],
    ["a byte order mark", "\ufeffhttps://img.example.com/a.png"],
    ["a soft hyphen", "https://img.\u00adexample.com/a.png"],
    ["a lone surrogate", "https://img.example.com/a\ud800.png"],
    ["a backslash in the path", "https://img.example.com\\a.png"],
    ["a backslash for the slashes", "https:\\\\img.example.com/a.png"],
    ["https: with one slash", "https:/img.example.com/a.png"],
    ["https: with no slash", "https:img.example.com/a.png"],
    ["https: with three slashes", "https:///img.example.com/a.png"],
    ["no host", "https://"],
    ["an empty host with a port", "https://:443/a.png"],
    ["an empty host with an at sign", "https://@/a.png"],
    ["a host that does not parse", "https://[2001:db8::1/a.png"],
    ["a scheme-relative URL", "//img.example.com/a.png"],
    ["the http scheme with slashes", "http://img.example.com/a.png"],
  ])("refuses %s", (_, value) => {
    expect(validImageUrl(value)).toBe(false);
  });

  it("is the rule of the social fill too: a picture with credentials fills no image", async () => {
    const w = world({});
    expect((await social(w, { picture: "https://u:p@p/a.png" })).ok).toBe(true);
    expect(await w.auth.storage.findMany("user", [])).toMatchObject([
      { email: "ada@example.com", name: "Ada", image: null },
    ]);
  });
});

describe("hooks.identity (plan 12a, spec 8.9)", () => {
  it("runs identity.beforeLink when a verified equal address links, and no user hook", async () => {
    const r = recorded();
    const w = world(r.hooks);
    expect((await magicLink(w.auth, "ada@example.com")).ok).toBe(true);
    r.events.length = 0;
    expect((await social(w)).ok).toBe(true);
    expect(r.events).toEqual([
      "identity.beforeLink:sign_in:google",
      "session.beforeCreate",
      "identity.afterLink:sign_in:google",
      "session.afterCreate",
    ]);
    // A sign-in through the linked identity links nothing.
    r.events.length = 0;
    expect((await social(w)).ok).toBe(true);
    expect(r.events).toEqual(["session.beforeCreate", "session.afterCreate"]);
  });

  it("a beforeLink refusal for a verified equal address leaves no identity and no session", async () => {
    const w = world({
      identity: {
        beforeLink: () => {
          throw hookRefusal("No links today.");
        },
      },
    });
    const made = await magicLink(w.auth, "ada@example.com");
    if (!made.ok) throw new Error("no user");
    const before = await allRows(w.auth.storage);
    expect(await social(w)).toMatchObject({
      ok: false,
      code: "hook_refused",
      message: "No links today.",
    });
    expect(await allRows(w.auth.storage)).toEqual(before);
    expect(before.identities.map((i) => i.provider)).toEqual(["email"]);
  });

  it("fires no afterLink when a retry after a unique-key race finds the winner's identity", async () => {
    const r = recorded();
    const inner = createMemoryAdapter();
    // A parallel sign-in of the same Google account links it first, through another connection.
    let armed = false;
    const wrap = (a: StorageAdapter): StorageAdapter => ({
      create: async (m, d) => {
        const row = d as unknown as IdentityRow;
        if (m === "identity" && armed && row.provider === "google") {
          armed = false;
          await inner.create("identity", { ...row, id: newId(new Date()) });
        }
        return a.create(m, d);
      },
      findOne: (m, w) => a.findOne(m, w),
      findMany: (m, w, o) => a.findMany(m, w, o),
      update: (m, w, d) => a.update(m, w, d),
      delete: (m, w) => a.delete(m, w),
      transaction: (fn) => a.transaction((tx) => fn(wrap(tx))),
    });
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({ hooks: r.hooks, storage: wrap(inner) }, fakeJwt(tokens));
    const w: World = { auth: { ...auth, storage: inner }, tokens };
    expect((await magicLink(w.auth, "ada@example.com")).ok).toBe(true);
    r.events.length = 0;
    armed = true;
    expect((await social(w)).ok).toBe(true);
    expect(armed).toBe(false);
    expect(r.events).toEqual([
      "identity.beforeLink:sign_in:google",
      "session.beforeCreate",
      "session.beforeCreate",
      "session.afterCreate",
    ]);
    expect((await inner.findMany("identity", [])).map((i) => i.provider).sort()).toEqual([
      "email",
      "google",
    ]);
  });
});

describe("the hook groups in the config (plan 12a)", () => {
  it("refuses an unknown group and an unknown point of user and identity", () => {
    expect(() => makeAuth({ hooks: { users: {} } as never })).toThrow(
      new ConfigError(
        "hooks.users is not a hook group; core has organization, session, user, and identity",
      ),
    );
    expect(() => makeAuth({ hooks: { user: { beforeSave: () => {} } as never } })).toThrow(
      new ConfigError("hooks.user.beforeSave is not a hook point"),
    );
    expect(() => makeAuth({ hooks: { identity: { afterCreate: () => {} } as never } })).toThrow(
      new ConfigError("hooks.identity.afterCreate is not a hook point"),
    );
    expect(() => makeAuth({ hooks: { user: { beforeCreate: "x" } as never } })).toThrow(
      new ConfigError("hooks.user.beforeCreate must be a function"),
    );
    expect(() => makeAuth({ hooks: { identity: { beforeLink: "x" } as never } })).toThrow(
      new ConfigError("hooks.identity.beforeLink must be a function"),
    );
    expect(() => makeAuth({ hooks: { user: [] as never } })).toThrow(
      new ConfigError("hooks.user must be a plain object"),
    );
    expect(() => makeAuth({ hooks: { identity: "x" as never } })).toThrow(
      new ConfigError("hooks.identity must be a plain object"),
    );
  });

  it("takes every user point and every identity point, each bound to its object", async () => {
    const fn = () => {};
    const user = {
      beforeCreate: fn,
      afterCreate: fn,
      beforeUpdate: fn,
      afterUpdate: fn,
      beforeDelete: fn,
      afterDelete: fn,
    };
    const identity = { beforeLink: fn, afterLink: fn, beforeUnlink: fn, afterUnlink: fn };
    const hooks = makeAuth({ hooks: { user, identity } }).config.hooks;
    expect(Object.keys(hooks.user)).toEqual([
      "beforeCreate",
      "afterCreate",
      "beforeUpdate",
      "afterUpdate",
      "beforeDelete",
      "afterDelete",
    ]);
    expect(Object.keys(hooks.identity)).toEqual([
      "beforeLink",
      "afterLink",
      "beforeUnlink",
      "afterUnlink",
    ]);
    const seen = Symbol("seen");
    const group = {
      [seen]: [] as string[],
      afterLink() {
        this[seen].push("called");
      },
    };
    await makeAuth({ hooks: { identity: group } }).config.hooks.identity.afterLink?.({} as never);
    expect(group[seen]).toEqual(["called"]);
  });
});

// Proposed by review-12a-task5 (M1, M2), copied from its proposed file.
describe("the create steps on every path (review-12a-task5)", () => {
  for (const path of PATHS) {
    it(`applies a user.beforeCreate patch on ${path.name}`, async () => {
      const r = recorded({ name: "Pat", image: "https://img.example.com/p.png" });
      const w = world(r.hooks, path.extra);
      expect((await path.run(w, "new@example.com")).ok).toBe(true);
      expect(await w.auth.storage.findMany("user", [])).toMatchObject([
        { email: "new@example.com", name: "Pat", image: "https://img.example.com/p.png" },
      ]);
      expect(r.events.filter((e) => e.startsWith("user.afterCreate:"))).toEqual([
        expect.stringMatching(/:Pat$/),
      ]);
    });
  }

  it("runs the sign-up rule before user.beforeCreate on both password sign-ups and the reset code", async () => {
    const r = recorded();
    // "invited" with no invitation: the rule runs inside the transaction. `false` refuses
    // the password sign-up before it, so it cannot show the order.
    const closed = { signUp: "invited" as const, organizations: {} };
    const uniform = world(r.hooks, closed);
    expect(await signUp(uniform.auth, "up@example.com")).toEqual({
      ok: true,
      value: { sent: true },
    });
    expect(await resetCode(uniform.auth, "code@example.com")).toMatchObject({
      ok: false,
      code: "sign_up_closed",
    });
    const off = world(r.hooks, { ...closed, password: { hash: FAST, uniformSignUp: false } });
    expect(await signUp(off.auth, "up@example.com")).toMatchObject({
      ok: false,
      code: "sign_up_closed",
    });
    expect(r.events).toEqual([]);
  });

  it("runs no user hook for a password sign-up of an address that has a user", async () => {
    for (const extra of [{}, { password: { hash: FAST, uniformSignUp: false } }]) {
      const r = recorded();
      const w = world(r.hooks, extra);
      expect((await magicLink(w.auth, "old@example.com")).ok).toBe(true);
      r.events.length = 0;
      await signUp(w.auth, "old@example.com");
      expect(r.events).toEqual([]);
    }
  });
});

describe("a patch that cannot be read (review L3 of plan 12a Task 5)", () => {
  /** An answer whose field getter throws, with an address in its message. */
  const unreadable = () => ({
    get name(): string {
      throw new TypeError("getter for new@example.com");
    },
  });

  it("answers hook_failed with one line for a user patch whose getter throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = makeAuth({ hooks: { user: { beforeCreate: () => unreadable() as never } } });
    expect(await magicLink(auth, "new@example.com")).toEqual({
      ok: false,
      code: "hook_failed",
      status: 500,
    });
    expect(log.mock.calls).toEqual([
      ["authtempo: user patch refused", "a value that cannot be read"],
    ]);
    expect(await allRows(auth.storage)).toEqual({ users: [], identities: [], sessions: [] });
  });

  it("answers hook_failed with one line for a session patch whose getter throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = makeAuth({
      hooks: { session: { beforeCreate: () => unreadable() as never } },
    });
    expect(await magicLink(auth, "new@example.com")).toEqual({
      ok: false,
      code: "hook_failed",
      status: 500,
    });
    expect(log.mock.calls).toEqual([
      ["authtempo: session patch refused", "a value that cannot be read"],
    ]);
    expect(await allRows(auth.storage)).toEqual({ users: [], identities: [], sessions: [] });
  });
});

describe("a patch that is not a plain object (review L7 of plan 12a Task 5)", () => {
  class Patch {
    get name(): string {
      return "Pat";
    }
  }

  async function answer(patch: unknown, session = false) {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const hooks: HooksConfig = session
      ? { session: { beforeCreate: () => patch as never } }
      : { user: { beforeCreate: () => patch as never } };
    const auth = makeAuth({ hooks });
    const r = await magicLink(auth, "new@example.com");
    const rows = await allRows(auth.storage);
    const lines = [...log.mock.calls];
    log.mockRestore();
    return { r, rows, lines };
  }

  it("refuses a class instance and an Object.create answer with one line", async () => {
    for (const patch of [new Patch(), Object.create({ name: "Pat" })]) {
      const a = await answer(patch);
      expect(a.r).toEqual({ ok: false, code: "hook_failed", status: 500 });
      expect(a.lines).toEqual([
        ["authtempo: user patch refused", "a value that is not a plain object"],
      ]);
      expect(a.rows).toEqual({ users: [], identities: [], sessions: [] });
    }
    const s = await answer(new Patch(), true);
    expect(s.r).toEqual({ ok: false, code: "hook_failed", status: 500 });
    expect(s.lines).toEqual([
      ["authtempo: session patch refused", "a value that is not a plain object"],
    ]);
  });

  it("applies an object with a null prototype", async () => {
    const a = await answer(Object.assign(Object.create(null), { name: "Pat" }));
    expect(a.r.ok).toBe(true);
    expect(a.rows.users).toMatchObject([{ email: "new@example.com", name: "Pat" }]);
    expect(a.lines).toEqual([]);
  });

  it("reads own enumerable fields only: a non-enumerable name is dropped", async () => {
    const a = await answer(Object.defineProperty({}, "name", { value: "Pat", enumerable: false }));
    expect(a.r.ok).toBe(true);
    expect(a.rows.users).toMatchObject([{ email: "new@example.com", name: null }]);
    expect(a.lines).toEqual([]);
  });
});

describe("the uniform sign-up hides a user.beforeCreate stop (plan 12a, lead ruling 2026-10-15)", () => {
  const PW = "correct horse battery";

  /** A sign-up auth whose user.beforeCreate stops for no@example.com only. */
  function stopping(stop: () => never) {
    // pwHandle turns the uniform sign-up off unless the test asks for it.
    return pwHandle(
      { hash: FAST, uniformSignUp: true },
      {
        hooks: {
          user: {
            beforeCreate: (e) => {
              if (e.user.email === "no@example.com") stop();
            },
          },
        },
      },
    );
  }

  async function answer(h: ReturnType<typeof pwHandle>, email: string) {
    const res = await h.auth.handle(post("/auth/password/sign-up", { email, password: PW }));
    return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie") };
  }

  async function check(h: ReturnType<typeof pwHandle>) {
    // A known address: the first sign-up makes the user, the second meets it.
    await answer(h, "old@example.com");
    const known = await answer(h, "old@example.com");
    const refused = await answer(h, "no@example.com");
    expect(refused).toEqual(known);
    expect(refused).toEqual({ status: 200, body: { sent: true }, cookie: null });
    const users = await h.storage.findMany("user", []);
    expect(users.map((u) => u.email)).toEqual(["old@example.com"]);
    expect(
      await h.storage.findMany("identity", [
        { field: "subject", op: "eq", value: "no@example.com" },
      ]),
    ).toEqual([]);
    expect(await h.storage.findMany("session", [])).toEqual([]);
    expect(h.mails.filter((m) => m.to === "no@example.com")).toEqual([]);
  }

  it("answers a refusal for an unknown address as for a known one, with no row and no mail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await check(
      stopping(() => {
        throw hookRefusal("Sign-ups from no@example.com are closed.");
      }),
    );
    // A refusal is the app's answer, not a fault: no line, and never the address.
    expect(log.mock.calls).toEqual([]);
  });

  it("answers a throw for an unknown address as for a known one, and logs the reason only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await check(
      stopping(() => {
        throw new TypeError("crm down for no@example.com");
      }),
    );
    expect(log.mock.calls).toEqual([
      ["authtempo: before hook failed", "user.beforeCreate", "TypeError"],
    ]);
  });
});
