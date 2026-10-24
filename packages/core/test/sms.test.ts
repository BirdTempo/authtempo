import { describe, expect, it } from "vitest";
import type { PhoneConfig } from "../src/config.js";
import { createAuth, createMemoryAdapter, createMemoryLimiter, systemClock } from "../src/index.js";
import type { LimiterPort } from "../src/limiter/port.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";

/** A limiter that says it is one count for the deployment. The phone config needs one. */
const shared: LimiterPort = { scope: "shared", allow: async () => true };

/** `createAuth` with `phone`. With "default", the config names no limiter: the memory limiter. */
function build(phone: Partial<PhoneConfig>, limiter: LimiterPort | "default" = shared) {
  return createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    ...(limiter === "default" ? {} : { limiter }),
    phone: { sms: createRecordingSms(), regions: ["+1"], ...phone } as PhoneConfig,
  });
}

describe("the phone config (plan 12i Task 4, spec 32 item 4)", () => {
  it("refuses phone with no regions, an empty list, or 51 entries", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `+${i + 1}`);
    expect(() => build({ regions: undefined as unknown as string[] })).toThrow(
      "phone.regions must list 1 to 50 calling-code prefixes; it has no default",
    );
    expect(() => build({ regions: [] })).toThrow("phone.regions must list 1 to 50");
    expect(() => build({ regions: [...fifty, "+51"] })).toThrow("phone.regions must list 1 to 50");
    expect(() => build({ regions: fifty })).not.toThrow();
  });

  it("refuses a region that is not a calling-code prefix", () => {
    for (const region of ["1", "+0", "+12345", "+1 ", "+"])
      expect(() => build({ regions: [region] }), region).toThrow(
        "a region is a calling-code prefix",
      );
    expect(() => build({ regions: ["+1", "+44", "+1416"] })).not.toThrow();
  });

  it("refuses phone with an isolate limiter", () => {
    const message = "phone needs a shared limiter: the daily cap is per deployment";
    // The default limiter is the memory limiter, which counts per isolate.
    expect(() => build({}, "default")).toThrow(message);
    expect(() => build({}, createMemoryLimiter(systemClock))).toThrow(message);
    // A limiter of the app with no scope counts as isolate.
    expect(() => build({}, { allow: async () => true })).toThrow(message);
    expect(() => build({ isolateLimiter: "allow" }, "default")).not.toThrow();
    expect(() => build({}, shared)).not.toThrow();
    expect(() => build({ isolateLimiter: "yes" as "allow" }, "default")).toThrow(
      'phone.isolateLimiter must be "allow" or absent',
    );
  });

  it("refuses each bound", () => {
    expect(() => build({ ttlMinutes: 0 })).toThrow(
      "phone.ttlMinutes must be an integer from 1 to 10",
    );
    expect(() => build({ ttlMinutes: 11 })).toThrow("phone.ttlMinutes");
    expect(() => build({ ttlMinutes: 10 })).not.toThrow();
    expect(() => build({ length: 7 as 6 })).toThrow("phone.length must be 6 or 8");
    expect(() => build({ maxAttempts: 2 })).toThrow(
      "phone.maxAttempts must be an integer from 3 to 10",
    );
    expect(() => build({ maxAttempts: 11 })).toThrow("phone.maxAttempts");
    expect(() => build({ dailyCap: 0 })).toThrow(
      "phone.dailyCap must be an integer from 1 to 100000",
    );
    expect(() => build({ dailyCap: 100_001 })).toThrow("phone.dailyCap");
    expect(() => build({ dailyCap: 100_000 })).not.toThrow();
    expect(() => build({ sms: {} as PhoneConfig["sms"] })).toThrow("phone.sms must be an SmsPort");
    expect(() => build({ unknown: true } as Partial<PhoneConfig>)).toThrow(
      "phone.unknown is not an option",
    );
  });

  it("keeps phone off by default and with false", () => {
    expect(makeAuth().config.phone).toBeNull();
    expect(makeAuth({ phone: false }).config.phone).toBeNull();
    const on = makeAuth({ limiter: shared, phone: { sms: createRecordingSms(), regions: ["+1"] } });
    expect(on.config.phone).toMatchObject({
      regions: ["+1"],
      signUp: false,
      ttlMinutes: 5,
      length: 6,
      maxAttempts: 3,
      dailyCap: 1000,
    });
  });
});

describe("the recording SMS port (plan 12i Task 4)", () => {
  it("records each text and answers unavailable while down", async () => {
    const sms = createRecordingSms();
    expect(await sms.send({ to: "+14155550100", text: "one" })).toBe("sent");
    sms.down(true);
    expect(await sms.send({ to: "+14155550100", text: "two" })).toBe("unavailable");
    sms.down(false);
    expect(await sms.send({ to: "+14155550101", text: "three" })).toBe("sent");
    expect(sms.sent).toEqual([
      { to: "+14155550100", text: "one" },
      { to: "+14155550101", text: "three" },
    ]);
  });
});
