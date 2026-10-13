import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { hookRefusal, type SessionHooks } from "../src/engine/hooks.js";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { addMember, createOrganization, removeMember } from "../src/engine/organizations.js";
import {
  changePassword,
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
} from "../src/engine/password.js";
import { createSession, destroySession, resolveSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { makeAuth, tokenFromMail } from "./helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";

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
    password: { hash: FAST },
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
  passwordSignIn(auth.config, {
    email: "ada@example.com",
    password: PASSWORD,
    ip: null,
    userAgent: null,
  });

async function reset(auth: ReturnType<typeof makeAuth>) {
  const asked = await requestPasswordReset(auth.config, { email: "ada@example.com", ip: null });
  if (!asked.ok) throw new Error(asked.code);
  const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
  return resetPassword(auth.config, {
    token,
    password: "another long password",
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
    expect(log.mock.calls).toEqual([["tempo-auth: session patch refused", "the field userId"]]);
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
    // The session is the sign-up's last write: the refusal undid the user and password rows before it.
    expect(await refusing.auth.storage.findMany("user", [])).toEqual([]);
    expect(await refusing.auth.storage.findMany("password", [])).toEqual([]);
    expect(refusing.auth.mail).toHaveLength(mails);
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
      ["tempo-auth: after hook failed", "session.afterCreate", rows[0]?.id, "Error"],
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
    expect(read("password.ts").split('via: "password"')).toHaveLength(5);
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
      ["afterEnd", { session: up.value.session, reason: "claim" }],
    ]);
  });

  it("fires afterEnd once per session, with password_reset, on a reset that ends three sessions", async () => {
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
