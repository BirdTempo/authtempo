import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedObserve } from "../src/observe/config.js";
import { createObserver, type Observer } from "../src/observe/observer.js";
import type { AuthEvent, ObserveConfig } from "../src/observe/port.js";
import { keyedHash } from "../src/redact.js";
import { post } from "./helpers.js";
import { FAST, pwHandle } from "./password-helpers.js";

/** Each observer that `createAuth` makes, so a test can emit into the buffer of a real Auth. */
const made = vi.hoisted(() => [] as Observer[]);
vi.mock("../src/observe/observer.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/observe/observer.js")>();
  return {
    ...real,
    createObserver: (...args: Parameters<typeof real.createObserver>) => {
      const observer = real.createObserver(...args);
      made.push(observer);
      return observer;
    },
  };
});

const SECRET = "0123456789abcdef0123456789abcdef";
const SCOPE = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: null,
  route: "POST /magic-link/request",
  ip: "203.0.113.7",
  userAgent: "Mozilla/5.0",
};

function fakeClock() {
  let current = new Date("2026-01-01T00:00:00.000Z");
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

function recording() {
  const batches: AuthEvent[][] = [];
  return {
    batches,
    sink: { write: (batch: readonly AuthEvent[]) => void batches.push([...batch]) },
  };
}

function observer(sink: ResolvedObserve["sink"], options: Partial<ResolvedObserve> = {}) {
  const clock = fakeClock();
  const config: ResolvedObserve = {
    sink,
    include: { ip: "none", userAgent: "none", email: "none" },
    trustTraceparent: false,
    buffer: 1000,
    flushTimeoutMs: 2000,
    readiness: false,
    ...options,
  };
  return { clock, o: createObserver(config, { clock, hashSecret: () => SECRET }) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** The env of the review run of Review Focus 3. vitest runs in Node; core's typecheck has no Node types. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
/** The 10 % bound runs only in the review run, with the load beside it (ruling 1, point 16). */
const TIMING_RUN = env?.AUTHTEMPO_OBSERVE_TIMING === "1";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the observer (plan 12h Task 2, spec 31 items 3 and 4)", () => {
  it("emit is synchronous and never calls write", () => {
    const write = vi.fn();
    const { o } = observer({ write });
    for (let i = 0; i < 3; i++) o.emit({ name: "passkey.counter_moved" });
    expect(write).not.toHaveBeenCalled();
    expect(o.stats().buffered).toBe(3);
  });

  it("flush calls write once with the whole batch, in order", async () => {
    const { batches, sink } = recording();
    const { o, clock } = observer(sink);
    o.emit({ name: "social.token_status", provider: "google", status: 500 });
    clock.advance(1000);
    o.emit({ name: "social.token_missing", provider: "google" });
    clock.advance(1000);
    o.emit({ name: "passkey.counter_moved" });
    await o.flush();
    expect(batches).toHaveLength(1);
    const batch = batches[0] ?? [];
    expect(batch.map((e) => e.name)).toEqual([
      "social.token_status",
      "social.token_missing",
      "passkey.counter_moved",
    ]);
    expect(batch.map((e) => e.at)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
    ]);
    expect(batch[0]).toMatchObject({ provider: "google", status: 500, level: "info" });
    expect(batch[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(batch[0]?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(o.stats().buffered).toBe(0);
  });

  it("a full buffer drops the push and counts it", () => {
    const { o } = observer({ write: () => {} }, { buffer: 10 });
    for (let i = 0; i < 12; i++) o.emit({ name: "passkey.counter_moved" });
    expect(o.stats()).toEqual({
      buffered: 10,
      dropped: { buffer_full: 2, sink_timeout: 0, sink_threw: 0 },
    });
  });

  it("a sink that never settles costs one time limit per flush", async () => {
    vi.useFakeTimers();
    const write = vi.fn(() => new Promise<void>(() => {}));
    const { o } = observer({ write }, { flushTimeoutMs: 500 });
    for (let i = 0; i < 4; i++) o.emit({ name: "passkey.counter_moved" });
    let done = false;
    const flushed = o.flush().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushed;
    expect(done).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(o.stats().dropped).toEqual({ buffer_full: 0, sink_timeout: 4, sink_threw: 0 });
  });

  it("a sink that throws or rejects is counted, and its text is not logged", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    let call = 0;
    const { o } = observer({
      write: () => {
        call += 1;
        if (call === 1) throw new Error("secret-text");
        return Promise.reject(new Error("secret-text"));
      },
    });
    for (let i = 0; i < 2; i++) o.emit({ name: "passkey.counter_moved" });
    await o.flush();
    for (let i = 0; i < 3; i++) o.emit({ name: "passkey.counter_moved" });
    await o.flush();
    expect(call).toBe(2);
    expect(o.stats().dropped).toEqual({ buffer_full: 0, sink_timeout: 0, sink_threw: 5 });
    for (const spy of spies)
      for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toContain("secret-text");
  });

  it("reports the drops at the head of the next batch, once", async () => {
    vi.useFakeTimers();
    let mode: "full" | "hang" | "throw" | "good" = "hang";
    const batches: AuthEvent[][] = [];
    const { o } = observer(
      {
        write: (batch) => {
          if (mode === "hang") return new Promise<void>(() => {});
          if (mode === "throw") throw new Error("down");
          batches.push([...batch]);
        },
      },
      { buffer: 10, flushTimeoutMs: 100 },
    );
    // A real full buffer: 12 pushes into 10 places, then a flush that times out.
    for (let i = 0; i < 12; i++) o.emit({ name: "passkey.counter_moved" });
    const hung = o.flush();
    await vi.advanceTimersByTimeAsync(100);
    await hung;
    mode = "throw";
    for (let i = 0; i < 3; i++) o.emit({ name: "passkey.counter_moved" });
    await o.flush();
    expect(o.stats().dropped).toEqual({ buffer_full: 2, sink_timeout: 10, sink_threw: 3 });
    mode = "good";
    o.emit({ name: "social.token_missing", provider: "google" });
    await o.flush();
    expect(batches).toHaveLength(1);
    const [head, event] = batches[0] ?? [];
    expect(batches[0]).toHaveLength(2);
    expect(head).toMatchObject({
      name: "observe.dropped",
      level: "warn",
      buffer_full: 2,
      sink_timeout: 10,
      sink_threw: 3,
    });
    expect(event?.name).toBe("social.token_missing");
    expect(o.stats().dropped).toEqual({ buffer_full: 0, sink_timeout: 0, sink_threw: 0 });
    o.emit({ name: "passkey.counter_moved" });
    await o.flush();
    expect(batches[1]?.map((e) => e.name)).toEqual(["passkey.counter_moved"]);
  });

  it("two flushes at once send each event once", async () => {
    const { batches, sink } = recording();
    const { o } = observer(sink);
    for (let i = 0; i < 5; i++) o.emit({ name: "social.token_status", provider: "p", status: i });
    const first = o.flush();
    o.emit({ name: "social.token_status", provider: "p", status: 5 });
    const second = o.flush();
    await Promise.all([first, second]);
    const statuses = batches.flat().map((e) => e.status);
    expect(statuses.sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("hashes an address at the flush, and never passes the raw value to the sink", async () => {
    const { batches, sink } = recording();
    const { o } = observer(sink, { include: { ip: "hash", userAgent: "none", email: "hash" } });
    o.scope(SCOPE).emit({ name: "passkey.counter_moved", email: "ada@example.com" });
    await o.flush();
    const [event] = batches[0] ?? [];
    expect(event?.ipHash).toBe(await keyedHash(SECRET, "authtempo observe ip v1", "203.0.113.7"));
    expect(event?.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(event?.emailHash).toBe(
      await keyedHash(SECRET, "authtempo observe email v1", "ada@example.com"),
    );
    expect(event).toMatchObject({ traceId: SCOPE.traceId, route: SCOPE.route });
    const text = JSON.stringify(batches);
    expect(text).not.toContain("203.0.113.7");
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain("Mozilla");
  });

  it("writes no address with the default include", async () => {
    const { batches, sink } = recording();
    const { o } = observer(sink);
    o.scope(SCOPE).emit({ name: "passkey.counter_moved", email: "ada@example.com" });
    await o.flush();
    const [event] = batches[0] ?? [];
    expect(event?.name).toBe("passkey.counter_moved");
    for (const key of ["ip", "ipHash", "userAgent", "email", "emailHash"])
      expect(event ?? {}).not.toHaveProperty(key);
    expect(JSON.stringify(batches)).not.toContain("203.0.113.7");
  });

  it(
    "a sink that never settles does not slow a sign-in, and the buffer holds its bound",
    async () => {
      const EMAIL = "ada@example.com";
      const PW = "correct horse battery";
      const signIns = TIMING_RUN ? 5000 : 500;
      const flushTimeoutMs = 100;
      /** The time of each sign-in after a warm-up of 20, and the most events that the buffer held. */
      async function run(observe: ObserveConfig | null) {
        made.length = 0;
        const h = pwHandle({ hash: FAST }, observe ? { observe } : {});
        const signUp = await h.auth.handle(
          post("/auth/password/sign-up", { email: EMAIL, password: PW }),
        );
        expect(signUp.status).toBe(200);
        // pwHandle resolves the config twice: the observer of the Auth is the first one.
        const inner = observe ? made[0] : undefined;
        const times: number[] = [];
        let most = 0;
        let emitted = 0;
        const flushes: Promise<void>[] = [];
        for (let i = 0; i < 20 + signIns; i++) {
          // The limits of the sign-in count per window: each sign-in starts a new one.
          h.clock.advance(60 * 60 * 1000);
          if (inner) {
            // The events of a sign-in, and once in 50 a burst past the bound. They are in
            // the buffer while the sign-in runs, so a sign-in that awaits a flush waits for them.
            const count = i % 50 === 0 ? 150 : 3;
            for (let n = 0; n < count; n++) inner.emit({ name: "passkey.counter_moved" });
            emitted += count;
            most = Math.max(most, h.auth.observe.stats().buffered);
          }
          const start = performance.now();
          const res = await h.auth.handle(
            post("/auth/password/sign-in", { email: EMAIL, password: PW }),
          );
          const took = performance.now() - start;
          expect(res.status).toBe(200);
          if (i >= 20) times.push(took);
          if (inner) flushes.push(h.auth.observe.flush());
        }
        return { times, most, emitted, flushes, auth: h.auth };
      }
      const observed = await run({
        sink: { write: () => new Promise<void>(() => {}) },
        buffer: 100,
        flushTimeoutMs,
      });
      expect(observed.most).toBe(100);
      // A flush waits at most its time limit, so a sign-in that awaits one takes it at least.
      expect(median(observed.times)).toBeLessThan(flushTimeoutMs);
      // Each flush ends at its time limit, and each lost event is counted.
      await Promise.all(observed.flushes);
      const { dropped, buffered } = observed.auth.observe.stats();
      expect(buffered).toBe(0);
      expect(dropped.buffer_full + dropped.sink_timeout + dropped.sink_threw).toBe(
        observed.emitted,
      );
      expect(dropped.sink_threw).toBe(0);
      if (TIMING_RUN) {
        const plain = await run(null);
        expect(median(observed.times)).toBeLessThanOrEqual(median(plain.times) * 1.1);
      }
    },
    TIMING_RUN ? 1_200_000 : 120_000,
  );
});
