import { describe, expect, it, vi } from "vitest";
import { CAPTCHA_FLOWS, type CaptchaFlow, type CaptchaPort } from "../src/captcha.js";
import { type AuthConfig, ConfigError } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { TEST_SECRET } from "../src/testing/soft-authenticator.js";
import { FAST } from "./password-helpers.js";

const BASE = "https://api.example.com";
type Answer = "pass" | "fail" | "unavailable" | "throw";

function fakePort(answer: Answer) {
  const calls: Array<{ token: string; flow: CaptchaFlow; ip: string | null }> = [];
  const port: CaptchaPort = {
    async verify(input) {
      calls.push(input);
      if (answer === "throw") throw new Error("down");
      return answer;
    },
  };
  return { port, calls };
}

function setup(captcha: AuthConfig["captcha"], extra: Partial<AuthConfig> = {}) {
  return createAuth({
    baseURL: BASE,
    secret: TEST_SECRET,
    trustedOrigins: ["https://app.example.com"],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    password: { hash: FAST },
    // The phone code request of plan 12i Task 5, on the memory limiter.
    phone: { sms: createRecordingSms(), regions: ["+1"], isolateLimiter: "allow" },
    // The anonymous sign-in of plan 12i Task 6.
    anonymous: { isolateLimiter: "allow" },
    // The passkey-first sign-up of plan 12i Task 8.
    passkey: {
      rpID: "api.example.com",
      rpName: "Example",
      origins: [BASE],
      signUp: { isolateLimiter: "allow" },
    },
    ...(captcha ? { captcha } : {}),
    ...extra,
  });
}

/** Each gated route with a body that passes its body check. */
const ROUTE_OF: Record<CaptchaFlow, Array<{ path: string; body: Record<string, string> }>> = {
  "password-sign-up": [
    {
      path: "/password/sign-up",
      body: { email: "a@example.com", password: "correct horse battery" },
    },
  ],
  "password-sign-in": [
    {
      path: "/password/sign-in",
      body: { email: "a@example.com", password: "correct horse battery" },
    },
  ],
  "magic-link-request": [{ path: "/magic-link/request", body: { email: "a@example.com" } }],
  "email-otp-request": [{ path: "/otp/request", body: { email: "a@example.com" } }],
  "password-reset-request": [
    { path: "/password/reset/request", body: { email: "a@example.com" } },
    { path: "/otp/reset/request", body: { email: "a@example.com" } },
  ],
  // Plan 12i Task 5: the code request. The add has a fresh session and no captcha.
  "phone-request": [{ path: "/phone/request", body: { phone: "+14155550100" } }],
  // Plan 12i Task 6: the anonymous sign-in writes a user row.
  "anonymous-sign-in": [{ path: "/anonymous/sign-in", body: {} }],
  // Plan 12i Task 8: the options of a passkey-first sign-up write a challenge row.
  "passkey-sign-up": [{ path: "/passkey/sign-up/options", body: { name: "Ana" } }],
};

const post = (path: string, body: unknown, token?: string, ip = "203.0.113.5") =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      ...(token !== undefined ? { "x-captcha-response": token } : {}),
    },
    body: JSON.stringify(body),
  });

const DEFAULT: CaptchaFlow[] = [
  "password-sign-up",
  "magic-link-request",
  "email-otp-request",
  "password-reset-request",
];

