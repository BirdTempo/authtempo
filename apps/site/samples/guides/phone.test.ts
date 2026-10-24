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

/** A test passes the test value. An app passes the limiter of its adapter. */
const forTests = () => ({ ...harness(), limiter: "isolate-for-tests" as const });

describe("sign in with a phone code", () => {
  it("sends a code after the answer, and the code opens the session", async () => {
    const sms = createRecordingSms();
    const auth = createPhoneAuth(forTests(), sms);
    const phone = "+447700900123";
    // The SMS goes out after the answer: give handle the waitUntil of your host.
    const work: Promise<unknown>[] = [];
    const asked = await auth.handle(json("/phone/request", { phone }), {
      waitUntil: (p) => void work.push(p),
    });
    expect(await asked.json()).toEqual({ sent: true });
    // At the answer, the send waits in the after-answer work.
    expect(sms.sent).toEqual([]);
    expect(work.length).toBe(1);
    await Promise.all(work);
    expect(sms.sent.length).toBe(1);
    const code = /\d{6}/.exec(sms.sent.at(-1)?.text ?? "")?.[0] ?? "";
    const res = await call(auth, "POST", "/auth/phone/verify", { phone, code });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { email: string | null } };
    expect(user.email).toBeNull();
    expect(sessionCookieOf(res)).not.toBe("");
  });

  it("refuses a number outside the regions before any SMS", async () => {
    const sms = createRecordingSms();
    const auth = createPhoneAuth(forTests(), sms);
    const res = await call(auth, "POST", "/auth/phone/request", { phone: "+15550100123" });
    expect(await res.json()).toEqual({ error: "phone_region" });
    expect(sms.sent).toEqual([]);
  });

  it("refuses a memory limiter outside tests: the cap is per deployment", () => {
    const limiter = createMemoryLimiter(systemClock);
    expect(() => createPhoneAuth({ ...harness(), limiter })).toThrow(
      "phone needs a shared limiter: the daily cap is per deployment",
    );
  });

  it("refuses a call with no limiter, as from plain JavaScript", () => {
    // The type needs a limiter. A call that skips the type check gets the refusal.
    expect(() => createPhoneAuth(harness() as never)).toThrow(
      "phone needs a shared limiter: the daily cap is per deployment",
    );
  });
});
