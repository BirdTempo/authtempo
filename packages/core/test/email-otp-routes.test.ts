import { describe, expect, it } from "vitest";
import type { AuthConfig, MailMessage } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { APP_ORIGIN, BASE_URL, post } from "./helpers.js";
import { FAST } from "./password-helpers.js";

const EMAIL = "ada@example.com";

function server(extra: Partial<AuthConfig> = {}, withPassword = true) {
  const mail: MailMessage[] = [];
  const storage = createMemoryAdapter();
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    ...(withPassword ? { password: { hash: FAST } } : {}),
    ...extra,
  });
  const code = () => {
    const m = /\b(\d{6})\b/.exec(mail.at(-1)?.text ?? "");
    if (!m?.[1]) throw new Error("no code mailed");
    return m[1];
  };
  return { auth, storage, mail, code };
}

const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

describe("email code routes (plan 9e)", () => {
  it("POST /otp/request answers sent, 400 on a bad body, and 429 at the limit", async () => {
    const { auth, mail } = server();
    const ok = await auth.handle(post("/auth/otp/request", { email: EMAIL }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sent: true });
    expect(mail).toHaveLength(1);
    const bad = await auth.handle(post("/auth/otp/request", { nope: 1 }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_body" });
    await auth.handle(post("/auth/otp/request", { email: EMAIL }));
    await auth.handle(post("/auth/otp/request", { email: EMAIL }));
    const limited = await auth.handle(post("/auth/otp/request", { email: EMAIL }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
  });

  it("POST /otp/verify answers { token, user, session } with the cookie, invalid_code for a wrong code, and too_many_attempts at the cap", async () => {
    const { auth, code } = server();
    await auth.handle(post("/auth/otp/request", { email: EMAIL }));
    const right = code();
    const miss = await auth.handle(
      post("/auth/otp/verify", { email: EMAIL, code: wrongFor(right) }),
    );
    expect(miss.status).toBe(400);
    expect(await miss.json()).toEqual({ error: "invalid_code" });
    const res = await auth.handle(post("/auth/otp/verify", { email: EMAIL, code: right }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { email: string }; session: object };
    expect(Object.keys(body).sort()).toEqual(["session", "token", "user"]);
    expect(body.token).toMatch(/^ts_/);
    expect(body.user.email).toBe(EMAIL);
    expect(res.headers.get("set-cookie")).toContain(`tempo_session=${body.token}`);
    await auth.handle(post("/auth/otp/request", { email: EMAIL }));
    const other = wrongFor(code());
    for (let i = 0; i < 4; i++)
      await auth.handle(post("/auth/otp/verify", { email: EMAIL, code: other }));
    const capped = await auth.handle(post("/auth/otp/verify", { email: EMAIL, code: other }));
    expect(capped.status).toBe(400);
    expect(await capped.json()).toEqual({ error: "too_many_attempts" });
  });

  it("POST /otp/reset/request and /otp/reset reset the password and answer the session; a weak password answers password_policy", async () => {
    const { auth, code } = server();
    expect((await auth.handle(post("/auth/otp/reset/request", { email: EMAIL }))).status).toBe(200);
    const weak = await auth.handle(
      post("/auth/otp/reset", { email: EMAIL, code: code(), password: "short" }),
    );
    expect(weak.status).toBe(400);
    expect(await weak.json()).toEqual({ error: "password_policy" });
    await auth.handle(post("/auth/otp/reset/request", { email: EMAIL }));
    const res = await auth.handle(
      post("/auth/otp/reset", { email: EMAIL, code: code(), password: "a new long password" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body).toMatchObject({
      token: expect.stringMatching(/^ts_/),
      user: { email: EMAIL, emailVerified: true },
    });
    expect(res.headers.get("set-cookie")).toContain(`tempo_session=${body.token}`);
    const signIn = await auth.handle(
      post("/auth/password/sign-in", { email: EMAIL, password: "a new long password" }),
    );
    expect(signIn.status).toBe(200);
  });

  it("POST /otp/reset answers invalid_body on a bad body, password_breached, and too_many_attempts at the cap (M-8)", async () => {
    // A clock that steps 1 ms per read, so the two code rows never share a
    // millisecond and the capped row is the newest (see `newestCode`).
    let tick = Date.parse("2026-01-01T00:00:00.000Z");
    const { auth, code } = server({
      password: { hash: FAST, breachCheck: async () => true },
      clock: { now: () => new Date(tick++) },
    });
    for (const body of [{ email: EMAIL, code: "123456" }, { email: EMAIL, password: "x" }, {}]) {
      const bad = await auth.handle(post("/auth/otp/reset", body));
      expect({ body, status: bad.status, json: await bad.json() }).toEqual({
        body,
        status: 400,
        json: { error: "invalid_body" },
      });
    }
    await auth.handle(post("/auth/otp/reset/request", { email: EMAIL }));
    const breached = await auth.handle(
      post("/auth/otp/reset", { email: EMAIL, code: code(), password: "a new long password" }),
    );
    expect(breached.status).toBe(400);
    expect(await breached.json()).toEqual({ error: "password_breached" });
    await auth.handle(post("/auth/otp/reset/request", { email: EMAIL }));
    const right = code();
    const reset = (c: string) =>
      auth.handle(post("/auth/otp/reset", { email: EMAIL, code: c, password: "a long password" }));
    for (let i = 0; i < 4; i++) expect((await reset(wrongFor(right))).status).toBe(400);
    const capped = await reset(wrongFor(right));
    expect(capped.status).toBe(400);
    expect(await capped.json()).toEqual({ error: "too_many_attempts" });
    expect(await (await reset(right)).json()).toEqual({ error: "too_many_attempts" });
  });

  it("answers 404 on the four routes with emailOtp: false, and leaves api.emailOtp out", async () => {
    const { auth } = server({ emailOtp: false });
    for (const path of ["/otp/request", "/otp/verify", "/otp/reset/request", "/otp/reset"])
      expect({
        path,
        status: (
          await auth.handle(
            post(`/auth${path}`, { email: EMAIL, code: "123456", password: "a long password" }),
          )
        ).status,
      }).toEqual({ path, status: 404 });
    expect(auth.api.emailOtp).toBeUndefined();
  });

  it("serves the sign-in code without a password config, and answers 404 on the reset routes", async () => {
    const { auth } = server({}, false);
    expect((await auth.handle(post("/auth/otp/request", { email: EMAIL }))).status).toBe(200);
    expect((await auth.handle(post("/auth/otp/reset/request", { email: EMAIL }))).status).toBe(404);
    expect(
      (
        await auth.handle(
          post("/auth/otp/reset", { email: EMAIL, code: "123456", password: "a long password" }),
        )
      ).status,
    ).toBe(404);
    expect(await auth.api.emailOtp?.requestReset({ email: EMAIL, ip: null })).toMatchObject({
      code: "not_found",
    });
  });

  it("exposes the four operations on api", async () => {
    const { auth, code } = server();
    expect(await auth.api.emailOtp?.request({ email: EMAIL, ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const v = await auth.api.emailOtp?.verify({
      email: EMAIL,
      code: code(),
      ip: null,
      userAgent: null,
    });
    expect(v?.ok && v.value.user.email).toBe(EMAIL);
    expect(await auth.api.emailOtp?.requestReset({ email: EMAIL, ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const r = await auth.api.emailOtp?.reset({
      email: EMAIL,
      code: code(),
      password: "a new long password",
      ip: null,
      userAgent: null,
    });
    expect(r?.ok && Object.keys(r.value).sort()).toEqual(["session", "token", "user"]);
  });

  it("refuses a POST from a foreign origin before the code check, and counts no guess", async () => {
    const { auth, storage } = server();
    await auth.handle(post("/auth/otp/request", { email: EMAIL }));
    const res = await auth.handle(
      post(
        "/auth/otp/verify",
        { email: EMAIL, code: "000000" },
        { origin: "https://evil.example" },
      ),
    );
    expect(res.status).toBe(403);
    const [row] = await storage.findMany("verification", []);
    expect(row?.data).toEqual({ attempts: 0 });
  });
});
