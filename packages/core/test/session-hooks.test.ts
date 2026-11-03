import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { hookRefusal, type SessionHooks } from "../src/engine/hooks.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { addMember, createOrganization, removeMember } from "../src/engine/organizations.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import {
  changePassword,
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
  verifyPasswordEmail,
} from "../src/engine/password.js";
import { createSession, destroySession, resolveSession } from "../src/engine/sessions.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { CLAIM_RUNS } from "../src/engine/users.js";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { makeAuth, tokenFromMail } from "./helpers.js";
import { FAST, sessionOnly, signUpAndVerify, upSession } from "./password-helpers.js";
import { type FakeIdToken, fakeJwt, GOOGLE, tokenEndpoint } from "./social-helpers.js";

const PASSWORD = "correct horse battery";

/**
 * The two node:fs calls the machine check uses. Core's typecheck has no Node
 * types, because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck.
 */
interface SourceFs {
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every session hook point records its name and its event. `over` replaces some points. */
function recorded(over: SessionHooks = {}, extra: Partial<AuthConfig> = {}) {
  const calls: [string, unknown][] = [];
  const point = (name: string) => (e: unknown) => {
    calls.push([name, e]);
  };
  const auth = makeAuth({
    organizations: {},
    // The detailed answer of plan 8 (a session and the user at sign-up), which
    // these tests read. The uniform answer has its own tests (plan 12b).
    password: { hash: FAST, uniformSignUp: false },
    ...extra,
    hooks: {
      session: {
        beforeCreate: point("beforeCreate"),
        afterCreate: point("afterCreate"),
        afterEnd: point("afterEnd"),
        ...over,
      },
    },
  });
  return { auth, calls, names: () => calls.map(([name]) => name) };
}

async function magicSignIn(auth: ReturnType<typeof makeAuth>, email: string) {
  const ip = "198.51.100.7";
  const sent = await requestMagicLink(auth.config, { email, ip });
  if (!sent.ok) throw new Error(sent.code);
  const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
  return verifyMagicLink(auth.config, { token, ip, userAgent: "Agent/1" });
}

const signIn = (auth: ReturnType<typeof makeAuth>) =>
  sessionOnly(
    passwordSignIn(auth.config, {
      email: "ada@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    }),
  );

/**
 * Records each write of the next transaction as `op:model`, in order, as
 * `recordNextTransaction` in password.test.ts does.
 */
function recordNextTransaction(storage: StorageAdapter): string[] {
  const writes: string[] = [];
  const original = storage.transaction.bind(storage);
  let armed = true;
  storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
    if (!armed) return original(fn);
    armed = false;
    return original((tx) =>
      fn({
        ...tx,
        create: (m, d) => {
          writes.push(`create:${m}`);
          return tx.create(m, d);
        },
        update: (m, w, d) => {
          writes.push(`update:${m}`);
          return tx.update(m, w, d);
        },
        delete: (m, w) => {
          writes.push(`delete:${m}`);
          return tx.delete(m, w);
        },
      }),
    );
  };
  return writes;
}

const signUp = (auth: ReturnType<typeof makeAuth>, email: string) =>
  passwordSignUp(auth.config, { email, password: PASSWORD, ip: null, userAgent: null });

async function reset(auth: ReturnType<typeof makeAuth>, email = "ada@example.com") {
  const asked = await requestPasswordReset(auth.config, { email, ip: null });
  if (!asked.ok) throw new Error(asked.code);
  const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
  return resetPassword(auth.config, {
    token,
    password: "another long password",
    ip: null,
    userAgent: null,
  });
}

/** The config of a Google sign-in through the fake token endpoint: set it at `makeAuth`. */
function googleConfig(): { jwtTokens: Record<string, FakeIdToken>; extra: Partial<AuthConfig> } {
  const jwtTokens: Record<string, FakeIdToken> = {};
  const { fetchFn } = tokenEndpoint("idtok-default");
  return {
    jwtTokens,
    extra: { social: { google: GOOGLE, fetch: fetchFn }, jwt: fakeJwt(jwtTokens) },
  };
}

/** A Google sign-in whose ID token proves `email`. */
async function googleSignIn(
  auth: ReturnType<typeof makeAuth>,
  jwtTokens: Record<string, FakeIdToken>,
  email: string,
) {
  const started = await startSocial(auth.config, { provider: "google", next: "/", ip: null });
  if (!started.ok) throw new Error(started.code);
  const url = new URL(started.value.location);
  jwtTokens["idtok-default"] = {
    audience: GOOGLE.clientId,
    issuer: "https://accounts.google.com",
    claims: {
      sub: "g-1",
      email,
      email_verified: true,
      name: "Ada",
      picture: "https://p/a.png",
      nonce: url.searchParams.get("nonce") ?? "",
    },
  };
  return completeSocial(auth.config, {
    provider: "google",
    state: url.searchParams.get("state") ?? "",
    code: "code-1",
    error: null,
    bindToken: started.value.bindToken,
    ip: null,
    userAgent: null,
  });
}

describe("session create hooks (plan 9d)", () => {
  it("fires beforeCreate with the draft and afterCreate with the stored row, once each, on a magic link sign-in", async () => {
    const { auth, calls, names } = recorded();
    const r = await magicSignIn(auth, "ada@example.com");
    if (!r.ok) throw new Error(r.code);
    const rows = await auth.storage.findMany("session", []);
    expect(rows).toHaveLength(1);
    expect(names()).toEqual(["beforeCreate", "afterCreate"]);
    expect(calls[0]?.[1]).toEqual({
      session: {
        userId: r.value.user.id,
        ip: "198.51.100.7",
        userAgent: "Agent/1",
        activeOrganizationId: null,
      },
      user: r.value.user,
      via: "magic_link",
    });
    expect(calls[1]?.[1]).toEqual({ session: rows[0], user: r.value.user, via: "magic_link" });
  });

  it("stores the patch: a null ip and userAgent, and an organization the user is a member of", async () => {
    let organizationId: string | null = null;
    const { auth } = recorded({
      beforeCreate: () => ({ ip: null, userAgent: null, activeOrganizationId: organizationId }),
    });
    const ada = await auth.seedUser("ada@example.com");
    const org = await createOrganization(auth.config, { user: ada, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    organizationId = org.value.organization.id;
    expect((await magicSignIn(auth, "ada@example.com")).ok).toBe(true);
    expect(await auth.storage.findMany("session", [])).toEqual([
      expect.objectContaining({ ip: null, userAgent: null, activeOrganizationId: organizationId }),
    ]);
  });

  it("answers not_found and writes no session when the patch names an organization the user left, or one the user never joined (Review Focus 3)", async () => {
    let organizationId = "";
    const { auth } = recorded({ beforeCreate: () => ({ activeOrganizationId: organizationId }) });
    const owner = await auth.seedUser("owner@example.com");
    const ada = await auth.seedUser("ada@example.com");
    const org = await createOrganization(auth.config, { user: owner, slug: "acme", name: "Acme" });
    if (!org.ok) throw new Error(org.code);
    organizationId = org.value.organization.id;
    const joined = await addMember(auth.config, {
      user: owner,
      organizationId,
      userId: ada.id,
      role: "member",
    });
    expect(joined.ok).toBe(true);
    const left = await removeMember(auth.config, { user: ada, organizationId, userId: ada.id });
    expect(left.ok).toBe(true);
    expect(await magicSignIn(auth, "ada@example.com")).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    organizationId = "01JNOSUCHORGANIZATION000";
    expect(await magicSignIn(auth, "ada@example.com")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(
      await auth.storage.findMany("session", [{ field: "userId", op: "eq", value: ada.id }]),
    ).toEqual([]);
  });

  it("answers hook_failed for a patch with another field, and a refused password sign-up leaves no user, no password row, and no mail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = recorded({ beforeCreate: () => ({ userId: "someone-else" }) as never });
    expect(await magicSignIn(bad.auth, "ada@example.com")).toEqual({
      ok: false,
      code: "hook_failed",
      status: 500,
    });
    expect(log.mock.calls).toEqual([["authtempo: session patch refused", "the field userId"]]);
    expect(await bad.auth.storage.findMany("session", [])).toEqual([]);

    const refusing = recorded({
      beforeCreate() {
        throw hookRefusal("Sign-ups are closed.");
      },
    });
    const mails = refusing.auth.mail.length;
    expect(
      await passwordSignUp(refusing.auth.config, {
        email: "new@example.com",
        password: PASSWORD,
        ip: null,
        userAgent: null,
      }),
    ).toEqual({ ok: false, code: "hook_refused", status: 403, message: "Sign-ups are closed." });
    // The hook runs before the sign-up's first write, so no row was written.
    expect(await refusing.auth.storage.findMany("user", [])).toEqual([]);
    expect(await refusing.auth.storage.findMany("password", [])).toEqual([]);
    expect(refusing.auth.mail).toHaveLength(mails);
  });

  it("runs the sign-up's session hook before its first write: a refusal makes no create (fix round 1)", async () => {
    let writesAtHook: string[] | null = null;
    const refusing = recorded({
      beforeCreate() {
        writesAtHook = [...writes];
        throw hookRefusal("Sign-ups are closed.");
      },
    });
    const writes = recordNextTransaction(refusing.auth.storage);
    expect((await signUp(refusing.auth, "new@example.com")).ok).toBe(false);
    // No user create and no pending password create ran, so on D1 no undo can
    // delete a row by id: the hook ran first.
    expect(writesAtHook).toEqual([]);
    expect(writes).toEqual([]);
    expect(await refusing.auth.storage.findMany("session", [])).toEqual([]);

    // Without a refusal the order is the hook, then the user, password, and session creates.
    const { auth } = recorded();
    const ok = recordNextTransaction(auth.storage);
    expect((await signUp(auth, "ada@example.com")).ok).toBe(true);
    expect(ok.slice(0, 3)).toEqual(["create:user", "create:password", "create:session"]);
  });

  it("names the flow in via: password on the sign-up, the verify link, the sign-in, and the reset", async () => {
    const { auth, calls } = recorded();
    await signUpAndVerify(auth, "ada@example.com", PASSWORD);
    expect((await signIn(auth)).ok).toBe(true);
    expect((await reset(auth)).ok).toBe(true);
    const vias = calls
      .filter(([name]) => name === "afterCreate")
      .map(([, e]) => (e as { via: string }).via);
    expect(vias).toEqual(["password", "password", "password", "password"]);
  });

  it("fires beforeCreate and afterCreate once each, with the stored row, on a social, a passkey, and a handoff sign-in (parked Minor 12)", async () => {
    /** The after hook's events, checked against the stored session row. */
    const check = async (
      r: { calls: [string, unknown][]; auth: ReturnType<typeof makeAuth> },
      via: string,
      token: string,
    ) => {
      const created = r.calls.filter(([name]) => name === "afterCreate").map(([, e]) => e);
      expect(r.calls.filter(([name]) => name === "beforeCreate")).toHaveLength(1);
      expect(created).toHaveLength(1);
      const stored = await resolveSession(r.auth.config, token);
      expect(created[0]).toEqual({ session: stored?.session, user: stored?.user, via });
    };

    // Social.
    const jwtTokens: Record<string, FakeIdToken> = {};
    const { fetchFn } = tokenEndpoint("idtok-default");
    const social = recorded(
      {},
      { social: { google: GOOGLE, fetch: fetchFn }, jwt: fakeJwt(jwtTokens) },
    );
    const started = await startSocial(social.auth.config, {
      provider: "google",
      next: "/",
      ip: null,
    });
    if (!started.ok) throw new Error(started.code);
    const url = new URL(started.value.location);
    jwtTokens["idtok-default"] = {
      audience: GOOGLE.clientId,
      issuer: "https://accounts.google.com",
      claims: {
        sub: "g-1",
        email: "ada@example.com",
        email_verified: true,
        name: "Ada",
        picture: "https://p/a.png",
        nonce: url.searchParams.get("nonce") ?? "",
      },
    };
    const s = await completeSocial(social.auth.config, {
      provider: "google",
      state: url.searchParams.get("state") ?? "",
      code: "code-1",
      error: null,
      bindToken: started.value.bindToken,
      ip: null,
      userAgent: null,
    });
    if (!s.ok) throw new Error(s.code);
    if (!("token" in s.value)) throw new Error("the sign-in answered a challenge");
    await check(social, "social", s.value.token);

    // Passkey.
    const RP = { rpID: "example.com", rpName: "Example", origins: ["https://app.example.com"] };
    const passkey = recorded({}, { passkey: RP });
    const ada = await passkey.auth.seedUser("ada@example.com");
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
    const reg = await passkeyRegistrationOptions(passkey.auth.config, { user: ada });
    if (!reg.ok) throw new Error(reg.code);
    const stored = await verifyPasskeyRegistration(passkey.auth.config, {
      user: ada,
      response: await soft.register(reg.value.challenge, new TextEncoder().encode(ada.id)),
    });
    if (!stored.ok) throw new Error(stored.code);
    const options = await passkeyAuthenticationOptions(passkey.auth.config, { ip: null });
    if (!options.ok) throw new Error(options.code);
    passkey.calls.length = 0;
    const p = await verifyPasskeyAuthentication(passkey.auth.config, {
      response: await soft.authenticate(options.value.challenge),
      ip: null,
      userAgent: null,
    });
    if (!p.ok) throw new Error(p.code);
    await check(passkey, "passkey", p.value.token);

    // Handoff.
    const handoff = recorded({}, { handoff: { schemes: ["consumera://"] } });
    const grace = await handoff.auth.seedUser("grace@example.com");
    const verifier = randomBase64Url(32);
    const h = await startHandoff(handoff.auth.config, {
      challenge: await sha256Base64Url(verifier),
      redirect: "consumera://auth",
      ip: null,
    });
    if (!h.ok) throw new Error(h.code);
    const browser = await createSession(handoff.auth.config, {
      userId: grace.id,
      ip: null,
      userAgent: null,
    });
    const c = await continueHandoff(handoff.auth.config, {
      handoffId: h.value.handoffId,
      userId: grace.id,
      sessionId: browser.session.id,
    });
    if (!c.ok) throw new Error(c.code);
    handoff.calls.length = 0;
    const redeemed = await redeemHandoff(handoff.auth.config, {
      code: new URL(c.value.location).searchParams.get("code") ?? "",
      verifier,
      ip: null,
      userAgent: null,
    });
    if (!redeemed.ok) throw new Error(redeemed.code);
    await check(handoff, "handoff", redeemed.value.token);
  });

  it("keeps the session and answers the sign-in when afterCreate throws, with one log line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { auth } = recorded({
      afterCreate() {
        throw new Error("audit store down");
      },
    });
    expect((await magicSignIn(auth, "ada@example.com")).ok).toBe(true);
    const rows = await auth.storage.findMany("session", []);
    expect(rows).toHaveLength(1);
    expect(log.mock.calls).toEqual([
      ["authtempo: after hook failed", "session.afterCreate", rows[0]?.id, "Error"],
    ]);
  });

  it("opens every engine session through openSession, with the flow's via", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const dir = new URL("../src/engine/", import.meta.url);
    const read = (file: string) => readFileSync(new URL(file, dir), "utf8");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "sessions.ts"))
      expect({ file, callsCreateSession: read(file).includes("createSession(") }).toEqual({
        file,
        callsCreateSession: false,
      });
    expect(read("magic-link.ts")).toContain('via: "magic_link"');
    expect(read("social.ts")).toContain('via: "social"');
    expect(read("passkeys.ts")).toContain('via: "passkey"');
    expect(read("handoff.ts")).toContain('via: "handoff"');
    expect(read("email-otp.ts")).toContain('via: "email_otp"');
    // Four session inputs and the reset's challenge input (plan 12c).
    expect(read("password.ts").split('via: "password"')).toHaveLength(6);
    // The password gate's challenge input (plan 9f). The verify opens the
    // session with the challenge's via, not a fixed one (plan 12c).
    expect(read("totp.ts").split('via: "password"')).toHaveLength(2);
    // The verify keeps the IdP's cap of an SSO sign-in through the challenge (plan 12d).
    expect(read("totp.ts")).toContain(
      "{ user, ip, userAgent, via, ...(notAfter ? { notAfter } : {}) }",
    );
    // The SSO resolution (plan 12d Task 5).
    expect(read("sso/resolve.ts")).toContain('via: "sso"');
    // The verify also passes the state payload of a social sign-in (plan 12i Task 19).
    expect(
      read("totp.ts").match(
        /sessionOpened\([^;]*?\bvia,?(?:\s*undefined,\s*stateData\.value\?\.value \?\? null,?)?\s*\)/g,
      ),
    ).toHaveLength(1);
    // The after hook too: each flow passes its via to sessionOpened after its commit.
    // A social sign-in also passes its provider (plan 12h Task 5) and its
    // state payload (plan 12i Task 19). The callback and the ID-token route
    // share one sign-in, which names the provider of its input (plan 12i Task 10).
    const opened = (file: string, via: string) =>
      read(file).match(
        new RegExp(
          `sessionOpened\\([^;]*?"${via}"(?:, (?:provider\\.name|input\\.provider)(?:, stateData)?)?,?\\s*\\)`,
          "g",
        ),
      )?.length ?? 0;
    expect({
      magicLink: opened("magic-link.ts", "magic_link"),
      social: opened("social.ts", "social"),
      passkey: opened("passkeys.ts", "passkey"),
      handoff: opened("handoff.ts", "handoff"),
      password: opened("password.ts", "password"),
      emailOtp: opened("email-otp.ts", "email_otp"),
      totp: opened("totp.ts", "password"),
      sso: opened("sso/resolve.ts", "sso"),
    }).toEqual({
      magicLink: 1,
      social: 1,
      // The sign-in and the passkey-first sign-up (plan 12i Task 8).
      passkey: 2,
      handoff: 1,
      password: 4,
      emailOtp: 1,
      totp: 0,
      sso: 1,
    });
  });
});

