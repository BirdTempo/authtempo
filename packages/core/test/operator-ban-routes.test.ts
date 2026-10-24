import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { operatorApi } from "../src/engine/operator/index.js";
import { passwordSignUp } from "../src/engine/password.js";
import { addPhone, verifyAddPhone } from "../src/engine/phone.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { ROUTES } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { BASE_URL, tokenFromMail } from "./helpers.js";
import { operatorAuth } from "./operator-helpers.js";
import { signUpAndVerify } from "./password-helpers.js";
import { enrolled, PASSWORD } from "./totp-helpers.js";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const EMAIL = "ada@example.com";
const APP = { kind: "app", name: "support-tool" } as const;
const BANNED = { status: 403, code: "account_banned" };

/**
 * The sign-in routes that answer 403 `account_banned` since plan 12f Task 6,
 * typed here. Each opens a session through `prepareSession` or writes a
 * challenge through `writeChallenge`. The last three reach the ban only in
 * a race: the ban deletes the challenges and the handoff codes in its
 * transaction. The passkey and the provider routes need a ceremony or an
 * exchange; operator-ban-doors.test.ts proves their engine path.
 */
const BAN_ROUTES = [
  "POST /password/sign-in",
  "POST /password/verify",
  "POST /password/reset",
  "POST /otp/verify",
  "POST /otp/reset",
  "POST /magic-link/verify",
  "POST /passkey/authenticate/verify",
  "GET /social/:provider/callback",
  "POST /social/apple/callback",
  "POST /handoff/redeem",
  "POST /totp/verify",
  "POST /totp/challenge",
  // Plan 12d Task 5: the SSO callback opens a session through prepareSession.
  "GET /sso/:connectionId/callback",
  // Plan 12d Task 8: the SAML ACS opens a session through the same resolution.
  "POST /sso/:connectionId/acs",
  // Plan 12i Task 5: the phone code opens a session through prepareSession.
  "POST /phone/verify",
] as const;

/** The routes of the operator tools that refuse a banned target (plan 12f Task 10). */
const OPERATOR_ROUTES = ["POST /operator/users/platform-role", "POST /operator/users/create-admin"];

async function world() {
  // The phone code of plan 12i Task 5 reads its codes from this port.
  const sms = createRecordingSms();
  const auth = await operatorAuth({ phone: { sms, regions: ["+1"], isolateLimiter: "allow" } });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const post = (path: string, body: unknown) =>
    handle(
      new Request(`${BASE_URL}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.60" },
        body: JSON.stringify(body),
      }),
    );
  const ban = async () => {
    const user = await auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
    if (!user) throw new Error("no user");
    const r = await operatorApi(auth.config).users.ban({
      actor: APP,
      userId: user.id,
      reason: "Abuse report 1",
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
  };
  const lastToken = () => tokenFromMail(auth.mail.at(-1)?.text ?? "");
  const lastCode = () => /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
  const lastSms = () => /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
  return { auth, post, ban, lastToken, lastCode, lastSms };
}

async function answerOf(res: Response): Promise<{ status: number; code: string | null }> {
  const body = (await res.json()) as { error?: string };
  return { status: res.status, code: body.error ?? null };
}

describe("account_banned at the sign-in routes (plan 12f Task 10, lead item 3)", () => {
  it("declares account_banned on each route that can answer it, and on no other", () => {
    const declared = ROUTES.filter((r) => (r.codes as readonly string[]).includes("account_banned"))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(declared).toEqual([...BAN_ROUTES, ...OPERATOR_ROUTES].sort());
  });

  it("answers 403 account_banned to a banned user at each sign-in route with a mailed or typed proof", async () => {
    const w = await world();
    await signUpAndVerify(w.auth, EMAIL, PASSWORD);
    await w.ban();
    // The password sign-in, after the credential check.
    expect(
      await answerOf(await w.post("/password/sign-in", { email: EMAIL, password: PASSWORD })),
    ).toEqual(BANNED);
    // The magic link: the mail goes out as for any user, and the verify refuses.
    await w.post("/magic-link/request", { email: EMAIL });
    expect(await answerOf(await w.post("/magic-link/verify", { token: w.lastToken() }))).toEqual(
      BANNED,
    );
    // The email code.
    await w.post("/otp/request", { email: EMAIL });
    expect(
      await answerOf(await w.post("/otp/verify", { email: EMAIL, code: w.lastCode() })),
    ).toEqual(BANNED);
    // The two resets open a session, so the ban stops each.
    await w.post("/password/reset/request", { email: EMAIL });
    expect(
      await answerOf(
        await w.post("/password/reset", {
          token: w.lastToken(),
          password: "another long password",
        }),
      ),
    ).toEqual(BANNED);
    await w.post("/otp/reset/request", { email: EMAIL });
    expect(
      await answerOf(
        await w.post("/otp/reset", {
          email: EMAIL,
          code: w.lastCode(),
          password: "another long password",
        }),
      ),
    ).toEqual(BANNED);
    // No session stays.
    expect(await w.auth.storage.findMany("session", [])).toEqual([]);
  });

  it("answers 403 account_banned to a banned user at the phone code verify (plan 12i Task 5)", async () => {
    const w = await world();
    await signUpAndVerify(w.auth, EMAIL, PASSWORD);
    // The phone of the user, set by a real code with a session of the user.
    const user = await w.auth.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
    if (!user) throw new Error("no user");
    const { token } = await createSession(w.auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    const session = await resolveSession(w.auth.config, token);
    if (!session) throw new Error("no session");
    const phone = "+14155550100";
    if (!(await addPhone(w.auth.config, { session, phone, ip: null })).ok) throw new Error("add");
    const set = await verifyAddPhone(w.auth.config, {
      session,
      code: w.lastSms(),
      ip: null,
      userAgent: null,
    });
    if (!set.ok) throw new Error(set.code);
    await w.ban();
    await w.post("/phone/request", { phone });
    expect(await answerOf(await w.post("/phone/verify", { phone, code: w.lastSms() }))).toEqual(
      BANNED,
    );
  });

  it("answers 403 account_banned to the verify link of a sign-up when the ban came after the mail", async () => {
    const w = await world();
    const up = await passwordSignUp(w.auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok) throw new Error(up.code);
    const token = w.lastToken();
    await w.ban();
    expect(await answerOf(await w.post("/password/verify", { token }))).toEqual(BANNED);
  });

  it("answers 403 account_banned with no challenge to a banned user with the factor on", async () => {
    const w = await world();
    await enrolled(w.auth, EMAIL);
    await w.ban();
    expect(
      await answerOf(await w.post("/password/sign-in", { email: EMAIL, password: PASSWORD })),
    ).toEqual(BANNED);
    expect(await w.auth.storage.findMany("session", [])).toEqual([]);
  });
});