describe("the captcha port (plan 12b)", () => {
  it.each(DEFAULT.flatMap((flow) => ROUTE_OF[flow].map((r) => ({ flow, ...r }))))(
    "gates $path by default: no token, a failed token, and a passed token",
    async ({ flow, path, body }) => {
      const failing = fakePort("fail");
      const a = setup({ port: failing.port });
      expect(await (await a.handle(post(path, body))).json()).toEqual({
        error: "captcha_required",
      });
      const refused = await a.handle(post(path, body, "tok"));
      expect({ status: refused.status, body: await refused.json() }).toEqual({
        status: 403,
        body: { error: "captcha_failed" },
      });
      expect(failing.calls).toEqual([{ token: "tok", flow, ip: "203.0.113.5" }]);
      const passing = fakePort("pass");
      const b = setup({ port: passing.port });
      expect((await b.handle(post(path, body, "tok"))).status).toBe(200);
    },
  );

  it("leaves the password sign-in open unless the app names its flow", async () => {
    const off = fakePort("fail");
    const res = await setup({ port: off.port }).handle(
      post("/password/sign-in", ROUTE_OF["password-sign-in"][0]?.body),
    );
    expect(res.status).toBe(401);
    expect(off.calls).toEqual([]);
    const on = fakePort("fail");
    const gated = await setup({ port: on.port, flows: ["password-sign-in"] }).handle(
      post("/password/sign-in", ROUTE_OF["password-sign-in"][0]?.body, "tok"),
    );
    expect(await gated.json()).toEqual({ error: "captcha_failed" });
  });

  it("refuses a token over 2048 characters with no call", async () => {
    const f = fakePort("pass");
    const res = await setup({ port: f.port }).handle(
      post("/magic-link/request", { email: "a@example.com" }, "t".repeat(2049)),
    );
    expect(await res.json()).toEqual({ error: "captcha_failed" });
    expect(f.calls).toEqual([]);
  });

  it("goes on with one log line when the port cannot answer, and refuses with onUnavailable refuse", async () => {
    for (const answer of ["unavailable", "throw"] as const) {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const allow = setup({ port: fakePort(answer).port });
      expect(
        (await allow.handle(post("/magic-link/request", { email: "a@example.com" }, "tok"))).status,
      ).toBe(200);
      expect(log).toHaveBeenCalledWith(
        "authtempo: the captcha did not answer",
        "magic-link-request",
      );
      const refuse = setup({ port: fakePort(answer).port, onUnavailable: "refuse" });
      const res = await refuse.handle(
        post("/magic-link/request", { email: "a@example.com" }, "tok"),
      );
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 503,
        body: { error: "captcha_unavailable" },
      });
      log.mockRestore();
    }
  });

  it("runs the per-IP limit first: a request over it makes no call", async () => {
    const f = fakePort("pass");
    const auth = setup({ port: f.port });
    // magic-link:ip is 20 per 15 minutes. A new address each time, so no per-email limit counts.
    for (let i = 0; i < 21; i++)
      await auth.handle(post("/magic-link/request", { email: `a${i}@example.com` }, "tok"));
    expect(f.calls).toHaveLength(20);
  });

  it.each(Object.values(ROUTE_OF).flat())(
    "spends no per-email limit of $path on a request with no token, so a bot cannot block the mail to an address",
    async ({ path, body }) => {
      const auth = setup({ port: fakePort("pass").port, flows: [...CAPTCHA_FLOWS] });
      // Each per-email limit of these flows is 10 or less. Eleven refused requests from eleven IP addresses.
      for (let i = 0; i < 11; i++) {
        const res = await auth.handle(post(path, body, undefined, `203.0.113.${i + 10}`));
        expect(res.status).toBe(400);
      }
      const res = await auth.handle(post(path, body, "tok"));
      expect(res.status).not.toBe(429);
      expect(res.status).not.toBe(400);
    },
  );

  it("skips the check for an in-process call with no token, and checks a token that the app passes", async () => {
    const f = fakePort("fail");
    const auth = setup({ port: f.port });
    expect(await auth.api.requestMagicLink({ email: "a@example.com", ip: null })).toEqual({
      ok: true,
      value: { sent: true },
    });
    expect(
      await auth.api.requestMagicLink({ email: "a@example.com", ip: null, captchaToken: "tok" }),
    ).toMatchObject({ ok: false, code: "captcha_failed" });
  });

  it("lists the header in the preflight answer", async () => {
    const res = await setup(undefined).handle(
      new Request(`${BASE}/auth/magic-link/request`, {
        method: "OPTIONS",
        headers: { origin: "https://app.example.com" },
      }),
    );
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "content-type, authorization, x-captcha-response",
    );
  });

  it("refuses a malformed captcha config", () => {
    const port = fakePort("pass").port;
    const cases: Array<[unknown, string]> = [
      [{ port: {} }, "captcha.port must have a verify function"],
      [
        { port, flows: [] },
        "captcha.flows must be a list of 1 or more distinct flows: password-sign-up, password-sign-in, magic-link-request, email-otp-request, password-reset-request, phone-request, anonymous-sign-in, passkey-sign-up",
      ],
      [
        { port, flows: ["sign-up"] },
        "captcha.flows must be a list of 1 or more distinct flows: password-sign-up, password-sign-in, magic-link-request, email-otp-request, password-reset-request, phone-request, anonymous-sign-in, passkey-sign-up",
      ],
      [{ port, onUnavailable: "fail" }, 'captcha.onUnavailable must be "allow" or "refuse"'],
      [
        { port, extra: 1 },
        "captcha.extra is not an option; core has port, flows, and onUnavailable",
      ],
      [
        {
          port: {
            ...port,
            page: {
              scriptSrc: "http://x.example/a.js",
              widgetHtml: "",
              responseField: "f",
              cspSources: [],
            },
          },
        },
        "captcha.port.page.scriptSrc must be an https URL",
      ],
      [
        {
          port: {
            ...port,
            page: {
              scriptSrc: "https://x.example/a.js",
              widgetHtml: "<div></div>",
              responseField: "a b",
              cspSources: ["https://x.example"],
            },
          },
        },
        "captcha.port.page.responseField must be 1 to 64 letters, digits, _, or -",
      ],
      [
        {
          port: {
            ...port,
            page: {
              scriptSrc: "https://x.example/a.js",
              widgetHtml: "<div></div>",
              responseField: "f",
              cspSources: ["https://x.example/path"],
            },
          },
        },
        "captcha.port.page.cspSources must hold https origins with no path",
      ],
      [{ port: { ...port, page: "x" } }, "captcha.port.page must be an object"],
      [
        {
          port: {
            ...port,
            page: {
              scriptSrc: "https://x.example/a.js",
              widgetHtml: "x".repeat(4097),
              responseField: "f",
              cspSources: ["https://x.example"],
            },
          },
        },
        "captcha.port.page.widgetHtml must be a string of at most 4096 characters",
      ],
    ];
    for (const [captcha, message] of cases)
      expect(() => setup(captcha as never)).toThrow(new ConfigError(message));
  });

  it("puts the widget in the sign-in page with its script, its field, and its policy", async () => {
    const page = {
      scriptSrc: "https://captcha.example/api.js",
      widgetHtml: '<div class="w" data-key="k"></div>',
      responseField: "captcha-response",
      cspSources: ["https://captcha.example"],
    };
    const auth = setup(
      { port: { ...fakePort("pass").port, page } },
      { handoff: { schemes: ["example://"] } },
    );
    const start = await auth.handle(
      new Request(
        `${BASE}/auth/handoff/start?redirect=${encodeURIComponent("example://auth")}&challenge=${"a".repeat(43)}`,
      ),
    );
    const res =
      start.status === 302
        ? await auth.handle(new Request(start.headers.get("location") ?? ""))
        : start;
    const html = await res.text();
    const policy = res.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1] ?? "";
    expect(html).toContain(
      `<script src="https://captcha.example/api.js" nonce="${nonce}" async defer></script>`,
    );
    expect(html.split('<div class="w" data-key="k"></div>')).toHaveLength(3);
    expect(html).toContain('data-captcha-field="captcha-response"');
    expect(policy).toContain(`script-src 'nonce-${nonce}' https://captcha.example;`);
    expect(policy).toContain("frame-src https://captcha.example;");
  });

  it("needs a page while core serves its own sign-in page, so the page can send a token", () => {
    const port = fakePort("pass").port;
    const message =
      "captcha.port.page is required while core serves its sign-in page (handoff or oauth) with a gated flow on it. Without the widget, the page sends no token, so each gated flow on it answers captcha_required. Give the port a page, or set handoff.signInPage";
    expect(() => setup({ port }, { handoff: { schemes: ["example://"] } })).toThrow(
      new ConfigError(message),
    );
    const oauth = {
      resources: ["https://api.example.com/mcp"],
      fetch: (async () => new Response()) as typeof fetch,
    };
    expect(() => setup({ port }, { oauth })).toThrow(new ConfigError(message));
    // The app's own page shows its own widget: no page is needed.
    expect(() =>
      setup({ port }, { handoff: { schemes: ["example://"], signInPage: () => "<p>own</p>" } }),
    ).not.toThrow();
    // Core's page has no email code form: a config that gates only the email code needs no page.
    expect(() =>
      setup({ port, flows: ["email-otp-request"] }, { handoff: { schemes: ["example://"] } }),
    ).not.toThrow();
    // With no password config, the page has no password form: password flows alone need no page.
    const noPassword = (flows: CaptchaFlow[]) =>
      createAuth({
        baseURL: BASE,
        secret: TEST_SECRET,
        trustedOrigins: ["https://app.example.com"],
        storage: createMemoryAdapter(),
        mail: { send: async () => {} },
        handoff: { schemes: ["example://"] },
        captcha: { port, flows },
      });
    expect(() =>
      noPassword(["password-sign-in", "password-sign-up", "password-reset-request"]),
    ).not.toThrow();
    // The magic link form is always on the page.
    expect(() => noPassword(["magic-link-request"])).toThrow(new ConfigError(message));
    // No page of core is served: no page is needed.
    expect(() => setup({ port })).not.toThrow();
  });

  it("keeps the checked page: a later change to port.page does not reach the sign-in page", async () => {
    const page = {
      scriptSrc: "https://captcha.example/api.js",
      widgetHtml: '<div class="w"></div>',
      responseField: "captcha-response",
      cspSources: ["https://captcha.example"],
    };
    const port: CaptchaPort = { ...fakePort("pass").port, page };
    const auth = setup({ port }, { handoff: { schemes: ["example://"] } });
    page.scriptSrc = "http://evil.example/x.js";
    page.widgetHtml = "<script>alert(1)</script>";
    page.cspSources.push("http://evil.example");
    port.page = { ...page, responseField: "other" };
    const res = await auth.handle(
      new Request(
        `${BASE}/auth/handoff/start?redirect=${encodeURIComponent("example://auth")}&challenge=${"a".repeat(43)}`,
      ),
    );
    const html = await res.text();
    const policy = res.headers.get("content-security-policy") ?? "";
    expect(html).toContain('<script src="https://captcha.example/api.js"');
    expect(html).toContain('<div class="w"></div>');
    expect(html).toContain('data-captcha-field="captcha-response"');
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("alert(1)");
    expect(policy).not.toContain("evil.example");
  });

  it("refuses a request with no token the same for a known and an unknown address, with no work", async () => {
    const counts = { storage: 0, hash: 0, verify: 0, breach: 0, mail: 0 };
    const memory = createMemoryAdapter();
    const storage = new Proxy(memory, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          counts.storage++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const hash = {
      hash: (p: string) => {
        counts.hash++;
        return FAST.hash(p);
      },
      verify: (p: string, stored: string) => {
        counts.verify++;
        return FAST.verify(p, stored);
      },
      dummy: () => FAST.dummy(),
    };
    const auth = createAuth({
      baseURL: BASE,
      secret: TEST_SECRET,
      trustedOrigins: ["https://app.example.com"],
      storage,
      mail: {
        send: async () => {
          counts.mail++;
        },
      },
      password: {
        hash,
        uniformSignUp: false,
        breachCheck: async () => {
          counts.breach++;
          return false;
        },
      },
      phone: { sms: createRecordingSms(), regions: ["+1"], isolateLimiter: "allow" },
      anonymous: { isolateLimiter: "allow" },
      passkey: {
        rpID: "api.example.com",
        rpName: "Example",
        origins: [BASE],
        signUp: { isolateLimiter: "allow" },
      },
      captcha: { port: fakePort("pass").port, flows: [...CAPTCHA_FLOWS] },
    });
    const known = "known@example.com";
    const seeded = await auth.api.password?.signUp({
      email: known,
      password: "correct horse battery",
      ip: null,
      userAgent: null,
    });
    expect(seeded?.ok).toBe(true);
    const answer = async (path: string, email: string) => {
      // The phone request names a number: no user holds either one, and the refusal reads none.
      const body =
        path === "/password/sign-up" || path === "/password/sign-in"
          ? { email, password: "correct horse battery" }
          : path === "/phone/request"
            ? { phone: email === known ? "+14155550100" : "+14155550101" }
            : // The anonymous sign-in names nobody: the two answers are the same by design.
              path === "/anonymous/sign-in"
              ? {}
              : // The passkey-first sign-up names a person, never an account (plan 12i Task 8).
                path === "/passkey/sign-up/options"
                ? { name: email === known ? "Known" : "Unknown" }
                : { email };
      const res = await auth.handle(post(path, body));
      // The trace header is random for each answer (plan 12h Task 4). Each answer
      // carries one, and the compare leaves it out.
      expect(res.headers.get("x-authtempo-trace")).toMatch(/^[0-9a-f]{32}$/);
      const headers = [...res.headers].filter(([k]) => k !== "x-authtempo-trace");
      return { status: res.status, headers, body: await res.text() };
    };
    const paths = Object.values(ROUTE_OF).flatMap((routes) => routes.map((r) => r.path));
    expect(paths).toHaveLength(9);
    for (const k of Object.keys(counts) as Array<keyof typeof counts>) counts[k] = 0;
    for (const path of paths) {
      const a = await answer(path, known);
      const b = await answer(path, "unknown@example.com");
      expect({ path, ...a }).toEqual({ path, ...b });
      expect(a.status).toBe(400);
      expect(JSON.parse(a.body)).toEqual({ error: "captcha_required" });
    }
    // The memory limiter holds the limit counts; storage, the hash, the breach port, and the mail never ran.
    expect(counts).toEqual({ storage: 0, hash: 0, verify: 0, breach: 0, mail: 0 });
  });
});
