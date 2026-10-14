import { afterEach, describe, expect, it, vi } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createCaptchaAuth } from "./captcha.ts";

/** A siteverify stub that passes every token and counts the calls. No test calls the network. */
function stubSiteverify(): { calls: number } {
  const seen = { calls: 0 };
  vi.stubGlobal("fetch", async () => {
    seen.calls++;
    return Response.json({ success: true, "error-codes": [] });
  });
  return seen;
}

describe("a captcha on the request flows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the token, and refuses a token that is too long, with no call to the supplier", async () => {
    const siteverify = stubSiteverify();
    const auth = createCaptchaAuth(harness());
    const bare = await call(auth, "POST", "/auth/magic-link/request", { email: "ada@example.com" });
    expect(bare.status).toBe(400);
    expect(await bare.json()).toEqual({ error: "captcha_required" });
    const long = await call(
      auth,
      "POST",
      "/auth/magic-link/request",
      { email: "ada@example.com" },
      { "x-captcha-response": "t".repeat(2049) },
    );
    expect(long.status).toBe(403);
    expect(await long.json()).toEqual({ error: "captcha_failed" });
    expect(siteverify.calls).toBe(0);
  });

  it("sends the mail after the supplier passes the token", async () => {
    const siteverify = stubSiteverify();
    const h = harness();
    const auth = createCaptchaAuth(h);
    const res = await call(
      auth,
      "POST",
      "/auth/magic-link/request",
      { email: "ada@example.com" },
      { "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" },
    );
    expect(await res.json()).toEqual({ sent: true });
    expect(siteverify.calls).toBe(1);
    expect(h.sent.map((m) => m.to)).toEqual(["ada@example.com"]);
  });
});