/**
 * A claimant: ada signed up with a password and never proved the address,
 * so the user is unverified and holds a password row and a session. A later
 * proof of the address claims it. `refuse` turns the refusal on.
 */
async function claimantSetup(extra: Partial<AuthConfig> = {}) {
  const flag = { refuse: false, writesAtHook: null as string[] | null };
  let writes: string[] = [];
  const made = recorded(
    {
      beforeCreate() {
        if (!flag.refuse) return;
        flag.writesAtHook = [...writes];
        throw hookRefusal("Not now.");
      },
    },
    extra,
  );
  const up = await signUp(made.auth, "ada@example.com");
  if (!up.ok) throw new Error(up.code);
  const snapshot = async () => ({
    users: await made.auth.storage.findMany("user", []),
    passwords: await made.auth.storage.findMany("password", []),
    sessions: await made.auth.storage.findMany("session", []),
    identities: await made.auth.storage.findMany("identity", []),
  });
  const before = await snapshot();
  expect(before.users).toEqual([expect.objectContaining({ emailVerified: false })]);
  expect(before.sessions).toHaveLength(1);
  /** Arms the refusal and the write recorder for the next transaction. */
  const arm = () => {
    flag.refuse = true;
    writes = recordNextTransaction(made.auth.storage);
  };
  return { ...made, flag, arm, before, snapshot };
}

