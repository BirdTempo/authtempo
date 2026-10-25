import { applyD1Migrations, env } from "cloudflare:test";
import { createPbkdf2PasswordHash } from "@authtempo/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { betterAuthPasswordHash } from "../../src/hash.js";
import { anonymous, multiSession, phoneNumber, username } from "../../src/plugins.js";
import { betterAuth } from "../../src/server/better-auth.js";
import { betterAuthSchemaStorage } from "../../src/storage/index.js";
import type { EmailCallbackData } from "../../src/types.js";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { counting } from "./counting.js";
import { execD1 } from "./schema.js";

// Plan 12i Task 16 on D1: each path of the sign-in plugins in one
// invocation. D1 Free allows 50 queries per invocation (D1 limits page
// updated 21 April 2026, read 2026-10-24). Each invocation is a new
// storage and a new shim over the counting binding, so the ready check
// counts too. The counts pin each path: a change shows here first.
//
// Core's revokedFor (engine/operator/guards.ts) reads the pending-end rows
// of a user once (+1 query) when a session began at or before the user's
// last write, in milliseconds. So the count of a path depended on the
// clock: a fast machine made more ties (ruling 42 M2). The clock here stands
// still, so every session ties its user's last write: each count is the
// worst case, the same on every machine.

await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

const BASE = "https://api.example.com";
const PASSWORD = "a long passphrase 1";
const passwordHash = betterAuthPasswordHash({
  pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
});
const codes: string[] = [];
const verifies: EmailCallbackData[] = [];

function shim(db: D1Database) {
  return betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    database: betterAuthSchemaStorage({ dialect: "d1", db }),
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async (d) => {
        verifies.push(d);
      },
    },
    plugins: [
      anonymous({ onLinkAccount: () => {} }),
      username(),
      phoneNumber({
        sendOTP: (d) => {
          codes.push(d.code);
        },
        signUpOnVerification: { getTempEmail: (n) => `${n}@phone.placeholder.invalid` },
      }),
      multiSession(),
    ],
    authtempo: { passwordHash, phone: { regions: ["+1"] } },
  });
}

/** One browser: its cookies, and one request per invocation, counted or not. */
function browser() {
  const cookies = new Map<string, string>();
  const send = async (counted: boolean, path: string, body?: unknown) => {
    const c = counting(env.DB);
    const auth = shim(counted ? c.db : env.DB);
    const res = await auth.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: BASE,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(cookies.size > 0
            ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    for (const set of res.headers.getSetCookie()) {
      const pair = set.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
      if (value === "" || /max-age=0(;|$)/i.test(set)) cookies.delete(pair.slice(0, at));
      else cookies.set(pair.slice(0, at), value);
    }
    return { status: res.status, body: (await res.json()) as unknown, queries: c.count.queries };
  };
  return {
    call: (path: string, body?: unknown) => send(true, path, body),
    setup: (path: string, body?: unknown) => send(false, path, body),
  };
}

describe("the paths of the sign-in plugins on D1 (plan 12i Task 16)", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T00:00:00.000Z"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("sends 50 queries or fewer at each path", async () => {
    const counts: Record<string, [number, number]> = {};
    const take = (name: string, r: { status: number; queries: number }) => {
      counts[name] = [r.status, r.queries];
    };
    // Anonymous: the sign-in, the sign-up over it (onLinkAccount reads two sessions), the delete.
    const a = browser();
    take("/sign-in/anonymous", await a.call("/sign-in/anonymous", {}));
    take(
      "sign-up over anonymous",
      await a.call("/password/sign-up", { email: "ann@example.com", password: PASSWORD }),
    );
    const d = browser();
    await d.setup("/sign-in/anonymous", {});
    take("/delete-anonymous-user", await d.call("/delete-anonymous-user", {}));
    // Username.
    const u = browser();
    await u.setup("/password/sign-up", {
      email: "uma@example.com",
      password: PASSWORD,
      username: "uma",
    });
    take("/is-username-available", await u.call("/is-username-available", { username: "uma" }));
    take(
      "/sign-in/username",
      await browser().call("/sign-in/username", { username: "uma", password: PASSWORD }),
    );
    // Phone: a sign-up by code, then the add to a proved account and the password sign-in by phone.
    const p = browser();
    take(
      "/phone-number/send-otp",
      await p.call("/phone-number/send-otp", { phoneNumber: "+14155550101" }),
    );
    take(
      "/phone-number/verify",
      await p.call("/phone-number/verify", { phoneNumber: "+14155550101", code: codes.at(-1) }),
    );
    const token = verifies.find((v) => v.user.email === "uma@example.com")?.token;
    await u.setup("/password/verify", { token });
    take(
      "/phone-number/send-otp (add)",
      await u.call("/phone-number/send-otp", { phoneNumber: "+14155550102" }),
    );
    take(
      "/phone-number/verify (add)",
      await u.call("/phone-number/verify", {
        phoneNumber: "+14155550102",
        code: codes.at(-1),
        updatePhoneNumber: true,
      }),
    );
    take(
      "/sign-in/phone-number",
      await browser().call("/sign-in/phone-number", {
        phoneNumber: "+14155550102",
        password: PASSWORD,
      }),
    );
    // Phone over an anonymous session: the code signs in and upgrades it (ruling 42 H1).
    const q = browser();
    await q.setup("/sign-in/anonymous", {});
    take(
      "/phone-number/send-otp (anonymous)",
      await q.call("/phone-number/send-otp", { phoneNumber: "+14155550103" }),
    );
    take(
      "/phone-number/verify (anonymous)",
      await q.call("/phone-number/verify", { phoneNumber: "+14155550103", code: codes.at(-1) }),
    );
    // Multi-session with a full bag: five sessions of five users in one browser.
    const m = browser();
    for (const n of [1, 2, 3, 4, 5])
      await m.setup("/password/sign-up", { email: `m${n}@example.com`, password: PASSWORD });
    const list = await m.call("/multi-session/list-device-sessions");
    take("/multi-session/list-device-sessions", list);
    const sessions = list.body as { session: { token: string } }[];
    take(
      "/multi-session/set-active",
      await m.call("/multi-session/set-active", { sessionToken: sessions[1]?.session.token }),
    );
    take(
      "/multi-session/revoke",
      await m.call("/multi-session/revoke", { sessionToken: sessions[2]?.session.token }),
    );
    // The queries of each path: the ready check of the new storage (4), the
    // route, and the shim's reads for Better Auth's shapes. The sign-up and
    // the phone verify over an anonymous session hold the two session reads
    // of onLinkAccount. Each count holds one revokedFor read per session
    // that the path checks, as every session ties (see the top).
    const exact: Record<string, number> = {
      "/sign-in/anonymous": 10,
      "sign-up over anonymous": 31,
      "/delete-anonymous-user": 13,
      "/is-username-available": 6,
      "/sign-in/username": 12,
      "/phone-number/send-otp": 12,
      "/phone-number/verify": 14,
      "/phone-number/send-otp (add)": 18,
      "/phone-number/verify (add)": 18,
      "/sign-in/phone-number": 15,
      "/phone-number/send-otp (anonymous)": 17,
      "/phone-number/verify (anonymous)": 31,
      "/multi-session/list-device-sessions": 22,
      "/multi-session/set-active": 25,
      "/multi-session/revoke": 24,
    };
    expect(counts).toEqual(
      Object.fromEntries(Object.entries(exact).map(([path, n]) => [path, [200, n]])),
    );
    expect(Math.max(...Object.values(exact))).toBeLessThanOrEqual(50);
  });
});
