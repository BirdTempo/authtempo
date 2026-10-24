import { describe, expect, it, vi } from "vitest";
import type { AuthConfig, MailMessage, PasswordConfig } from "../src/config.js";
import { type AnonymousLinkEvent, hookRefusal } from "../src/engine/hooks.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import {
  makeAuth,
  post,
  recordAddress,
  recordCredential,
  settled,
  tokenFromMail,
} from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { enrolled } from "./totp-helpers.js";

// The address proof at sign-up by an email code (plan 12i Task 20). With
// `password.verifyBy: "code"`, the sign-up mails a code of 6 digits in place
// of the link. `POST /password/verify/code` spends it and runs the link's
// confirm: the claim rule, and the session of the sign-up. The draw and the
// counter are the email code's (spec 8.10 items 3 and 5).

const EMAIL = recordAddress("ada@example.com");
const PASSWORD = recordCredential("correct horse battery");

function world(password: PasswordConfig = {}, extra: Partial<AuthConfig> = {}) {
  const auth = makeAuth({ password: { hash: FAST, verifyBy: "code", ...password }, ...extra });
  const route = createRouter(auth.config, coreRoutes(auth.config));
  // The code goes out after the answer: `settled` waits for that work.
  return { ...auth, route, handle: settled(route) };
}
type World = ReturnType<typeof world>;

let n = 0;
/** A new client IP, so no per-IP limit decides a test. Core reads `cf-connecting-ip`. */
const ip = () => ({ "cf-connecting-ip": `198.51.100.${(++n % 250) + 1}` });

const signUp = (w: World, email = EMAIL, headers: Record<string, string> = {}) =>
  w.handle(post("/auth/password/sign-up", { email, password: PASSWORD }, { ...ip(), ...headers }));

const confirm = (w: World, code: string, email = EMAIL, headers: Record<string, string> = {}) =>
  w.handle(post("/auth/password/verify/code", { email, code }, { ...ip(), ...headers }));

/** The code of the last mail to `email`: the default text starts with it. */
function lastCode(w: World, email = EMAIL): string {
  const text = w.mail.findLast((m) => m.to === email)?.text ?? "";
  const code = /^(\d{6}) is your /.exec(text)?.[1];
  if (code === undefined) throw new Error(`no code in the mail: ${text}`);
  return recordCredential(code);
}

/** A 6-digit code that is not `code`. */
const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

const codeRows = (w: World) =>
  w.storage.findMany("verification", [
    { field: "purpose", op: "eq", value: "password-verify-otp" },
  ]);

const userOf = (w: World, email = EMAIL) =>
  w.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);

/** The session token of an answer that set the session cookie, or null. */
function setToken(w: World, res: Response): string | null {
  const name = `${w.config.cookieName}=`;
  const line = res.headers.getSetCookie().find((s) => s.startsWith(name));
  const token = line?.slice(name.length).split(";")[0];
  return token ? recordCredential(token) : null;
}

/** Status and body, for a compare of two refusals. */
async function answer(res: Response) {
  return { status: res.status, body: (await res.json()) as unknown };
}

