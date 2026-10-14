import { describe, expect, it, vi } from "vitest";
import { createTurnstileCaptcha, SITEVERIFY_URL, TURNSTILE_SCRIPT } from "../src/index.js";

interface Call {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown>;
}

function fake(...answers: Array<Response | Error | "hang">) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      init,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const next = answers.shift() ?? answers.at(-1) ?? "hang";
    if (next === "hang")
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchFn, calls };
}

const ok = (extra: Record<string, unknown> = {}) =>
  Response.json({
    success: true,
    hostname: "app.example.com",
    action: "sign-up",
    "error-codes": [],
    ...extra,
  });
const no = (...codes: string[]) => Response.json({ success: false, "error-codes": codes });
const input = { token: "tok", ip: "203.0.113.5", flow: "password-sign-up" as const };

describe("createTurnstileCaptcha (plan 12b)", () => {
  it("posts JSON to siteverify with the secret, the token, the IP, and an idempotency key, and follows no redirect", async () => {
    const f = fake(ok());
    const port = createTurnstileCaptcha({ secretKey: "sk", fetch: f.fetchFn });
    expect(await port.verify(input)).toBe("pass");
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call?.url).toBe(SITEVERIFY_URL);
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.redirect).toBe("manual");
    expect(new Headers(call?.init?.headers).get("content-type")).toBe("application/json");
    expect(call?.body).toEqual({
      secret: "sk",
      response: "tok",
      remoteip: "203.0.113.5",
      idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("answers fail for success false, a spent token, a wrong action, and a hostname not on the list", async () => {
    expect(
      await createTurnstileCaptcha({
        secretKey: "sk",
        fetch: fake(no("invalid-input-response")).fetchFn,
      }).verify(input),
    ).toBe("fail");
    expect(
      await createTurnstileCaptcha({
        secretKey: "sk",
        fetch: fake(no("timeout-or-duplicate")).fetchFn,
      }).verify(input),
    ).toBe("fail");
    expect(
      await createTurnstileCaptcha({
        secretKey: "sk",
        expectedAction: "sign-in",
        fetch: fake(ok()).fetchFn,
      }).verify(input),
    ).toBe("fail");
    expect(
      await createTurnstileCaptcha({
        secretKey: "sk",
        allowedHostnames: ["other.example"],
        fetch: fake(ok()).fetchFn,
      }).verify(input),
    ).toBe("fail");
  });

  it("answers fail and logs the cause, never the secret, when siteverify refuses the secret key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = createTurnstileCaptcha({
      secretKey: "the-secret-key",
      fetch: fake(no("invalid-input-secret")).fetchFn,
    });
    expect(await port.verify(input)).toBe("fail");
    expect(log).toHaveBeenCalledWith(
      "authtempo captcha-turnstile: siteverify refused the secret key",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("the-secret-key");
    log.mockRestore();
  });

  it("retries once with the same idempotency key on a network error and on internal-error", async () => {
    for (const first of [new TypeError("network"), no("internal-error")]) {
      const f = fake(first, ok());
      expect(
        await createTurnstileCaptcha({ secretKey: "sk", fetch: f.fetchFn }).verify(input),
      ).toBe("pass");
      expect(f.calls).toHaveLength(2);
      expect(f.calls[1]?.body.idempotency_key).toBe(f.calls[0]?.body.idempotency_key);
    }
    const twice = fake(no("internal-error"), no("internal-error"));
    expect(
      await createTurnstileCaptcha({ secretKey: "sk", fetch: twice.fetchFn }).verify(input),
    ).toBe("unavailable");
    expect(twice.calls).toHaveLength(2);
  });

  it("answers unavailable for a timeout, a 5xx, a 3xx, and a body that is not JSON, and logs no secret", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = (f: ReturnType<typeof fake>) =>
      createTurnstileCaptcha({ secretKey: "the-secret-key", timeoutMs: 500, fetch: f.fetchFn });
    expect(await port(fake("hang")).verify(input)).toBe("unavailable");
    expect(await port(fake(new Response("x", { status: 502 }))).verify(input)).toBe("unavailable");
    expect(
      await port(
        fake(new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } })),
      ).verify(input),
    ).toBe("unavailable");
    expect(await port(fake(new Response("not json", { status: 200 }))).verify(input)).toBe(
      "unavailable",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("the-secret-key");
    log.mockRestore();
  });

  it("refuses a token over 2048 characters with no call", async () => {
    const f = fake(ok());
    expect(
      await createTurnstileCaptcha({ secretKey: "sk", fetch: f.fetchFn }).verify({
        ...input,
        token: "t".repeat(2049),
      }),
    ).toBe("fail");
    expect(f.calls).toEqual([]);
  });

  it("describes its widget for core's sign-in page when a site key is given", () => {
    expect(createTurnstileCaptcha({ secretKey: "sk" }).page).toBeUndefined();
    expect(
      createTurnstileCaptcha({ secretKey: "sk", siteKey: "1x00000000000000000000AA" }).page,
    ).toEqual({
      scriptSrc: TURNSTILE_SCRIPT,
      widgetHtml: '<div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"></div>',
      responseField: "cf-turnstile-response",
      cspSources: ["https://challenges.cloudflare.com"],
    });
  });

  it("refuses a bad option at construction", () => {
    expect(() => createTurnstileCaptcha({ secretKey: "" })).toThrow(
      "secretKey must be a non-empty string",
    );
    expect(() => createTurnstileCaptcha({ secretKey: "sk", timeoutMs: 100 })).toThrow(
      "timeoutMs must be an integer from 500 to 10000",
    );
    expect(() => createTurnstileCaptcha({ secretKey: "sk", siteKey: 'x"><script>' })).toThrow(
      "siteKey must be 1 to 128 letters, digits, _, or -",
    );
  });
});
