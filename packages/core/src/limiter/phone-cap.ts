import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config.js";
import { createAuth } from "../create-auth.js";
import { checkPhoneCode, sendPhoneCode } from "../engine/phone.js";
import type { StorageAdapter } from "../storage/port.js";
import { createRecordingSms } from "../testing/recording-sms.js";
import type { LimiterPort } from "./port.js";

export interface PhoneCapTarget {
  /** A limiter whose `scope` is `"shared"`. The config refuses any other. */
  limiter: LimiterPort;
  /** An empty store at schema version 15 or later. */
  storage: StorageAdapter;
  /** The database queries so far, when the target counts them (D1). */
  queries?: () => number;
  close(): Promise<void>;
}

/** The D1 Free budget of one invocation: 50 queries (D1 limits page, read 2026-10-24). */
const D1_QUERY_BUDGET = 50;

/**
 * Counts every call of each port method. A count of port calls is the same
 * on every adapter, so one pin holds the path everywhere.
 */
function counted<T extends object>(port: T, count: { calls: number }): T {
  return new Proxy(port, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        count.calls++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * The phone code's daily cap on a shared limiter (plan 12i Task 4, Review
 * Focus 3). The cap is a promise per deployment, so it must hold when
 * parallel requests race on the database limiter. Each adapter package
 * runs this suite with its own limiter and store.
 */
export function runPhoneCapConformance(name: string, factory: () => Promise<PhoneCapTarget>): void {
  describe(`phone cap: ${name}`, () => {
    it("the daily cap holds under 40 parallel requests on a shared limiter", async () => {
      const target = await factory();
      try {
        const sms = createRecordingSms();
        // No `isolateLimiter`: the config builds only with a shared limiter.
        const config = resolveConfig({
          baseURL: "https://auth.example.com",
          secret: "0123456789abcdef0123456789abcdef",
          trustedOrigins: [],
          storage: target.storage,
          mail: { send: async () => {} },
          limiter: target.limiter,
          phone: { sms, regions: ["+1"], dailyCap: 5 },
        });
        const answers = await Promise.all(
          Array.from({ length: 40 }, (_, i) => {
            const to = `+1415555${String(100 + i).padStart(4, "0")}`;
            return sendPhoneCode(config, { purpose: "phone-otp", identifier: to, to, data: {} });
          }),
        );
        expect(answers.filter((a) => a === "sent")).toHaveLength(5);
        expect(answers.filter((a) => a === "capped")).toHaveLength(35);
        expect(sms.sent).toHaveLength(5);
      } finally {
        await target.close();
      }
    });

    it("the daily cap holds under 40 parallel requests through POST /phone/request", async () => {
      // Plan 12i Task 5: the same race through the route, with `signUp` on, so
      // each new number takes the branch that sends. Each request has its own
      // IP, so the per-IP key never decides. The send runs after the answer
      // (ruling 23 of plan 12i): every answer is 200, and the race is in the
      // work that `waitUntil` keeps.
      const target = await factory();
      try {
        const sms = createRecordingSms();
        // The sink keeps each event, so the test counts the refused sends.
        const events: { name: string; reason?: unknown }[] = [];
        const auth = createAuth({
          baseURL: "https://auth.example.com",
          secret: "0123456789abcdef0123456789abcdef",
          trustedOrigins: ["https://app.example.com"],
          storage: target.storage,
          mail: { send: async () => {} },
          limiter: target.limiter,
          phone: { sms, regions: ["+1"], dailyCap: 5, signUp: true },
          observe: { sink: { write: (batch) => void events.push(...batch) } },
        });
        const after: Promise<unknown>[] = [];
        const waitUntil = (p: Promise<unknown>) => void after.push(p);
        const answers = await Promise.all(
          Array.from({ length: 40 }, (_, i) =>
            auth.handle(
              new Request("https://auth.example.com/auth/phone/request", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  origin: "https://app.example.com",
                  "cf-connecting-ip": `198.51.100.${i + 1}`,
                },
                body: JSON.stringify({ phone: `+1415555${String(200 + i).padStart(4, "0")}` }),
              }),
              { waitUntil },
            ),
          ),
        );
        expect(answers.map((r) => r.status)).toEqual(Array.from({ length: 40 }, () => 200));
        await Promise.all(after);
        expect(sms.sent).toHaveLength(5);
        // The flush of each request waits for its send, so every line is in the sink.
        const capped = events.filter((e) => e.name === "sms.not_sent" && e.reason === "capped");
        expect(capped).toHaveLength(35);
      } finally {
        await target.close();
      }
    });

    it("sends and checks a code in a pinned count of port calls, inside the D1 budget", async () => {
      const target = await factory();
      try {
        const sms = createRecordingSms();
        const storageCalls = { calls: 0 };
        const limiterCalls = { calls: 0 };
        const config = resolveConfig({
          baseURL: "https://auth.example.com",
          secret: "0123456789abcdef0123456789abcdef",
          trustedOrigins: [],
          storage: counted(target.storage, storageCalls),
          mail: { send: async () => {} },
          limiter: counted(target.limiter, limiterCalls),
          phone: { sms, regions: ["+1"] },
        });
        const to = "+14155550100";
        const before = target.queries?.() ?? 0;
        expect(
          await sendPhoneCode(config, { purpose: "phone-otp", identifier: to, to, data: {} }),
        ).toBe("sent");
        // The send: the cap, then the spend of the older codes, the newest read, and the row.
        expect({ storage: storageCalls.calls, limiter: limiterCalls.calls }).toEqual({
          storage: 3,
          limiter: 1,
        });
        const code = /^(\d{6}) /.exec(sms.sent[0]?.text ?? "")?.[1] ?? "";
        const checked = await checkPhoneCode(config, {
          purpose: "phone-otp",
          identifier: to,
          code,
          ip: "203.0.113.9",
        });
        expect(checked.ok).toBe(true);
        // The check: the two verify limits, then the live code read.
        expect({ storage: storageCalls.calls, limiter: limiterCalls.calls }).toEqual({
          storage: 4,
          limiter: 3,
        });
        // On D1 the 7 port calls of this path take 8 queries of the 50 (read 2026-10-24).
        if (target.queries) {
          expect(target.queries() - before).toBe(8);
          expect(target.queries() - before).toBeLessThanOrEqual(D1_QUERY_BUDGET);
        }
      } finally {
        await target.close();
      }
    });
  });
}
