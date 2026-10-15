import { type ChildProcess, spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Elysia is made for Bun, and Bun builds request.url from the Host header.
// So this test runs the app on Bun 1.4.3's own server and sends raw request lines.
const BUN = fileURLToPath(new URL("../node_modules/.bin/bun", import.meta.url));
const SERVE = fileURLToPath(new URL("./serve.ts", import.meta.url));

/** Port 8800, or the next free one. */
async function freePort(from = 8800): Promise<number> {
  for (let port = from; port < from + 100; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port from 8800");
}

let bun: ChildProcess | undefined;
let port = 0;
let events: { event: string; text: string }[] = [];
let synced: (() => void) | undefined;

/** One raw request line with a Host header. The status and the Location of the answer. */
function send(target: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; location: string | null }>((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () =>
      s.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
    );
    let data = "";
    s.on("data", (chunk) => {
      data += chunk;
    });
    s.on("error", reject);
    s.on("end", () => {
      const head = data.split("\r\n\r\n")[0] ?? "";
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
      const location = /\r\nlocation: ([^\r\n]*)/i.exec(head)?.[1] ?? null;
      resolve({ status, location });
    });
  });
}

describe("the Elysia example on Bun (plan 11d2)", () => {
  beforeAll(async () => {
    port = await freePort();
    const child = spawn(BUN, [SERVE, String(port)], { stdio: ["ignore", "pipe", "inherit"] });
    bun = child;
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      child.once("exit", (code) => reject(new Error(`bun exited with ${code}`)));
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const e = JSON.parse(line) as { event: string; text: string };
          if (e.event === "ready") resolve();
          else if (e.event === "sync") synced?.();
          else events.push(e);
        }
      });
    });
  }, 30_000);

  afterAll(() => {
    bun?.kill();
  });

  /** The answer and every event of one request: the events up to the "sync" line. */
  async function run(target: string, host?: string) {
    events = [];
    const res = await send(target, host);
    const sync = new Promise<void>((resolve) => {
      synced = resolve;
    });
    await send("/__sync");
    await sync;
    const own = events.filter((e) => e.text !== "/__sync");
    return {
      ...res,
      pages: own.filter((e) => e.event === "page"),
      rule: own.filter((e) => e.event === "rule"),
    };
  }

  it("sends a person with no session on /account to the sign-in page, and runs no page", async () => {
    const r = await run("/account");
    expect(r.status).toBe(307);
    expect(r.location).toBe(`http://127.0.0.1:${port}/sign-in?next=%2Faccount`);
    expect(r.pages).toEqual([]);
  });

  it.each([
    ["/%61ccount", 404],
    ["/ACCOUNT", 404],
    ["/account/", 307],
    // Elysia removes one trailing slash only.
    ["/account//", 404],
    // Bun and the URL parser resolve dot segments before the router: "/account/." is "/account/".
    ["/account/.", 307],
    ["/account/..", 404],
    ["/auth/../account", 307],
  ])(
    "answers %s with no cookie under an exact rule with %i, and runs no page",
    async (target, status) => {
      const r = await run(target);
      expect(r.status).toBe(status);
      expect(r.pages).toEqual([]);
    },
  );

  it("answers /%61uth/session with 404, and the rule gets no text", async () => {
    const r = await run("/%61uth/session");
    expect(r.status).toBe(404);
    expect(r.pages).toEqual([]);
    expect(r.rule).toEqual([]);
  });

  it("gives no 500 for a Host header that does not parse: the origin of BASE_URL", async () => {
    const page = await run("/account", "a b");
    expect(page.status).toBe(307);
    expect(page.location).toBe(`http://127.0.0.1:${port}/sign-in?next=%2Faccount`);
    expect((await run("/auth/session", "a b")).status).toBe(401);
  });

  it("takes the origin of the redirect from Host, not from an absolute-form request line", async () => {
    const r = await run("http://evil.example/account");
    expect(r.status).toBe(307);
    expect(r.location).toBe(`http://127.0.0.1:${port}/sign-in?next=%2Faccount`);
  });
});
