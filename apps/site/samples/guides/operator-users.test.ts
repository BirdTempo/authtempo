import { base32Decode, createRecordingSms, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { call, callSettled, harness, linkIn, sessionCookieOf, signIn } from "../support/harness.ts";
import { createPhoneOnly } from "./operator-phone.ts";
import { correctProfile } from "./operator-update.ts";
import { createForPerson, createOperatorUsersAuth, SUPPORT_DESK } from "./operator-users.ts";
import { addCreatedMember } from "./operator-verified.ts";

const CONFIRM = "/auth/user/invite/confirm";
const PASSWORD = "correct horse battery";
const PHONE = "+447700900123";

/** A test passes the test limiter. An app passes the limiter of its adapter. */
function setup() {
  const h = harness();
  const sms = createRecordingSms();
  const auth = createOperatorUsersAuth({ ...h, limiter: "isolate-for-tests" }, sms);
  return { h, sms, auth };
}
type World = ReturnType<typeof setup>;

/** The audit rows of one user, as the desk reads them. */
async function auditOf({ auth }: World, userId: string) {
  const page = await auth.api.operator.audit.list({ actor: SUPPORT_DESK, targetUserId: userId });
  if (!page.ok) throw new Error(page.code);
  return page.value.rows;
}

/** The token of the invitation link in the last mail to an address. */
const inviteToken = (h: World["h"], to: string) => linkIn(h, to).searchParams.get("token") ?? "";

/** The user of a session cookie pair. */
async function userOf({ auth }: World, cookie: string) {
  const resolved = await auth.api.getSession(cookie.slice(cookie.indexOf("=") + 1));
  if (!resolved) throw new Error("no session");
  return resolved.user;
}

describe("create a user", () => {
  it("mails an invitation, a reset link, or nothing, with self sign-up closed", async () => {
    const w = setup();
    expect(await createForPerson(w.auth, { ticket: "4710", email: "ada@example.com" })).toEqual({
      userId: expect.any(String),
      mailed: "invite",
    });
    expect(linkIn(w.h, "ada@example.com").pathname).toBe(CONFIRM);
    const reset = await createForPerson(w.auth, {
      ticket: "4711",
      email: "bo@example.com",
      firstSignIn: "reset",
    });
    expect(reset).toEqual({ userId: expect.any(String), mailed: "reset" });
    const none = await createForPerson(w.auth, {
      ticket: "4712",
      email: "cy@example.com",
      firstSignIn: "none",
    });
    expect(none).toEqual({ userId: expect.any(String), mailed: null });
    expect(w.h.sent.map((m) => m.to)).toEqual(["ada@example.com", "bo@example.com"]);
    // A taken address mails no one, and writes nothing.
    expect(await createForPerson(w.auth, { ticket: "4713", email: "ada@example.com" })).toEqual({
      error: "email_taken",
    });
    expect(w.h.sent.length).toBe(2);
  });

  it("creates a user with a phone number only, and sends no SMS", async () => {
    const w = setup();
    const made = await createForPerson(w.auth, { ticket: "4714", email: null, phone: PHONE });
    expect(made).toEqual({ userId: expect.any(String), mailed: null });
    expect([w.sms.sent, w.h.sent]).toEqual([[], []]);
  });
});

describe("the invitation link", () => {
  it("opens one session, and the operator never sees the link", async () => {
    const w = setup();
    const made = await createForPerson(w.auth, { ticket: "4720", email: "ada@example.com" });
    const mail = w.h.sent.at(-1);
    expect(mail?.text).toContain("It works once, for 24 hours.");
    const token = inviteToken(w.h, "ada@example.com");
    expect(token.startsWith("ui_")).toBe(true);
    if (!("userId" in made)) throw new Error(made.error);
    // The answer and the audit row hold no part of the link.
    const rows = await auditOf(w, made.userId);
    expect(JSON.stringify([made, rows]).includes(token)).toBe(false);
    expect(rows.map((r) => [r.action, r.data])).toEqual([
      [
        "user_create",
        { emailVerified: false, firstSignIn: "invite", hasAddress: true, hasPhone: false },
      ],
    ]);
    const first = await call(w.auth, "POST", CONFIRM, { token });
    expect(first.status).toBe(200);
    const user = await userOf(w, sessionCookieOf(first));
    expect([user.id, user.emailVerified]).toEqual([made.userId, true]);
    const again = await call(w.auth, "POST", CONFIRM, { token });
    expect([again.status, await again.json()]).toEqual([400, { error: "invalid_token" }]);
  });

  it("answers the challenge for a user with the second factor on", async () => {
    const w = setup();
    const made = await w.auth.api.operator.users.create({
      actor: SUPPORT_DESK,
      email: "ada@example.com",
      emailVerified: true,
      reason: "ticket 4721",
      ip: null,
      userAgent: null,
    });
    if (!made.ok) throw new Error(made.code);
    const token = inviteToken(w.h, "ada@example.com");
    // The person signs in by a magic link first, and turns TOTP on.
    const ada = await signIn(w.auth, w.h, "ada@example.com");
    await call(w.auth, "POST", "/auth/password/change", { newPassword: PASSWORD }, { cookie: ada });
    const setupRes = await call(
      w.auth,
      "POST",
      "/auth/totp/setup",
      { password: PASSWORD },
      { cookie: ada },
    );
    const { secret } = (await setupRes.json()) as { secret: string };
    const enabled = await call(
      w.auth,
      "POST",
      "/auth/totp/enable",
      { code: await totpCode(base32Decode(secret), new Date()) },
      { cookie: ada },
    );
    expect(enabled.status).toBe(200);
    const res = await call(w.auth, "POST", CONFIRM, { token });
    expect(res.status).toBe(200);
    expect("twoFactor" in ((await res.json()) as object)).toBe(true);
    expect(sessionCookieOf(res)).toBe("");
  });
});

describe("the verified flag", () => {
  it("lets an owner add the user before the first sign-in", async () => {
    const w = setup();
    await createForPerson(w.auth, {
      ticket: "4730",
      email: "ada@example.com",
      firstSignIn: "none",
    });
    const ada = await signIn(w.auth, w.h, "ada@example.com");
    const org = await call(
      w.auth,
      "POST",
      "/auth/organizations/create",
      { slug: "team", name: "Team" },
      { cookie: ada },
    );
    const { organization } = (await org.json()) as { organization: { id: string } };
    const owner = await userOf(w, ada);
    const added = await addCreatedMember(w.auth, owner, {
      email: "bo@example.com",
      organizationId: organization.id,
      ticket: "4731",
    });
    expect(added.ok && added.value.role).toBe("member");
    if (!added.ok) throw new Error(added.code);
    const [row] = await auditOf(w, added.value.userId);
    expect(row?.data).toMatchObject({ emailVerified: true });
    // Without the flag, the add waits for a proof of the address.
    const cy = await createForPerson(w.auth, { ticket: "4732", email: "cy@example.com" });
    if (!("userId" in cy)) throw new Error(cy.error);
    const refused = await w.auth.api.addMember({
      user: owner,
      organizationId: organization.id,
      userId: cy.userId,
      role: "member",
    });
    expect(refused.ok ? "ok" : refused.code).toBe("email_unverified");
  });
});

describe("update a name or an image", () => {
  it("changes the name only, and keeps the address and the sessions", async () => {
    const w = setup();
    await createForPerson(w.auth, {
      ticket: "4740",
      email: "ada@example.com",
      firstSignIn: "none",
    });
    const ada = await signIn(w.auth, w.h, "ada@example.com");
    const before = await userOf(w, ada);
    const done = await correctProfile(w.auth, before.id, { name: "Ada King" }, "4741");
    expect(done).toEqual({ name: "Ada King", auditId: expect.any(String) });
    const after = await userOf(w, ada);
    expect([after.name, after.email, after.emailVerified]).toEqual([
      "Ada King",
      before.email,
      before.emailVerified,
    ]);
    const rows = await auditOf(w, before.id);
    expect(rows.find((r) => r.action === "user_update")?.data).toEqual({ fields: ["name"] });
    expect(await correctProfile(w.auth, before.id, { name: null }, "4742")).toEqual({
      name: null,
      auditId: expect.any(String),
    });
    expect(await correctProfile(w.auth, before.id, {}, "4743")).toEqual({
      error: "invalid_body",
    });
  });
});

describe("the phone-only residual", () => {
  it("proves the number at the first phone sign-in", async () => {
    const w = setup();
    const made = await createPhoneOnly(w.auth, PHONE, "4750");
    if (!("userId" in made)) throw new Error(made.error);
    expect(w.sms.sent).toEqual([]);
    // The SMS goes out after the answer: callSettled waits for that work.
    await callSettled(w.auth, "POST", "/auth/phone/request", { phone: PHONE });
    const code = /\d{6}/.exec(w.sms.sent.at(-1)?.text ?? "")?.[0] ?? "";
    const res = await call(w.auth, "POST", "/auth/phone/verify", { phone: PHONE, code });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string; email: string | null } };
    expect([user.id, user.email]).toEqual([made.userId, null]);
  });
});
