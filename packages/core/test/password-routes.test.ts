import { describe, expect, it } from "vitest";
import { APP_ORIGIN, BASE_URL, get, post } from "./helpers.js";
import { FAST, pwHandle } from "./password-helpers.js";

const EMAIL = "ada@example.com";
const PW = "correct horse battery";

function form(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: APP_ORIGIN,
      ...headers,
    },
    body,
  });
}

/** The token of the last mail whose subject starts with `subject`. */
function lastToken(h: ReturnType<typeof pwHandle>, subject: string): string {
  const token = h.mails.findLast((m) => m.subject.startsWith(subject))?.token;
  if (!token) throw new Error(`no ${subject} mail`);
  return token;
}

/** The `name=value` part of the session cookie, for a later request. */
function cookiePair(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("password verify routes", () => {
  it("GET /password/verify answers the confirm page with no side effect", async () => {
    const h = pwHandle({ hash: FAST });
    await h.auth.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
    const token = lastToken(h, "Confirm");
    const res = await h.auth.handle(get(`/auth/password/verify?token=${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("set-cookie")).toBeNull();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(await res.text()).toContain('<form method="post" action="/auth/password/verify">');
    const [row] = await h.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "password-verify" },
    ]);
    expect(row?.consumedAt).toBeNull();
  });

  it("GET /password/verify with a malformed token redirects to the app with invalid_token", async () => {
    const h = pwHandle({ hash: FAST });
    const res = await h.auth.handle(get("/auth/password/verify?token=bad"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://api.example.com/?auth_error=invalid_token");
  });

  it("POST /password/verify signs in by form and by JSON, and refuses a replay", async () => {
    const h = pwHandle({ hash: FAST });
    await h.auth.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
    const first = lastToken(h, "Confirm");
    const res = await h.auth.handle(form("/auth/password/verify", `token=${first}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://api.example.com/");
    expect(res.headers.get("set-cookie")).toMatch(/^tempo_session=ts_/);

    await h.auth.handle(post("/auth/password/sign-up", { email: "b@example.com", password: PW }));
    const second = lastToken(h, "Confirm");
    const js = await h.auth.handle(post("/auth/password/verify", { token: second }));
    expect(js.status).toBe(200);
    expect(await js.json()).toEqual({ verified: true });
    expect(js.headers.get("set-cookie")).toMatch(/^tempo_session=ts_/);

    const replay = await h.auth.handle(post("/auth/password/verify", { token: second }));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_token" });
  });
});

describe("password reset routes", () => {
  it("POST /password/reset/request answers sent", async () => {
    const h = pwHandle({ hash: FAST });
    const res = await h.auth.handle(post("/auth/password/reset/request", { email: EMAIL }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
  });

  it("GET /password/reset answers the page, shows a known error only, and uses a custom page", async () => {
    const h = pwHandle({ hash: FAST });
    await h.auth.handle(post("/auth/password/reset/request", { email: EMAIL }));
    const token = lastToken(h, "Reset");
    const res = await h.auth.handle(get(`/auth/password/reset?token=${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain('name="password"');
    const policy = await h.auth.handle(
      get(`/auth/password/reset?token=${token}&error=password_policy`),
    );
    expect(await policy.text()).toContain("Use 8 to 128 characters");
    const other = await h.auth.handle(get(`/auth/password/reset?token=${token}&error=other`));
    expect(await other.text()).not.toContain('class="error"');
    const bad = await h.auth.handle(get("/auth/password/reset?token=bad"));
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe("https://api.example.com/?auth_error=invalid_token");

    const custom = pwHandle({ hash: FAST, resetPage: (i) => `<p>custom ${i.token}</p>` });
    await custom.auth.handle(post("/auth/password/reset/request", { email: EMAIL }));
    const t = lastToken(custom, "Reset");
    const page = await custom.auth.handle(get(`/auth/password/reset?token=${t}`));
    expect(await page.text()).toBe(`<p>custom ${t}</p>`);
  });

  it("POST /password/reset sends a refused password back to the form, then signs in", async () => {
    const h = pwHandle({ hash: FAST });
    await h.auth.handle(post("/auth/password/reset/request", { email: EMAIL }));
    const token = lastToken(h, "Reset");
    const short = await h.auth.handle(
      form("/auth/password/reset", `token=${token}&password=short`),
    );
    expect(short.status).toBe(302);
    expect(short.headers.get("location")).toBe(
      `https://api.example.com/auth/password/reset?token=${token}&error=password_policy`,
    );
    const done = await h.auth.handle(
      form("/auth/password/reset", `token=${token}&password=new+password+1`),
    );
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("https://api.example.com/");
    expect(done.headers.get("set-cookie")).toMatch(/^tempo_session=ts_/);
    const replay = await h.auth.handle(
      form("/auth/password/reset", `token=${token}&password=new+password+2`),
    );
    expect(replay.headers.get("location")).toBe(
      "https://api.example.com/?auth_error=invalid_token",
    );

    await h.auth.handle(post("/auth/password/reset/request", { email: EMAIL }));
    const again = lastToken(h, "Reset");
    const js = await h.auth.handle(
      post("/auth/password/reset", { token: again, password: "new password 3" }),
    );
    expect(js.status).toBe(200);
    const body = (await js.json()) as { token: string };
    expect(body.token).toMatch(/^ts_/);
  });
});

describe("password change route", () => {
  it("POST /password/change needs a session and changes the password with the current one", async () => {
    const h = pwHandle({ hash: FAST });
    const none = await h.auth.handle(
      post("/auth/password/change", { currentPassword: "x", newPassword: "changed password" }),
    );
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "unauthorized" });

    await h.auth.handle(post("/auth/password/reset/request", { email: EMAIL }));
    const token = lastToken(h, "Reset");
    const done = await h.auth.handle(
      form("/auth/password/reset", `token=${token}&password=new+password+1`),
    );
    const cookie = cookiePair(done);
    const wrong = await h.auth.handle(
      post(
        "/auth/password/change",
        { currentPassword: "wrong password", newPassword: "changed password" },
        { cookie },
      ),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid_credentials" });
    const res = await h.auth.handle(
      post(
        "/auth/password/change",
        { currentPassword: "new password 1", newPassword: "changed password" },
        { cookie },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const signIn = await h.auth.handle(
      post("/auth/password/sign-in", { email: EMAIL, password: "changed password" }),
    );
    expect(signIn.status).toBe(200);
  });

  it("answers 404 for every new route without a password config", async () => {
    const h = pwHandle(undefined);
    for (const req of [
      get("/auth/password/verify?token=x"),
      post("/auth/password/verify", { token: "x" }),
      post("/auth/password/reset/request", { email: EMAIL }),
      get("/auth/password/reset?token=x"),
      post("/auth/password/reset", { token: "x", password: "y" }),
      post("/auth/password/change", { newPassword: "y" }),
    ]) {
      expect((await h.auth.handle(req)).status).toBe(404);
    }
    expect(h.auth.api.password).toBeUndefined();
  });

  it("has every method on api.password", () => {
    const h = pwHandle({ hash: FAST });
    expect(Object.keys(h.auth.api.password ?? {}).sort()).toEqual([
      "change",
      "requestReset",
      "resendVerification",
      "reset",
      "signIn",
      "signUp",
      "verify",
      "verifyEmail",
    ]);
  });
});

describe("the reset page and code points (plan 8b)", () => {
  it("takes a 128-code-point password of astral characters through the reset form and refuses 129", async () => {
    const h = pwHandle({ hash: FAST });
    await h.auth.handle(post("/auth/password/reset/request", { email: EMAIL }));
    const token = lastToken(h, "Reset");
    const page = await (await h.auth.handle(get(`/auth/password/reset?token=${token}`))).text();
    expect(page).not.toMatch(/minlength|maxlength/);
    // U+1D11E is two UTF-16 code units: 128 code points are 256 units.
    const clef = "\u{1D11E}";
    const refused = await h.auth.handle(
      form(
        "/auth/password/reset",
        `token=${token}&password=${encodeURIComponent(clef.repeat(129))}`,
      ),
    );
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toBe(
      `https://api.example.com/auth/password/reset?token=${token}&error=password_policy`,
    );
    const accepted = await h.auth.handle(
      form(
        "/auth/password/reset",
        `token=${token}&password=${encodeURIComponent(clef.repeat(128))}`,
      ),
    );
    expect(accepted.status).toBe(302);
    expect(accepted.headers.get("location")).toBe("https://api.example.com/");
    expect(accepted.headers.get("set-cookie")).toMatch(/^tempo_session=ts_/);
  });
});

describe("password resend route (plan 8b)", () => {
  it("POST /password/verify/resend answers sent and mails a new link", async () => {
    const h = pwHandle({ hash: FAST });
    await h.auth.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
    const res = await h.auth.handle(post("/auth/password/verify/resend", { email: EMAIL }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(h.mails.filter((m) => m.subject.startsWith("Confirm"))).toHaveLength(2);
    const bad = await h.auth.handle(post("/auth/password/verify/resend", { email: 5 }));
    expect(bad.status).toBe(400);
  });

  it("answers 429 rate_limited for the 21st resend from one IP", async () => {
    const h = pwHandle({ hash: FAST });
    const ip = { "cf-connecting-ip": "7.7.7.7" };
    for (let i = 0; i < 20; i++) {
      const r = await h.auth.handle(
        post("/auth/password/verify/resend", { email: `x${i}@example.com` }, ip),
      );
      expect(r.status).toBe(200);
    }
    const res = await h.auth.handle(
      post("/auth/password/verify/resend", { email: "y@example.com" }, ip),
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("answers 404 with no password config", async () => {
    const h = pwHandle(undefined);
    const res = await h.auth.handle(post("/auth/password/verify/resend", { email: EMAIL }));
    expect(res.status).toBe(404);
  });
});