describe("the sign-up code (plan 12i Task 20)", () => {
  it("mails a code in place of a link with verifyBy code", async () => {
    const w = world();
    const res = await signUp(w);
    expect(await res.json()).toEqual({ sent: true });
    expect(w.mail).toHaveLength(1);
    const mail = w.mail[0] as MailMessage;
    expect(mail.to).toBe(EMAIL);
    expect(mail.text).toMatch(
      /^\d{6} is your api\.example\.com code to confirm your address\. It expires in 10 minutes\./,
    );
    expect(mail.text).not.toMatch(/https?:|token=/);
    // One code row, keyed by the address, and no link row.
    const rows = await w.storage.findMany("verification", []);
    expect(rows.map((r) => r.purpose)).toEqual(["password-verify-otp"]);
    const [row] = rows;
    const user = await userOf(w);
    const password = await w.storage.findOne("password", [
      { field: "userId", op: "eq", value: user?.id ?? "" },
    ]);
    expect(row?.identifier).toBe(EMAIL);
    expect(row?.data).toEqual({ passwordId: password?.id, attempts: 0 });
    expect(row?.valueHash).not.toContain(lastCode(w));
    expect((row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)).toBe(600_000);
    // The link stays the default.
    const linked = makeAuth({ password: { hash: FAST } });
    const r = settled(createRouter(linked.config, coreRoutes(linked.config)));
    await r(post("/auth/password/sign-up", { email: EMAIL, password: PASSWORD }, ip()));
    expect(linked.mail[0]?.text).toContain("/auth/password/verify?token=");
  });

  it("verifies the address and finishes the sign-up as the link confirm does", async () => {
    const w = world();
    await signUp(w);
    const code = lastCode(w);
    // The claimant's session: a password sign-in of the unverified user.
    const claimant = await w.handle(
      post("/auth/password/sign-in", { email: EMAIL, password: PASSWORD }, ip()),
    );
    const claimantToken = setToken(w, claimant);
    expect(claimantToken).not.toBeNull();
    const res = await confirm(w, code);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { emailVerified: boolean } };
    // With uniformSignUp (the default), the session opens here.
    const token = setToken(w, res);
    expect(token).not.toBeNull();
    expect(body.token).toBe(token);
    expect(body.user.emailVerified).toBe(true);
    expect((await userOf(w))?.emailVerified).toBe(true);
    // The claim rule ran: the claimant's session is gone, and only the new one stays.
    const sessions = await w.storage.findMany("session", []);
    expect(sessions).toHaveLength(1);
    const me = await w.handle(
      new Request("https://api.example.com/auth/session", {
        headers: { authorization: `Bearer ${claimantToken}` },
      }),
    );
    expect(me.status).toBe(401);
    // The email identity: the address signs in by a magic link now.
    const user = await userOf(w);
    const identities = await w.storage.findMany("identity", [
      { field: "userId", op: "eq", value: user?.id ?? "" },
    ]);
    expect(identities.map((i) => i.provider)).toEqual(["email"]);
  });

  it("answers invalid_code for a wrong code, an unknown address, and a spent code alike", async () => {
    const w = world();
    await signUp(w);
    const code = lastCode(w);
    const wrong = await answer(await confirm(w, wrongFor(code)));
    const unknown = await answer(await confirm(w, code, recordAddress("nobody@example.com")));
    const malformed = await answer(await confirm(w, code, "not an address"));
    expect(wrong).toEqual({ status: 400, body: { error: "invalid_code" } });
    expect(unknown).toEqual(wrong);
    expect(malformed).toEqual(wrong);
    expect((await confirm(w, code)).status).toBe(200);
    expect(await answer(await confirm(w, code))).toEqual(wrong);
    // An expired code answers the same: core does not tell expiry from a wrong code.
    await signUp(w, recordAddress("bea@example.com"));
    const late = lastCode(w, "bea@example.com");
    w.clock.advance(600_000);
    expect(await answer(await confirm(w, late, "bea@example.com"))).toEqual(wrong);
  });

  it("caps the guesses by compare-and-set and spends the row at the cap", async () => {
    const w = world();
    await signUp(w);
    const code = lastCode(w);
    // Five wrong codes at once: every guess counts, and the fifth spends the row.
    const answers = await Promise.all(
      Array.from({ length: 5 }, async () => (await answer(await confirm(w, wrongFor(code)))).body),
    );
    expect(answers.map((a) => (a as { error: string }).error).sort()).toEqual([
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "too_many_attempts",
    ]);
    const [row] = await codeRows(w);
    expect(row?.data).toMatchObject({ attempts: 5 });
    expect(row?.consumedAt).not.toBeNull();
    // The right code no longer opens the session.
    expect(await answer(await confirm(w, code))).toEqual({
      status: 400,
      body: { error: "too_many_attempts" },
    });
    expect(await w.storage.findMany("session", [])).toEqual([]);
    expect((await userOf(w))?.emailVerified).toBe(false);
  });

  it("gates the session of a user with the factor on: a verified user gets no session", async () => {
    // A user who turned the factor on before the code: a reset by link
    // proved the address, then the factor went on. An unverified user cannot
    // turn the factor on (provedAccount). So a user with the factor is a
    // verified user at the confirm. The confirm opens no session for that
    // user, as the link's confirm does, so the code never passes the gate.
    const w = world();
    await signUp(w);
    const code = lastCode(w);
    await w.handle(post("/auth/password/reset/request", { email: EMAIL }, ip()));
    const reset = w.mail.findLast((m) => m.to === EMAIL && m.text.includes("/password/reset?"));
    const done = await w.handle(
      post("/auth/password/reset", { token: tokenFromMail(reset?.text ?? ""), password: PASSWORD }),
    );
    expect(done.status).toBe(200);
    await enrolled(w);
    const before = await w.storage.findMany("session", []);
    const res = await confirm(w, code);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await w.storage.findMany("session", [])).toEqual(before);
    // No challenge row either: nothing waits for a second factor.
    expect(
      await w.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "two-factor" },
      ]),
    ).toEqual([]);
  });

  it("resends a new code and spends the old one", async () => {
    const w = world();
    await signUp(w);
    const first = lastCode(w);
    const res = await w.handle(post("/auth/password/verify/resend", { email: EMAIL }, ip()));
    expect(await res.json()).toEqual({ sent: true });
    expect(w.mail).toHaveLength(2);
    const second = lastCode(w);
    const rows = await codeRows(w);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.consumedAt === null)).toHaveLength(1);
    // One chance in a million that the two draws match: then the old code is the new one.
    if (first !== second)
      expect(await answer(await confirm(w, first))).toEqual({
        status: 400,
        body: { error: "invalid_code" },
      });
    expect((await confirm(w, second)).status).toBe(200);
    // An address with no unverified password user gets the same answer and no mail.
    const other = await w.handle(
      post("/auth/password/verify/resend", { email: recordAddress("cy@example.com") }, ip()),
    );
    expect(await other.json()).toEqual({ sent: true });
    expect(w.mail).toHaveLength(2);
  });

  it("applies the limits", async () => {
    const w = world();
    // password-verify-code:email, 10 per 15 minutes, from 11 IPs.
    for (let i = 0; i < 10; i++)
      expect((await answer(await confirm(w, "000000"))).body).toEqual({ error: "invalid_code" });
    expect(await answer(await confirm(w, "000000"))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    // password-verify-code:ip, 30 per 15 minutes, for 31 addresses.
    const one = { "cf-connecting-ip": "203.0.113.77" };
    for (let i = 0; i < 30; i++) {
      const res = await confirm(w, "000000", recordAddress(`ip-${i}@example.com`), one);
      expect((await answer(res)).body).toEqual({ error: "invalid_code" });
    }
    const capped = await confirm(w, "000000", recordAddress("ip-30@example.com"), one);
    expect((await answer(capped)).status).toBe(429);
    // Both windows are 15 minutes.
    w.clock.advance(899_000);
    expect((await confirm(w, "000000")).status).toBe(429);
    w.clock.advance(1_000);
    expect((await confirm(w, "000000")).status).toBe(400);
    const after = await confirm(w, "000000", recordAddress("ip-31@example.com"), one);
    expect(after.status).toBe(400);
  });

  it("links an anonymous user only from the same anonymous session", async () => {
    const links: AnonymousLinkEvent[] = [];
    const w = world(
      {},
      {
        anonymous: { isolateLimiter: "allow" },
        hooks: { anonymous: { afterLink: (e) => void links.push(e) } },
      },
    );
    /** One anonymous sign-in through the route: the cookie of its jar and its user id. */
    const jar = async () => {
      const res = await w.handle(post("/auth/anonymous/sign-in", {}, ip()));
      const token = setToken(w, res);
      if (!token) throw new Error("no anonymous session");
      const cookie = `${w.config.cookieName}=${token}`;
      const me = await w.handle(
        new Request("https://api.example.com/auth/session", { headers: { cookie } }),
      );
      return { cookie, userId: ((await me.json()) as { user: { id: string } }).user.id };
    };
    const isAnonymous = async (id: string) =>
      (await w.storage.findOne("user", [{ field: "id", op: "eq", value: id }]))?.isAnonymous;
    // The sign-up from the anonymous jar records its user in the code row.
    const a = await jar();
    await signUp(w, EMAIL, { cookie: a.cookie });
    const [row] = await codeRows(w);
    expect(row?.data).toMatchObject({ anonymousUserId: a.userId });
    // The confirm from the same jar links the anonymous user.
    const done = await confirm(w, lastCode(w), EMAIL, { cookie: a.cookie });
    expect(done.status).toBe(200);
    expect(links.map((l) => [l.anonymousUser.id, l.proof, l.via])).toEqual([
      [a.userId, "verified", "password"],
    ]);
    expect(await isAnonymous(a.userId)).toBeUndefined();
    // A code asked from a jar and confirmed from no jar, or from another
    // anonymous jar, signs in and links nothing.
    for (const [email, other] of [
      [recordAddress("dee@example.com"), false],
      [recordAddress("eve@example.com"), true],
    ] as const) {
      const from = await jar();
      await signUp(w, email, { cookie: from.cookie });
      const at = other ? { cookie: (await jar()).cookie } : {};
      const res = await confirm(w, lastCode(w, email), email, at);
      expect(res.status).toBe(200);
      expect(setToken(w, res)).not.toBeNull();
      expect(links).toHaveLength(1);
      expect(await isAnonymous(from.userId)).toBe(true);
    }
  });

  it("answers hook_refused and hook_failed from a before hook of the confirm", async () => {
    let mode: "refuse" | "throw" = "refuse";
    const w = world(
      {},
      {
        hooks: {
          user: {
            beforeVerify: () => {
              if (mode === "refuse") throw hookRefusal("Not now.");
              throw new Error("down");
            },
          },
        },
      },
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await signUp(w);
    expect(await answer(await confirm(w, lastCode(w)))).toEqual({
      status: 403,
      body: { error: "hook_refused", message: "Not now." },
    });
    mode = "throw";
    const bea = recordAddress("bea@example.com");
    await signUp(w, bea);
    expect((await answer(await confirm(w, lastCode(w, bea), bea))).body).toEqual({
      error: "hook_failed",
    });
    log.mockRestore();
    // Neither confirm opened a session or verified the user.
    expect(await w.storage.findMany("session", [])).toEqual([]);
    expect((await userOf(w))?.emailVerified).toBe(false);
  });

  it("answers the sign-up and the resend before the mail goes, for a new and a known address", async () => {
    // Ruling 23 of plan 12i: with the code, the slow work that differs by
    // account runs after the answer. That is the code row and its mail, or
    // the mail to a known address. A mail port that waits until released shows it.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: MailMessage[] = [];
    const w = world(
      {},
      {
        mail: {
          send: async (m) => {
            await gate;
            sent.push(m);
          },
        },
      },
    );
    const work: Promise<unknown>[] = [];
    const call = (path: string, body: unknown) =>
      Promise.race([
        w.route(post(path, body, ip()), { waitUntil: (p) => void work.push(p) }),
        new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 1_000)),
      ]);
    const answers = [
      await call("/auth/password/sign-up", { email: EMAIL, password: PASSWORD }),
      await call("/auth/password/sign-up", { email: EMAIL, password: PASSWORD }),
      await call("/auth/password/verify/resend", { email: EMAIL }),
      await call("/auth/password/verify/resend", { email: recordAddress("fay@example.com") }),
    ];
    for (const a of answers) {
      expect(a).not.toBe("held");
      if (a !== "held") expect(await a.json()).toEqual({ sent: true });
    }
    expect(sent).toEqual([]);
    release();
    await Promise.all(work);
    // The new address got a code, the known address the existing-account
    // mail, the resend a new code, and the unknown address nothing.
    expect(sent.map((m) => m.to)).toEqual([EMAIL, EMAIL, EMAIL]);
    expect(sent[1]?.subject).toBe("Your account at api.example.com");
  });
});