describe("the session hook runs before the first write of every claim flow (fix round 2)", () => {
  // On D1 a refusal after a write runs an undo that is not exact: it can
  // restore the claimant's rows or flip the verified flag back. So each flow
  // runs the hook before its first write: a refusal writes nothing.
  it("the magic link: a refusal writes nothing and leaves the claimant's rows", async () => {
    const c = await claimantSetup();
    const sent = await requestMagicLink(c.auth.config, { email: "ada@example.com", ip: null });
    if (!sent.ok) throw new Error(sent.code);
    const token = tokenFromMail(c.auth.mail.at(-1)?.text ?? "");
    c.arm();
    expect(
      await verifyMagicLink(c.auth.config, { token, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "hook_refused" });
    expect(c.flag.writesAtHook).toEqual([]);
    expect(await c.snapshot()).toEqual(c.before);
  });

  it("the verify link: a refusal writes nothing and leaves the claimant's rows", async () => {
    const c = await claimantSetup();
    const mail = c.auth.mail.findLast((m) => m.subject.startsWith("Confirm"));
    c.arm();
    expect(
      await verifyPasswordEmail(c.auth.config, {
        token: tokenFromMail(mail?.text ?? ""),
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "hook_refused" });
    expect(c.flag.writesAtHook).toEqual([]);
    expect(await c.snapshot()).toEqual(c.before);
  });

  it("the reset: the consume of its link is the one write before the hook, and a refusal leaves the claimant's rows", async () => {
    const c = await claimantSetup();
    const asked = await requestPasswordReset(c.auth.config, { email: "ada@example.com", ip: null });
    if (!asked.ok) throw new Error(asked.code);
    const token = tokenFromMail(c.auth.mail.at(-1)?.text ?? "");
    const link = async () =>
      (await c.auth.storage.findMany("verification", [])).find(
        (v) => v.purpose === "password-reset",
      );
    c.arm();
    const input = { token, password: "another long password", ip: null, userAgent: null };
    expect(await resetPassword(c.auth.config, input)).toMatchObject({
      ok: false,
      code: "hook_refused",
    });
    // The ruling of fix round 2: the reset consumes its link first, and the
    // hook runs before every other write.
    expect(c.flag.writesAtHook).toEqual(["update:verification"]);
    expect(await c.snapshot()).toEqual(c.before);
    // The consume is in the transaction, so the refusal undid it with the
    // transaction: the link is not spent, and it works once the app allows it.
    expect((await link())?.consumedAt).toBeNull();
    c.flag.refuse = false;
    expect((await resetPassword(c.auth.config, input)).ok).toBe(true);
  });

  it("the social sign-in: a refusal writes nothing and leaves the claimant's rows", async () => {
    const jwtTokens: Record<string, FakeIdToken> = {};
    const { fetchFn } = tokenEndpoint("idtok-default");
    const c = await claimantSetup({
      social: { google: GOOGLE, fetch: fetchFn },
      jwt: fakeJwt(jwtTokens),
    });
    const r = await startSocial(c.auth.config, { provider: "google", next: "/", ip: null });
    if (!r.ok) throw new Error(r.code);
    const url = new URL(r.value.location);
    jwtTokens["idtok-default"] = {
      audience: GOOGLE.clientId,
      issuer: "https://accounts.google.com",
      claims: {
        sub: "g-1",
        email: "ada@example.com",
        email_verified: true,
        name: "Ada",
        picture: "https://p/a.png",
        nonce: url.searchParams.get("nonce") ?? "",
      },
    };
    c.arm();
    expect(
      await completeSocial(c.auth.config, {
        provider: "google",
        state: url.searchParams.get("state") ?? "",
        code: "code-1",
        error: null,
        bindToken: r.value.bindToken,
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "hook_refused" });
    expect(c.flag.writesAtHook).toEqual([]);
    expect(await c.snapshot()).toEqual(c.before);
  });
});

describe("session end hooks (plan 9d)", () => {
  it("fires afterEnd with claim once per claimant session when a magic link proves the address", async () => {
    const { auth, calls } = recorded();
    const up = await passwordSignUp(auth.config, {
      email: "ada@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    calls.length = 0;
    expect((await magicSignIn(auth, "ada@example.com")).ok).toBe(true);
    expect(calls.filter(([name]) => name === "afterEnd")).toEqual([
      ["afterEnd", { session: upSession(up.value).session, reason: "claim" }],
    ]);
  });

  it("ends the claimant's sessions in one delete and fires afterEnd once for each, and never twice in a race (final review B M of plan 12i)", async () => {
    const { auth, calls } = recorded();
    /** The claimant's sessions: the sign-up's, then two password sign-ins. */
    const claimant = async (email: string) => {
      const up = await passwordSignUp(auth.config, {
        email,
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });
      if (!up.ok) throw new Error(up.code);
      const tokens = [upSession(up.value).token];
      for (let i = 0; i < 2; i++) {
        const s = await sessionOnly(
          passwordSignIn(auth.config, { email, password: PASSWORD, ip: null, userAgent: null }),
        );
        if (!s.ok) throw new Error(s.code);
        tokens.push(s.value.token);
      }
      return tokens;
    };
    const ended = () =>
      calls
        .filter(([name]) => name === "afterEnd")
        .map(([, e]) => e as { session: { id: string }; reason: string });
    const deletes: string[] = [];
    const original = auth.storage.transaction.bind(auth.storage);
    auth.storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      original((tx) =>
        fn({
          ...tx,
          delete: async (m, w) => {
            if (m === "session") deletes.push(w.map((x) => `${x.field} ${x.op}`).join(", "));
            return tx.delete(m, w);
          },
        }),
      );

    await claimant("ada@example.com");
    const ada = await auth.storage.findMany("session", []);
    calls.length = 0;
    expect((await magicSignIn(auth, "ada@example.com")).ok).toBe(true);
    // One delete of the read ids, and the last one by user id: none per row.
    expect(deletes).toEqual(["userId eq, id in", "userId eq"]);
    expect(
      ended()
        .map((e) => [e.session.id, e.reason])
        .sort(),
    ).toEqual(ada.map((r) => [r.id, "claim"]).sort());

    // A sign-out of one claimant session between the claim's read and its delete.
    const tokens = await claimant("bea@example.com");
    const beaUser = await auth.storage.findOne("user", [
      { field: "email", op: "eq", value: "bea@example.com" },
    ]);
    const bea = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: beaUser?.id },
    ]);
    expect(bea).toHaveLength(3);
    const tokenHashes = await Promise.all(tokens.map((t) => sha256Hex(t)));
    let armed = true;
    const inner = auth.storage.transaction;
    auth.storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      inner((tx) =>
        fn({
          ...tx,
          findMany: async (m, w, o) => {
            const rows = await tx.findMany(m, w, o);
            if (armed && m === "session") {
              armed = false;
              await destroySession(auth.config, tokens[0] ?? "");
            }
            return rows;
          },
        }),
      );
    calls.length = 0;
    expect((await magicSignIn(auth, "bea@example.com")).ok).toBe(true);
    // The claim ran once more after the race: each row fires exactly once,
    // the signed-out row with sign_out and the other two with claim.
    const out = bea.find((r) => r.tokenHash === tokenHashes[0]);
    expect(
      ended()
        .map((e) => [e.session.id, e.reason])
        .sort(),
    ).toEqual(bea.map((r) => [r.id, r.id === out?.id ? "sign_out" : "claim"]).sort());
    // The claim ended the claimant's sessions; the magic link made one.
    const left = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: beaUser?.id },
    ]);
    expect(left.filter((r) => bea.some((b) => b.id === r.id))).toEqual([]);
    expect(left).toHaveLength(1);
    expect(armed).toBe(false);
  });

  it.each(["magic link", "verify link", "social", "reset"] as const)(
    "keeps the owner's claim when a session race undoes each run, and fires afterEnd once for each row (ruling 46 of plan 12i, %s)",
    async (proof) => {
      const google = googleConfig();
      const { auth, calls } = recorded({}, google.extra);
      const email = "cy@example.com";
      const up = await passwordSignUp(auth.config, {
        email,
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });
      if (!up.ok) throw new Error(up.code);
      const tokens = [upSession(up.value).token];
      for (let i = 0; i < 4; i++) {
        const s = await sessionOnly(
          passwordSignIn(auth.config, { email, password: PASSWORD, ip: null, userAgent: null }),
        );
        if (!s.ok) throw new Error(s.code);
        tokens.push(s.value.token);
      }
      const user = await auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
      const byUser = [{ field: "userId", op: "eq", value: user?.id }] as const;
      const rows = await auth.storage.findMany("session", [...byUser]);
      expect(rows).toHaveLength(5);
      // A sign-out of the next claimant session between each read of the
      // claim and its delete: every run of the claim meets a race.
      const outs: string[] = [];
      let busy = false;
      const original = auth.storage.transaction.bind(auth.storage);
      auth.storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
        original((tx) =>
          fn({
            ...tx,
            findMany: async (m, w, o) => {
              const found = await tx.findMany(m, w, o);
              const next = tokens[outs.length];
              if (!busy && m === "session" && next !== undefined && outs.length < 4) {
                busy = true;
                outs.push(await sha256Hex(next));
                await destroySession(auth.config, next);
                busy = false;
              }
              return found;
            },
          }),
        );
      calls.length = 0;
      const confirm = auth.mail.findLast((m) => m.subject.startsWith("Confirm"));
      const signedIn =
        proof === "magic link"
          ? await magicSignIn(auth, email)
          : proof === "social"
            ? await googleSignIn(auth, google.jwtTokens, email)
            : proof === "reset"
              ? await reset(auth, email)
              : await verifyPasswordEmail(auth.config, {
                  token: tokenFromMail(confirm?.text ?? ""),
                  ip: null,
                  userAgent: null,
                });
      expect(signedIn.ok).toBe(true);
      // Two races undo a run each. The third run deletes each row by its id,
      // so its race ends one row and keeps the claim.
      expect(outs).toHaveLength(CLAIM_RUNS);
      expect(
        calls
          .filter(([name]) => name === "afterEnd")
          .map(([, e]) => e as { session: { id: string }; reason: string })
          .map((e) => [e.session.id, e.reason])
          .sort(),
      ).toEqual(rows.map((r) => [r.id, outs.includes(r.tokenHash) ? "sign_out" : "claim"]).sort());
      const left = await auth.storage.findMany("session", [...byUser]);
      expect(left.filter((r) => rows.some((b) => b.id === r.id))).toEqual([]);
      expect(left).toHaveLength(1);
      const owner = await auth.storage.findOne("user", [
        { field: "id", op: "eq", value: user?.id },
      ]);
      expect(owner?.emailVerified).toBe(true);
    },
  );

  // The invitation confirm has the counter too, but no real flow reaches it
  // there. Its unique-key retry is on the `email` identity. Only a proof of
  // the address writes that row, so the retry finds a verified user.
  it.each(["magic link", "social", "reset"] as const)(
    "signs in after a unique-key retry, two session races, and a lost flip (decision 13 of plan 12n, %s)",
    async (proof) => {
      const google = googleConfig();
      const { auth, calls } = recorded({}, google.extra);
      const email = "dee@example.com";
      // Memory runs one transaction at a time. So each parallel flow runs
      // its transaction on the store at once, as a commit of another request does.
      const free: StorageAdapter = { ...auth.storage, transaction: (fn) => fn(free) };
      const side = { ...auth.config, storage: free };
      const tokens: string[] = [];
      const outs: string[] = [];
      let stage: "create" | "race" | "flip" | "done" = "create";
      let runs = 0;
      const original = auth.storage.transaction.bind(auth.storage);
      auth.storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
        original((tx) => {
          runs++;
          return fn({
            ...tx,
            create: async (m, d) => {
              if (stage === "create" && m === "user") {
                stage = "race";
                // 1. A sign-up of the address commits first: this create meets its unique key.
                const up = await passwordSignUp(side, {
                  email,
                  password: PASSWORD,
                  ip: null,
                  userAgent: null,
                });
                if (!up.ok) throw new Error(up.code);
                tokens.push(upSession(up.value).token);
                const s = await sessionOnly(
                  passwordSignIn(side, { email, password: PASSWORD, ip: null, userAgent: null }),
                );
                if (!s.ok) throw new Error(s.code);
                tokens.push(s.value.token);
              }
              return tx.create(m, d);
            },
            findMany: async (m, w, o) => {
              const found = await tx.findMany(m, w, o);
              const next = tokens[outs.length];
              if (stage === "race" && m === "session" && next !== undefined) {
                // 2 and 3. A sign-out of a claimant session between the read and the delete of the claim.
                outs.push(await sha256Hex(next));
                if (outs.length === 2) stage = "flip";
                await destroySession(side, next);
              }
              return found;
            },
            update: async (m, w, d) => {
              if (stage === "flip" && m === "user" && w.some((x) => x.field === "emailVerified")) {
                stage = "done";
                // 4. The verify link of the sign-up commits first: the flip of this claim matches no row.
                const confirm = auth.mail.findLast((x) => x.subject.startsWith("Confirm"));
                const v = await verifyPasswordEmail(side, {
                  token: tokenFromMail(confirm?.text ?? ""),
                  ip: null,
                  userAgent: null,
                });
                if (!v.ok) throw new Error(v.code);
              }
              return tx.update(m, w, d);
            },
          });
        });
      calls.length = 0;
      const signedIn =
        proof === "magic link"
          ? await magicSignIn(auth, email)
          : proof === "social"
            ? await googleSignIn(auth, google.jwtTokens, email)
            : await reset(auth, email);
      expect(signedIn.ok).toBe(true);
      expect(stage).toBe("done");
      expect(outs).toHaveLength(2);
      const user = await auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
      expect(user?.emailVerified).toBe(true);
      // Each signed-out row ends once, with sign_out: the undone runs ended nothing.
      expect(
        calls
          .filter(([name]) => name === "afterEnd")
          .map(([, e]) => (e as { reason: string }).reason)
          .filter((r) => r === "sign_out"),
      ).toHaveLength(2);
      // The unique-key retry, three claim retries, and the run that signs in.
      expect(runs).toBeGreaterThanOrEqual(5);
    },
  );

  it("fires afterEnd with claim for the claimant's session when the verify link proves the address", async () => {
    const { auth, calls } = recorded();
    const up = await signUp(auth, "ada@example.com");
    if (!up.ok) throw new Error(up.code);
    calls.length = 0;
    const mail = auth.mail.findLast((m) => m.subject.startsWith("Confirm"));
    const verified = await verifyPasswordEmail(auth.config, {
      token: tokenFromMail(mail?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    expect(verified.ok && verified.value.signedIn !== null).toBe(true);
    expect(calls.filter(([name]) => name === "afterEnd")).toEqual([
      ["afterEnd", { session: upSession(up.value).session, reason: "claim" }],
    ]);
  });

  it("fires afterEnd once per session, with password_reset, on a reset that ends three sessions, and with claim on the reset of an unverified user", async () => {
    const { auth, calls } = recorded();
    await signUpAndVerify(auth, "ada@example.com", PASSWORD);
    expect((await signIn(auth)).ok).toBe(true);
    expect((await signIn(auth)).ok).toBe(true);
    const before = await auth.storage.findMany("session", []);
    expect(before).toHaveLength(3);
    calls.length = 0;
    expect((await reset(auth)).ok).toBe(true);
    const ended = calls.filter(([name]) => name === "afterEnd").map(([, e]) => e);
    expect(ended.map((e) => (e as { reason: string }).reason)).toEqual([
      "password_reset",
      "password_reset",
      "password_reset",
    ]);
    expect(ended.map((e) => (e as { session: { id: string } }).session.id).sort()).toEqual(
      before.map((s) => s.id).sort(),
    );

    // An unverified user's sessions are a claimant's: the reset claims the
    // address, and the reason is the claim's (fix round 1).
    const bob = await signUp(auth, "bob@example.com");
    if (!bob.ok) throw new Error(bob.code);
    calls.length = 0;
    expect((await reset(auth, "bob@example.com")).ok).toBe(true);
    expect(calls.filter(([name]) => name === "afterEnd")).toEqual([
      ["afterEnd", { session: upSession(bob.value).session, reason: "claim" }],
    ]);
  });

  it("fires afterEnd with password_change for every other session, never the changer's", async () => {
    const { auth, calls } = recorded();
    await signUpAndVerify(auth, "ada@example.com", PASSWORD);
    expect((await signIn(auth)).ok).toBe(true);
    const mine = await signIn(auth);
    if (!mine.ok) throw new Error(mine.code);
    const session = await resolveSession(auth.config, mine.value.token);
    if (!session) throw new Error("no session");
    calls.length = 0;
    const changed = await changePassword(auth.config, {
      session,
      currentPassword: PASSWORD,
      newPassword: "another long password",
    });
    expect(changed.ok).toBe(true);
    const ended = calls.filter(([name]) => name === "afterEnd").map(([, e]) => e);
    expect(ended).toHaveLength(2);
    for (const e of ended) expect(e).toMatchObject({ reason: "password_change" });
    expect(ended.map((e) => (e as { session: { id: string } }).session.id)).not.toContain(
      mine.value.session.id,
    );
  });

  it("fires one afterEnd per row when a sign-out ends a row between the flow's read and its delete (final fix wave M-1)", async () => {
    const { auth, calls } = recorded();
    /**
     * Signs out `token` right after the next session read inside a
     * transaction. The memory adapter lets a write outside a transaction run
     * while one is open, as Postgres read committed and D1 do.
     */
    const signOutAfterRead = (token: string) => {
      const original = auth.storage.transaction.bind(auth.storage);
      let armed = true;
      auth.storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
        original((tx) =>
          fn({
            ...tx,
            findMany: async (m, w, o) => {
              const rows = await tx.findMany(m, w, o);
              if (armed && m === "session") {
                armed = false;
                await destroySession(auth.config, token);
              }
              return rows;
            },
          }),
        );
      return () => {
        auth.storage.transaction = original;
      };
    };
    const perRow = () => {
      const ids = calls
        .filter(([name]) => name === "afterEnd")
        .map(([, e]) => (e as { session: { id: string } }).session.id);
      return { count: ids.length, distinct: new Set(ids).size };
    };

    // The reset.
    await signUpAndVerify(auth, "ada@example.com", PASSWORD);
    const two = await signIn(auth);
    if (!two.ok) throw new Error(two.code);
    calls.length = 0;
    let restore = signOutAfterRead(two.value.token);
    expect((await reset(auth)).ok).toBe(true);
    restore();
    expect(perRow()).toEqual({ count: 2, distinct: 2 });
    expect(calls).toContainEqual(["afterEnd", { session: two.value.session, reason: "sign_out" }]);

    // The change: the changer's session stays; every other session ends once, one by the sign-out.
    await signUpAndVerify(auth, "cara@example.com", PASSWORD);
    const caraIn = () =>
      sessionOnly(
        passwordSignIn(auth.config, {
          email: "cara@example.com",
          password: PASSWORD,
          ip: null,
          userAgent: null,
        }),
      );
    const mine = await caraIn();
    const other = await caraIn();
    if (!mine.ok || !other.ok) throw new Error("sign-in");
    const session = await resolveSession(auth.config, mine.value.token);
    if (!session) throw new Error("no session");
    const others = (
      await auth.storage.findMany("session", [
        { field: "userId", op: "eq", value: session.user.id },
      ])
    ).filter((x) => x.id !== mine.value.session.id);
    expect(others.length).toBeGreaterThanOrEqual(2);
    calls.length = 0;
    restore = signOutAfterRead(other.value.token);
    const changed = await changePassword(auth.config, {
      session,
      currentPassword: PASSWORD,
      newPassword: "another long password",
    });
    restore();
    expect(changed.ok).toBe(true);
    expect(perRow()).toEqual({ count: others.length, distinct: others.length });

    // The claim: a magic link proves bob's address and ends the claimant's two sessions.
    const bob = await signUp(auth, "bob@example.com");
    if (!bob.ok) throw new Error(bob.code);
    await createSession(auth.config, {
      userId: upSession(bob.value).user.id,
      ip: null,
      userAgent: null,
    });
    calls.length = 0;
    restore = signOutAfterRead(upSession(bob.value).token);
    expect((await magicSignIn(auth, "bob@example.com")).ok).toBe(true);
    restore();
    expect(perRow()).toEqual({ count: 2, distinct: 2 });
  });

  it("fires afterEnd with sign_out and with expired, once each, and the sweep fires none", async () => {
    const { auth, calls } = recorded();
    const ada = await auth.seedUser("ada@example.com");
    const out = await createSession(auth.config, { userId: ada.id, ip: null, userAgent: null });
    const expiring = await createSession(auth.config, {
      userId: ada.id,
      ip: null,
      userAgent: null,
    });
    await createSession(auth.config, { userId: ada.id, ip: null, userAgent: null });
    await destroySession(auth.config, out.token);
    auth.clock.advance(31 * 86_400_000);
    expect(await resolveSession(auth.config, expiring.token)).toBeNull();
    // The third row expired too: the sweep deletes it and fires nothing.
    expect((await sweepExpired(auth.config)).sessions).toBe(1);
    // A second sign-out of the same token ends nothing more.
    await destroySession(auth.config, out.token);
    expect(calls).toEqual([
      ["afterEnd", { session: out.session, reason: "sign_out" }],
      ["afterEnd", { session: expiring.session, reason: "expired" }],
    ]);
  });
});
