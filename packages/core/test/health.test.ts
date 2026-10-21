import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { READY_CACHE_MS, READY_PROBE_ID, READY_TIMEOUT_MS } from "../src/http/health.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { BASE_URL, get } from "./helpers.js";

/** A sink that keeps nothing: the readiness route needs an observe config. */
const SINK = { write: () => {} };

/** An Auth on `storage` with a clock that the test moves. */
function authOn(storage: StorageAdapter, extra: Partial<AuthConfig> = {}) {
  let current = new Date("2026-01-01T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    mail: { send: async () => {} },
    clock,
    ...extra,
  });
  return { auth, clock };
}

/** Every storage call, by method, of a memory adapter. */
function spiedStorage() {
  const storage = createMemoryAdapter();
  const calls: string[] = [];
  const spied = new Proxy(storage, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return value.apply(target, args);
      };
    },
  });
  return { storage: spied, calls };
}

const READY = { observe: { sink: SINK, readiness: true } };

describe("GET /health and GET /ready (plan 12h Task 8)", () => {
  it("answers health in every deployment with no storage read", async () => {
    const { storage, calls } = spiedStorage();
    const { auth } = authOn(storage);
    const res = await auth.handle(get("/auth/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([]);
  });

  it("answers 404 for ready with readiness off", async () => {
    for (const extra of [{}, { observe: { sink: SINK } }]) {
      const { auth } = authOn(createMemoryAdapter(), extra);
      const res = await auth.handle(get("/auth/ready"));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  it("answers ready when the store answers", async () => {
    const { storage, calls } = spiedStorage();
    const { auth } = authOn(storage, READY);
    const res = await auth.handle(get("/auth/ready"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual(["ping"]);
  });

  it("answers not_ready storage when the store throws, and names no cause", async () => {
    const storage = createMemoryAdapter();
    storage.ping = async () => {
      throw new TypeError("host db.internal:5432");
    };
    const { auth } = authOn(storage, READY);
    const res = await auth.handle(get("/auth/ready"));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "not_ready", reason: "storage" });
    const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
    for (const part of ["db.internal", "5432", "TypeError"]) {
      expect(text).not.toContain(part);
      expect(headers).not.toContain(part);
    }
  });

  it("keeps one result for 10 seconds", async () => {
    const { storage, calls } = spiedStorage();
    const { auth, clock } = authOn(storage, READY);
    expect((await auth.handle(get("/auth/ready"))).status).toBe(200);
    clock.advance(9_999);
    expect((await auth.handle(get("/auth/ready"))).status).toBe(200);
    expect(calls).toEqual(["ping"]);
    clock.advance(1);
    expect((await auth.handle(get("/auth/ready"))).status).toBe(200);
    expect(calls).toEqual(["ping", "ping"]);
    expect(READY_CACHE_MS).toBe(10_000);
  });

  it("reads one user row with no ping", async () => {
    const storage = createMemoryAdapter();
    const reads: unknown[] = [];
    const findOne = storage.findOne.bind(storage);
    // An adapter of another author may leave ping out: the port marks it optional.
    const bare: StorageAdapter = {
      ...storage,
      findOne: (async (model: string, where: unknown) => {
        reads.push([model, where]);
        return findOne(model as "user", where as never);
      }) as StorageAdapter["findOne"],
    };
    Reflect.deleteProperty(bare, "ping");
    expect(bare.ping).toBeUndefined();
    const { auth } = authOn(bare, READY);
    const res = await auth.handle(get("/auth/ready"));
    expect(res.status).toBe(200);
    expect(reads).toEqual([["user", [{ field: "id", op: "eq", value: "authtempo:ready-probe" }]]]);
    expect(READY_PROBE_ID).toBe("authtempo:ready-probe");
  });

  it("answers not_ready storage after 3 seconds when the ping never settles, and keeps that answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const storage = createMemoryAdapter();
      let pings = 0;
      storage.ping = () => {
        pings++;
        return new Promise<void>(() => {});
      };
      const { auth, clock } = authOn(storage, READY);
      let first: Response | null = null;
      void auth.handle(get("/auth/ready")).then((res) => {
        first = res;
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(first).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      const res = first as Response | null;
      expect(res?.status).toBe(503);
      expect(await res?.json()).toEqual({ error: "not_ready", reason: "storage" });
      // The next call in the 10-second window gets the same answer at once, with no wait.
      clock.advance(5_000);
      let second: Response | null = null;
      void auth.handle(get("/auth/ready")).then((r) => {
        second = r;
      });
      await vi.advanceTimersByTimeAsync(0);
      const again = second as Response | null;
      expect(again?.status).toBe(503);
      expect(await again?.json()).toEqual({ error: "not_ready", reason: "storage" });
      expect(pings).toBe(1);
      expect(READY_TIMEOUT_MS).toBe(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts on no limiter", async () => {
    const limiter = createMemoryLimiter({ now: () => new Date("2026-01-01T00:00:00.000Z") });
    const allow = vi.spyOn(limiter, "allow");
    const { auth, clock } = authOn(createMemoryAdapter(), { ...READY, limiter });
    for (let i = 0; i < 1000; i++) {
      expect((await auth.handle(get("/auth/health"))).status).toBe(200);
      expect((await auth.handle(get("/auth/ready"))).status).toBe(200);
      clock.advance(1_000);
    }
    expect(allow).not.toHaveBeenCalled();
  });
});
