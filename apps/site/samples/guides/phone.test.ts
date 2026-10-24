import { createMemoryLimiter, systemClock } from "@authtempo/core";
import { createRecordingSms } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { API, call, harness, sessionCookieOf } from "../support/harness.ts";
import { createPhoneAuth } from "./phone.ts";

const json = (path: string, body: unknown) =>
  new Request(`${API}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("sign in with a phone code", () => {
  it("sends a code after the answer, and the code opens the session", async () => {
    const sms = createRecordingSms();
    const auth = createPhoneAuth(harness(), { sms });
    const phone = "+447700900123";
    // The SMS goes out after the answer: give handle the waitUntil of your host.
    const work: Promise<unknown>[] = [];
    const asked = await auth.handle(json("/phone/request", { phone }), {
      waitUntil: (p) => void work.push(p),
    });
    expect(await asked.json()).toEqual({ sent: true });
    await Promise.all(work);
    const code = /\d{6}/.exec(sms.sent.at(-1)?.text ?? "")?.[0] ?? "";
    const res = await call(auth, "POST", "/auth/phone/verify", { phone, code });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { email: string | null } };
    expect(user.email).toBeNull();
    expect(sessionCookieOf(res)).not.toBe("");
  });

  it("refuses a number outside the regions before any SMS", async () => {
    const sms = createRecordingSms();
    const auth = createPhoneAuth(harness(), { sms });
    const res = await call(auth, "POST", "/auth/phone/request", { phone: "+15550100123" });
    expect(await res.json()).toEqual({ error: "phone_region" });
    expect(sms.sent).toEqual([]);
  });

  it("refuses a memory limiter outside tests: the cap is per deployment", () => {
    expect(() => createPhoneAuth(harness(), { limiter: createMemoryLimiter(systemClock) })).toThrow(
      "phone needs a shared limiter: the daily cap is per deployment",
    );
  });
});
