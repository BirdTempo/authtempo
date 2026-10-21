import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthConfig, ConfigError } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import type { ObserveConfig } from "../src/observe/port.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { APP_ORIGIN, BASE_URL, get, post, tokenFromMail } from "./helpers.js";

const sink = { write: () => {} };

function build(observe?: ObserveConfig) {
  const sent: { to: string; text: string }[] = [];
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    ...(observe ? { observe } : {}),
  };
  return { auth: createAuth(input), sent };
}

/** The error that `createAuth` throws for an observe config. */
function refusal(observe: unknown): unknown {
  try {
    build(observe as ObserveConfig);
  } catch (e) {
    return e;
  }
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the observe config (plan 12h Task 2, spec 31 item 1)", () => {
  it("refuses a sink with no write function", () => {
    for (const bad of [{}, { write: "x" }, null]) {
      const e = refusal({ sink: bad });
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe("observe.sink must have a write function");
    }
  });

  it("refuses an unknown key of the observe block by name", () => {
    for (const key of ["bufer", "readines"]) {
      const e = refusal({ sink, [key]: 10 });
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe(
        `observe.${key} is not an option; core has sink, include, trustTraceparent, buffer, flushTimeoutMs, readiness`,
      );
    }
    // A key with the value undefined is no option, as in the other blocks.
    expect(refusal({ sink, bufer: undefined })).toBeNull();
  });

  it("refuses an unknown include key and an unknown value", () => {
    const value = refusal({ sink, include: { ip: "full" } });
    expect(value).toBeInstanceOf(ConfigError);
    expect((value as Error).message).toContain("observe.include.ip");
    const key = refusal({ sink, include: { phone: "raw" } });
    expect(key).toBeInstanceOf(ConfigError);
    expect((key as Error).message).toContain("observe.include.phone");
    const agent = refusal({ sink, include: { userAgent: "hash" } });
    expect((agent as Error).message).toContain("observe.include.userAgent");
  });

  it("refuses a raw email", () => {
    const e = refusal({ sink, include: { email: "raw" } });
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toBe(
      "observe.include.email is none or hash: a raw email is never written",
    );
  });

  it("refuses a buffer and a time limit out of range", () => {
    for (const buffer of [9, 10001, 10.5]) {
      const e = refusal({ sink, buffer });
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe("observe.buffer must be an integer from 10 to 10000");
    }
    for (const flushTimeoutMs of [99, 10001]) {
      const e = refusal({ sink, flushTimeoutMs });
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toBe(
        "observe.flushTimeoutMs must be an integer from 100 to 10000",
      );
    }
    expect(refusal({ sink, buffer: 10, flushTimeoutMs: 10000 })).toBeNull();
    expect(refusal({ sink, buffer: 10000, flushTimeoutMs: 100 })).toBeNull();
  });

  it("sends nothing anywhere with no observe", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const { auth, sent } = build();
    const req = await auth.handle(
      post("/auth/magic-link/request", { email: "ada@example.com", next: "/dash" }),
    );
    expect(req.status).toBe(200);
    const verify = await auth.handle(
      post("/auth/magic-link/verify", { token: tokenFromMail(sent[0]?.text ?? "") }),
    );
    expect(verify.status).toBe(200);
    const cookie = verify.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await auth.session(get("/anything", { cookie })))?.user.email).toBe("ada@example.com");
    await auth.observe.flush();
    expect(auth.observe.stats()).toEqual({
      buffered: 0,
      dropped: { buffer_full: 0, sink_timeout: 0, sink_threw: 0 },
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
