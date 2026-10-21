import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/create-auth.js";
import type { Observer } from "../src/observe/observer.js";
import type { AuthEvent } from "../src/observe/port.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { APP_ORIGIN, BASE_URL, post } from "./helpers.js";

/**
 * The two node:fs calls of the walk. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck.
 */
interface WalkFs {
  readdirSync(
    dir: URL,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

/** Each observer that `createAuth` makes, so a test can put an event in the buffer of a real Auth. */
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

const SRC = new URL("../src/", import.meta.url);
/** The two files that may name the flush: the observer that has it, and the Auth that hands it out. */
const ALLOWED = new Set(["observe/observer.ts", "create-auth.ts"]);
/** An `await` of a flush, as `await config.observe.flush()`. */
const AWAIT_FLUSH = /await\s+[\w.?]*\.flush\(/g;

async function sources(): Promise<Map<string, string>> {
  const fs: WalkFs = await import(/* @vite-ignore */ FS_MODULE);
  const files = new Map<string, string>();
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(new URL(dir, SRC), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) visit(`${path}/`);
      else if (entry.name.endsWith(".ts"))
        files.set(path, fs.readFileSync(new URL(path, SRC), "utf8"));
    }
  };
  visit("");
  return files;
}

describe("no flow waits for a sink (plan 12h Task 2, Global Constraints)", () => {
  it("no flow and no router awaits the flush", async () => {
    const files = await sources();
    // A walk that reads no file finds no await: the router and the Auth must be in it.
    expect(files.has("http/router.ts")).toBe(true);
    const named = [...files].filter(([, text]) => text.includes(".flush(")).map(([path]) => path);
    expect(named.filter((path) => !ALLOWED.has(path))).toEqual([]);
    const auth = files.get("create-auth.ts") ?? "";
    const awaits = [...auth.matchAll(AWAIT_FLUSH)];
    expect(awaits).toHaveLength(1);
    // The one await is inside the sweep of `api`, which has no answer to wait for.
    const sweep = auth.indexOf("async sweepExpired(");
    expect(sweep).toBeGreaterThan(-1);
    const end = auth.indexOf("\n      },", sweep);
    const at = awaits[0]?.index ?? -1;
    expect(at > sweep && at < end).toBe(true);
  });

  it("handle passes the flush to waitUntil before it answers", async () => {
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      observe: { sink: { write: () => {} } },
    });
    const request = () => post("/auth/magic-link/request", { email: "ada@example.com" });
    const waitUntil = vi.fn();
    const withHook = await auth.handle(request(), { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
    const plain = await auth.handle(request());
    expect(withHook.status).toBe(200);
    expect(plain.status).toBe(withHook.status);
    expect(await plain.json()).toEqual(await withHook.json());
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("handle answers while the sink has not settled", async () => {
    let release = () => {};
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    made.length = 0;
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      observe: { sink: { write }, flushTimeoutMs: 10_000 },
    });
    expect(made).toHaveLength(1);
    made[0]?.emit({ name: "passkey.counter_moved" });
    expect(auth.observe.stats().buffered).toBe(1);
    const hooked: Promise<unknown>[] = [];
    const answered = auth.handle(post("/auth/magic-link/request", { email: "ada@example.com" }), {
      waitUntil: (p) => void hooked.push(p),
    });
    // A handle that waits for the flush waits for this sink: 10 s, far past the bound.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), 1000);
    });
    const first = await Promise.race([answered.then(() => "answered" as const), late]);
    clearTimeout(timer);
    expect(first).toBe("answered");
    expect((await answered).status).toBe(200);
    expect(hooked).toHaveLength(1);
    release();
    await Promise.all(hooked);
    expect(write).toHaveBeenCalledTimes(1);
    expect(auth.observe.stats()).toEqual({
      buffered: 0,
      dropped: { buffer_full: 0, sink_timeout: 0, sink_threw: 0 },
    });
  });

  it("keeps the answer when an unbound ctx.waitUntil throws, and the sink gets one fault event", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const batches: AuthEvent[][] = [];
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      observe: { sink: { write: (batch) => void batches.push([...batch]) } },
    });
    /** A host context whose method throws when it is called with no receiver, as on Workers. */
    class Context {
      waitUntil(promise: Promise<unknown>): void {
        if (!(this instanceof Context)) throw new TypeError("Illegal invocation");
        void promise;
      }
    }
    const ctx = new Context();
    const request = post("/auth/magic-link/request", { email: "ada@example.com" });
    const res = await auth.handle(request, { waitUntil: ctx.waitUntil });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    // With a sink, core writes no console line (deviation 7 of plan 12h): the event goes to the sink.
    expect(error).not.toHaveBeenCalled();
    await auth.observe.flush();
    const faults = batches.flat().filter((e) => e.name === "observe.wait_until_threw");
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ level: "error", errorName: "TypeError" });
    error.mockRestore();
  });
});
