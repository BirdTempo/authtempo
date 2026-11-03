import { fork } from "node:child_process";
import { statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { bodyCapOf } from "@authtempo/core/compat";
import { afterEach, describe, expect, it } from "vitest";
import readme from "../README.md?raw";
import { type NodeRequestLike, toNodeHandler } from "../src/node.js";
import { sso } from "../src/sso.js";
import { BASE, memory, ssoApp } from "./sso-helpers.js";

/**
 * The shim's own Node mount over real sockets (M-1 of the plan 12n review).
 * Before the fix, the mount read every body byte into memory before the
 * shim ran, and a dropped body ended the process. Each server here counts
 * the bytes that the mount pulls from node:http. The form of the measures
 * is that of rr-bodycap56 of plan 12j: the first answer line, its time
 * after the last write of the client, and the bytes pulled.
 */

const KIB = 1024;
const MIB = 1024 * KIB;
/** Core's floor, the cap of a read with no route above it. */
const FLOOR = bodyCapOf(undefined);
const pathOf = (relative: string) =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);

/** The bytes that the mount pulled from the request stream, chunk by chunk. */
interface Pulled {
  bytes: number;
  chunks: number[];
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

/** A node:http server on a free port with the shim's mount, which counts each byte it pulls. */
async function serve(
  handle: (request: Request) => Promise<Response>,
): Promise<{ port: number; pulled: Pulled }> {
  const pulled: Pulled = { bytes: 0, chunks: [] };
  const mount = toNodeHandler(handle);
  const server = http.createServer((req, res) => {
    const counted: NodeRequestLike = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      async *[Symbol.asyncIterator]() {
        for await (const chunk of req as AsyncIterable<Uint8Array>) {
          pulled.bytes += chunk.length;
          pulled.chunks.push(chunk.length);
          yield chunk;
        }
      },
    };
    void mount(counted, res);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, pulled };
}

/** The answer of one raw request: its first line, the time after the last write, and the close. */
interface Answer {
  first: string | null;
  ms: number | null;
  closed: boolean;
}

/**
 * A POST over a raw socket: the head, then `send` bytes at once. With
 * `chunked`, the body goes as chunks of 64 KiB and the head declares no
 * length. With `dropAfterMs`, the client closes the socket that long after
 * the body, with no answer read. The answer resolves at the first answer
 * line, at the close, or after `waitMs`.
 */
async function post(
  port: number,
  path: string,
  o: { declared?: number; send: number; chunked?: boolean; dropAfterMs?: number; waitMs: number },
): Promise<Answer> {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  // A server that ended refuses the connection: the socket closes with no connect.
  const connected = await new Promise<boolean>((r) => {
    socket.once("connect", () => r(true));
    socket.once("close", () => r(false));
  });
  if (!connected) return { first: null, ms: null, closed: true };
  const head = [
    `POST ${path} HTTP/1.1`,
    "Host: api.example.com",
    "X-Forwarded-Proto: https",
    `Origin: ${BASE}`,
    "Content-Type: application/json",
    o.chunked ? "Transfer-Encoding: chunked" : `Content-Length: ${o.declared ?? o.send}`,
  ];
  socket.write(`${head.join("\r\n")}\r\n\r\n`);
  const block = Buffer.alloc(64 * KIB, 0x20);
  for (let at = 0; at < o.send; at += block.length) {
    const part = block.subarray(0, Math.min(block.length, o.send - at));
    socket.write(
      o.chunked
        ? Buffer.concat([Buffer.from(`${part.length.toString(16)}\r\n`), part, Buffer.from("\r\n")])
        : part,
    );
  }
  if (o.dropAfterMs !== undefined) setTimeout(() => socket.destroy(), o.dropAfterMs);
  const sentAt = performance.now();
  return await new Promise<Answer>((resolve) => {
    let text = "";
    const done = (closed: boolean) => {
      clearTimeout(timer);
      const first = text.length > 0 ? (text.split("\r\n")[0] ?? null) : null;
      resolve({
        first,
        ms: first === null ? null : Math.round(performance.now() - sentAt),
        closed,
      });
      socket.destroy();
    };
    const timer = setTimeout(() => done(false), o.waitMs);
    socket.on("data", (c: Buffer) => {
      text += c.toString("latin1");
      if (text.includes("\r\n")) done(false);
    });
    socket.on("close", () => done(true));
  });
}

/** The compat app with the SSO plugin on memory storage, as a bare handler. */
function compatHandler() {
  const { auth } = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
  return (request: Request) => auth.handler(request);
}

describe("the shim's Node mount over real sockets (M-1 of the plan 12n review)", () => {
  it("answers 401 within a second to an anonymous register that declares 8 MiB, sends 64 KiB, and stalls, with no body byte pulled", async () => {
    const { port, pulled } = await serve(compatHandler());
    const answer = await post(port, "/api/auth/sso/register", {
      declared: 8 * MIB,
      send: 64 * KIB,
      waitMs: 1000,
    });
    console.log(
      `node-mount: register, 8 MiB declared, 65536 bytes sent, stall: ${answer.first} at ${answer.ms} ms, pulled ${pulled.bytes} bytes`,
    );
    expect({ first: answer.first, pulled: pulled.bytes }).toEqual({
      first: "HTTP/1.1 401 Unauthorized",
      pulled: 0,
    });
    expect(answer.ms).toBeLessThan(1000);
  });

  // Each post waits up to 3 s for its answer, so the test takes the long limit.
  it("buffers no 16 MiB anonymous body: the register pulls no byte, and a read at the floor stops there", {
    timeout: 20_000,
  }, async () => {
    const { port, pulled } = await serve(compatHandler());
    const register = await post(port, "/api/auth/sso/register", {
      send: 16 * MIB,
      waitMs: 3000,
    });
    const registerPulled = pulled.bytes;
    // No declared length: core reads up to its floor and stops at the chunk
    // that passes it. A clone of the request can pull one chunk more. The
    // run of 2026-11-03 pulled 131072 bytes in 4 chunks for the 16 MiB.
    const signUp = await post(port, "/api/auth/password/sign-up", {
      send: 16 * MIB,
      chunked: true,
      waitMs: 3000,
    });
    /** The index of the chunk at which the bytes pulled pass the floor. */
    const crossed = pulled.chunks.findIndex(
      (_, i) => pulled.chunks.slice(0, i + 1).reduce((a, b) => a + b, 0) > FLOOR,
    );
    console.log(
      `node-mount: 16 MiB at once: register ${register.first} at ${register.ms} ms, pulled ${registerPulled}; sign-up chunked ${signUp.first} at ${signUp.ms} ms, pulled ${pulled.bytes - registerPulled} in chunks ${JSON.stringify(pulled.chunks)}`,
    );
    expect({ register: register.first, registerPulled }).toEqual({
      register: "HTTP/1.1 401 Unauthorized",
      registerPulled: 0,
    });
    expect(signUp.first).toBe("HTTP/1.1 413 Payload Too Large");
    expect(crossed).toBeGreaterThanOrEqual(0);
    expect(pulled.chunks.length - 1 - crossed).toBeLessThanOrEqual(1);
  });

  it("closes the socket of a handler that throws, with no answer, and serves the next request", async () => {
    const { port } = await serve(async (request) => {
      if (new URL(request.url).pathname === "/throw") throw new Error("the handler failed");
      return new Response("ok");
    });
    const failed = await post(port, "/throw", { send: 10, waitMs: 2000 });
    expect(failed).toEqual({ first: null, ms: null, closed: true });
    const next = await post(port, "/next", { send: 10, waitMs: 2000 });
    expect(next.first).toBe("HTTP/1.1 200 OK");
  });
});

describe("a dropped body on the shim's Node mount in a child process (M-1 of the plan 12n review)", () => {
  const SRC = pathOf("../src/");
  const DIST = pathOf("../dist/");

  it("reads the build of the mount that is newer than its source files", () => {
    const stale = ["node", "next-js"].filter(
      (f) => statSync(`${DIST}${f}.js`).mtimeMs < statSync(`${SRC}${f}.ts`).mtimeMs,
    );
    expect(stale).toEqual([]);
  });

  it("closes the socket of a client that drops its body after the head, and the server stays up", async () => {
    const child = fork(pathOf("./fixtures/node-mount-child.mjs"), [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    /** The answer of the child to one IPC message: its port, or its count of open sockets. -1 when it ended. */
    const ask = (message?: string) =>
      new Promise<number>((resolve) => {
        if (child.exitCode !== null) return resolve(-1);
        child.once("message", (n) => resolve(Number(n)));
        child.once("exit", () => resolve(-1));
        if (message !== undefined) child.send(message);
      });
    try {
      const port = await ask();
      // The head declares 10 bytes. The client sends 3, and closes the socket 200 ms later.
      const dropped = await post(port, "/drop", {
        declared: 10,
        send: 3,
        dropAfterMs: 200,
        waitMs: 2000,
      });
      await new Promise((r) => setTimeout(r, 200));
      const open = await ask("connections");
      const whole = await post(port, "/whole", { send: 10, waitMs: 2000 });
      expect({ dropped, open, exitCode: child.exitCode, whole: whole.first, stderr }).toEqual({
        dropped: { first: null, ms: null, closed: true },
        open: 0,
        exitCode: null,
        whole: "HTTP/1.1 200 OK",
        stderr: "",
      });
    } finally {
      child.kill();
    }
  });
});

describe("the README of the Node mount (M-1 of the plan 12n review)", () => {
  it("says twice that the body streams to core and the cap of each route bounds the read", () => {
    const words =
      "`toNodeHandler` gives core the request body as a stream, so the cap of each route bounds the bytes that the route reads.";
    expect(readme.replace(/\s+/g, " ").split(words).length - 1).toBe(2);
  });
});
