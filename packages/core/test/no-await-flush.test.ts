import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/create-auth.js";
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
});
