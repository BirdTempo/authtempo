import { describe, expect, it } from "vitest";
import { type AuthConfig, ConfigError, resolveConfig } from "../src/config.js";
import { createSession, renewedSessionCookie, resolveSession } from "../src/engine/sessions.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { TEST_SECRET } from "../src/testing/soft-authenticator.js";

const DAY = 86_400_000;

type SessionInput = NonNullable<AuthConfig["session"]>;

function world(session: SessionInput) {
  let now = new Date("2026-10-14T00:00:00.000Z");
  const storage = createMemoryAdapter();
  const ended: string[] = [];
  const make = (s: SessionInput) => {
    const input: AuthConfig = {
      baseURL: "https://api.example.com",
      secret: TEST_SECRET,
      trustedOrigins: [],
      storage,
      mail: { send: async () => {} },
      clock: { now: () => now },
      session: s,
      hooks: {
        session: {
          afterEnd: ({ reason }) => {
            ended.push(reason);
          },
        },
      },
    };
    return resolveConfig(input);
  };
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { storage, ended, make, advance, config: make(session), now: () => now };
}

async function user(storage: ReturnType<typeof createMemoryAdapter>) {
  const at = new Date("2026-10-14T00:00:00.000Z");
  await storage.create("user", {
    id: "u1",
    email: "a@example.com",
    emailVerified: true,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    username: null,
    displayUsername: null,
    phone: null,
    isAnonymous: false,
    createdAt: at,
    updatedAt: at,
  });
}

describe("session.absoluteDays (plan 12b, ASVS 5.0.0 7.3.2)", () => {
  it("is off by default and refuses a value outside 1 to 365 and an unknown session key", () => {
    expect(world({}).config.session.absoluteDays).toBeNull();
    // A string and an unknown key are what a JavaScript caller can pass, so
    // these two values leave the type on purpose.
    for (const absoluteDays of [0, 366, 1.5, "3" as unknown as number])
      expect(() => world({ absoluteDays })).toThrow(
        new ConfigError("session.absoluteDays must be an integer from 1 to 365"),
      );
    expect(() => world({ idleDays: 3 } as SessionInput)).toThrow(
      new ConfigError(
        "session.idleDays is not an option; core has ttlDays, slidingRefreshDays, absoluteDays, freshMinutes, and deferRefresh",
      ),
    );
  });

  it("caps the expiry at create", async () => {
    const w = world({ ttlDays: 30, absoluteDays: 3 });
    await user(w.storage);
    const { session } = await createSession(w.config, { userId: "u1", ip: null, userAgent: null });
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(3 * DAY);
  });

  it("caps the sliding refresh at createdAt plus absoluteDays", async () => {
    const w = world({ ttlDays: 30, slidingRefreshDays: 1, absoluteDays: 10 });
    await user(w.storage);
    const { token, session } = await createSession(w.config, {
      userId: "u1",
      ip: null,
      userAgent: null,
    });
    w.advance(9 * DAY);
    const r = await resolveSession(w.config, token);
    expect(r?.refreshed).toBe(true);
    expect(r?.session.expiresAt.getTime()).toBe(session.createdAt.getTime() + 10 * DAY);
  });

  it("ends a session at the cap with reason expired, also when its expiresAt is later", async () => {
    const w = world({ ttlDays: 30 });
    await user(w.storage);
    // A row from before the key: its expiry is 30 days out.
    const { token } = await createSession(w.config, { userId: "u1", ip: null, userAgent: null });
    w.advance(6 * DAY);
    const capped = w.make({ ttlDays: 30, absoluteDays: 5 });
    expect(await resolveSession(capped, token)).toBeNull();
    expect(await w.storage.findMany("session", [])).toEqual([]);
    expect(w.ended).toEqual(["expired"]);
  });

  it("renews the cookie with a Max-Age that never passes the cap", async () => {
    const w = world({ ttlDays: 30, slidingRefreshDays: 1, absoluteDays: 10 });
    await user(w.storage);
    const { token } = await createSession(w.config, { userId: "u1", ip: null, userAgent: null });
    w.advance(9 * DAY);
    const r = await resolveSession(w.config, token);
    if (!r) throw new Error("no session");
    const request = new Request("https://api.example.com/auth/session", {
      headers: { cookie: `__Host-tempo_session=${token}` },
    });
    expect(renewedSessionCookie(w.config, request, r)).toContain(`Max-Age=${DAY / 1000}`);
  });
});
