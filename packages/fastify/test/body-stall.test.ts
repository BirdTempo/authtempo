import type { AddressInfo } from "node:net";
import net from "node:net";
import { createAuth, createMemoryAdapter, createPbkdf2PasswordHash } from "@authtempo/core";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { authRoutes } from "../src/index.js";

// The stall probe of the third re-review of the body cap, over real sockets
// on Node (ruling 59 Major 1 of the 12j lane). Sixteen sockets of one client
// post 1 MiB of a SAML form each to the ACS of any connection id, with no
// cookie, and stall. Fastify 5 sets no request timeout, so before ruling 59
// the stall held the large-read budget of the process: every ACS post
// answered 503 body_busy while the sockets lived. Now the client holds only
// its share, the ACS reads the form of another client at once, and each
// stalled read ends at core's idle limit.

const ACS = "/auth/sso/01KDVDQ4K0M3BPSSWQAS1JPT17/acs";
/** The declared length of each stalled post: SAML_FORM_MAX of core, as the probe sent it. */
const DECLARED = 1_081_519;
/** The bytes that each stalled post sends before its stall. */
const SENT = 1_048_576;
/** Core's LARGE_READ_IDLE_MS: a large read with no chunk for this time ends. */
const IDLE_MS = 10_000;
const ATTACKER = "203.0.113.7";

/** One stalled post: its socket, and the first line of its answer with the time it came, or of its close. */
function stalledPost(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  let first: string | null = null;
  let endedAt = 0;
  socket.on("data", (chunk: Buffer) => {
    if (first !== null) return;
    first = chunk.toString("latin1").split("\r\n")[0] ?? "";
    endedAt = performance.now();
  });
  socket.on("close", () => {
    if (first !== null) return;
    first = "closed";
    endedAt = performance.now();
  });
  const sent = new Promise<void>((resolve) =>
    socket.once("connect", () => {
      socket.write(
        `POST ${ACS} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/x-www-form-urlencoded\r\ncf-connecting-ip: ${ATTACKER}\r\nContent-Length: ${DECLARED}\r\n\r\n`,
      );
      const chunk = Buffer.alloc(65_536, 0x61);
      for (let at = 0; at < SENT; at += chunk.length) socket.write(chunk);
      resolve();
    }),
  );
  return { socket, sent, end: () => ({ first, endedAt }) };
}

describe("a stalled client at the SAML ACS through the Fastify binding (ruling 59 of the 12j lane)", () => {
  it("holds only the share of the client, reads another client at once, and ends each stall at the idle limit", {
    timeout: 60_000,
  }, async () => {
    const auth = createAuth({
      baseURL: "http://localhost",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      organizations: {},
      sso: { saml: true, dns: [{ name: "a", txt: async () => [] }] },
    });
    const app = Fastify();
    await app.register(authRoutes({ auth }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    // The server limits of the probe: Fastify 5 ends no slow request by itself.
    expect([app.server.requestTimeout, app.server.timeout]).toEqual([0, 0]);
    /** An ACS post of 8 KB from `ip`: its status, and the error of a JSON answer. */
    const post = async (ip: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${ACS}`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
        body: `SAMLResponse=${"QUFB".repeat(2000)}&RelayState=x`,
      });
      return res.status === 302 ? "302" : `${res.status} ${await res.text()}`;
    };
    const posts: ReturnType<typeof stalledPost>[] = [];
    try {
      expect(await post("198.51.100.9")).toBe("302");
      for (let i = 0; i < 16; i++) {
        const p = stalledPost(port);
        posts.push(p);
        await p.sent;
      }
      const stalledAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const during = posts.map((p) => p.end().first);
      const held = during.filter((line) => line === null).length;
      console.log(`body-stall: during the stall ${JSON.stringify(during)}`);
      // The client holds at most its share, 4 posts of 1 MiB; core answers each other post 503.
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThanOrEqual(4);
      expect(during.filter((line) => line !== null)).toEqual(
        Array(16 - held).fill("HTTP/1.1 503 Service Unavailable"),
      );
      // Another client: the ACS reads its form at once.
      expect(await post("198.51.100.9")).toBe("302");
      // Each stalled read ends at the idle limit, and the share of the client frees.
      while (posts.some((p) => p.end().first === null) && performance.now() - stalledAt < 20_000)
        await new Promise((resolve) => setTimeout(resolve, 100));
      const ends = posts
        .map((p) => p.end())
        .filter((_e, i) => during[i] === null)
        .map((e) => ({ first: e.first, afterMs: Math.round(e.endedAt - stalledAt) }));
      console.log(`body-stall: the stalled reads ended ${JSON.stringify(ends)}`);
      // The time counts from the last write of the sixteenth post. The first posts sent their
      // last chunk a little before it, and a loaded machine fires a timer a little late.
      for (const e of ends) {
        expect(e.first).toBe("HTTP/1.1 408 Request Timeout");
        expect(e.afterMs).toBeGreaterThanOrEqual(IDLE_MS - 2_000);
        expect(e.afterMs).toBeLessThan(IDLE_MS + 3_000);
      }
      expect(await post(ATTACKER)).toBe("302");
    } finally {
      // A stalled post keeps its socket while its client lives: Fastify ends no slow request.
      for (const p of posts) p.socket.destroy();
      app.server.closeAllConnections();
      await app.close();
    }
  });
});

// The bounds of ruling 69 of the 12j lane, over real sockets. One free account
// stalled one SSO connection write of 8 MiB, held the user half of the budget
// for 64 s, and could do so 30 times in 15 minutes. Now a user runs one large
// read at a time, a read of a user ends at 256 KiB per second (32 s for the
// cap), and a user starts at most 6 large reads in an hour.

const SSO_WRITE = "/auth/sso/connections/create";
/** The cap of an SSO connection write, core's REQUEST_BODY_MAX. */
const SSO_CAP = 8_388_608;
/** Core's largeReadDeadlineMs of the cap at LARGE_READ_USER_MIN_RATE (256 KiB per second). */
const USER_DEADLINE_MS = 32_000;
/** Core's SSO_LARGE_READ_PER_USER.max: the large reads of one user in an hour. */
const LARGE_READS_PER_HOUR = 6;

/** An app of core with SAML and the password sign-up on, on a real port. */
async function startApp() {
  const auth = createAuth({
    baseURL: "http://localhost",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    organizations: {},
    sso: { saml: true, dns: [{ name: "a", txt: async () => [] }] },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
  });
  const app = Fastify();
  await app.register(authRoutes({ auth }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      app.server.closeAllConnections();
      await app.close();
    },
  };
}

/** A sign-up and a sign-in of `email` from `ip`: the session cookie. No organization, no role. */
async function signedIn(port: number, email: string, ip: string): Promise<string> {
  const headers = {
    "content-type": "application/json",
    origin: "http://localhost",
    "cf-connecting-ip": ip,
  };
  const body = JSON.stringify({ email, password: "correct horse battery staple 42" });
  await fetch(`http://127.0.0.1:${port}/auth/password/sign-up`, { method: "POST", headers, body });
  const res = await fetch(`http://127.0.0.1:${port}/auth/password/sign-in`, {
    method: "POST",
    headers,
    body,
  });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .find((c) => c.includes("tempo_session"));
  if (cookie === undefined) throw new Error(`no session: ${res.status}`);
  return cookie;
}

/**
 * A raw POST of `declared` bytes to `path` that sends `send` bytes at once.
 * Its first answer chunk and the time that it came, from the start of the post.
 */
function rawPost(
  port: number,
  path: string,
  o: { headers: Record<string, string>; type: string; declared: number; send: number },
) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  const startedAt = performance.now();
  const st: { raw: string | null; at: number; closed: boolean } = {
    raw: null,
    at: 0,
    closed: false,
  };
  socket.on("data", (chunk: Buffer) => {
    if (st.raw === null) st.at = Math.round(performance.now() - startedAt);
    st.raw = (st.raw ?? "") + chunk.toString("latin1");
  });
  socket.on("close", () => {
    st.closed = true;
    if (st.raw === null) st.at = Math.round(performance.now() - startedAt);
  });
  const head = Object.entries(o.headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join("");
  const sent = new Promise<void>((resolve) =>
    socket.once("connect", () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: ${o.type}\r\n${head}Content-Length: ${o.declared}\r\n\r\n`,
      );
      const chunk = Buffer.alloc(65_536, 0x20);
      for (let at = 0; at < o.send; at += chunk.length)
        socket.write(at + chunk.length <= o.send ? chunk : chunk.subarray(0, o.send - at));
      resolve();
    }),
  );
  /** The status line of the answer and its JSON body, "closed", or null while neither came. */
  const answer = () => {
    const json = /\{[^}]*\}/.exec(st.raw ?? "")?.[0];
    if (st.raw !== null && json !== undefined) return `${st.raw.split("\r\n")[0]} ${json}`;
    return st.closed ? "closed" : null;
  };
  return { socket, sent, answer, at: () => st.at };
}

/** An SSO connection write of the session `cookie` from `ip`, raw. */
const ssoPost = (port: number, cookie: string, ip: string, send: number) =>
  rawPost(port, SSO_WRITE, {
    headers: { cookie, origin: "http://localhost", "cf-connecting-ip": ip },
    type: "application/json",
    declared: SSO_CAP,
    send,
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `post` has an answer, at most `limitMs`. */
async function answered(post: ReturnType<typeof rawPost>, limitMs: number) {
  const started = performance.now();
  while (post.answer() === null && performance.now() - started < limitMs) await sleep(50);
  return post.answer();
}

describe("the large reads of one user through the Fastify binding (ruling 69 of the 12j lane)", () => {
  it("answers 503 body_busy to a second write of an account that holds one, before any byte", {
    timeout: 60_000,
  }, async () => {
    const { port, close } = await startApp();
    const posts: ReturnType<typeof rawPost>[] = [];
    try {
      const cookie = await signedIn(port, "x@probe.example", "203.0.113.1");
      const held = ssoPost(port, cookie, "203.0.113.1", 1_048_576);
      posts.push(held);
      await held.sent;
      await sleep(500);
      expect(held.answer()).toBeNull();
      // The same account from another IP sends only its head: the answer comes with no byte read.
      const second = ssoPost(port, cookie, "203.0.113.2", 0);
      posts.push(second);
      await second.sent;
      expect(await answered(second, 5000)).toBe(
        'HTTP/1.1 503 Service Unavailable {"error":"body_busy"}',
      );
      expect(held.answer()).toBeNull();
    } finally {
      for (const p of posts) p.socket.destroy();
      await close();
    }
  });

  it("ends a write of a user that trickles under 256 KiB per second with 408 at 32 s", {
    timeout: 60_000,
  }, async () => {
    const { port, close } = await startApp();
    let post: ReturnType<typeof rawPost> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const cookie = await signedIn(port, "y@probe.example", "203.0.113.3");
      // 48 KiB each 250 ms: 192 KiB per second. At the rate of a read before a session, 128 KiB
      // per second, the cap had 64 s, and this body ends at 43 s and reads whole.
      post = ssoPost(port, cookie, "203.0.113.3", 49_152);
      const p = post;
      await p.sent;
      const chunk = Buffer.alloc(49_152, 0x20);
      timer = setInterval(() => {
        if (p.answer() === null) p.socket.write(chunk);
      }, 250);
      const line = await answered(p, USER_DEADLINE_MS + 10_000);
      console.log(`body-stall: the trickled write of a user answered at ${p.at()} ms`);
      expect(line).toBe('HTTP/1.1 408 Request Timeout {"error":"body_timeout"}');
      expect(p.at()).toBeGreaterThanOrEqual(USER_DEADLINE_MS);
      expect(p.at()).toBeLessThan(USER_DEADLINE_MS + 4_000);
    } finally {
      clearInterval(timer);
      post?.socket.destroy();
      await close();
    }
  });

  it("answers the limit to the seventh large read of one user in an hour, before any byte", {
    timeout: 60_000,
  }, async () => {
    const { port, close } = await startApp();
    let seventh: ReturnType<typeof rawPost> | undefined;
    try {
      const cookie = await signedIn(port, "z@probe.example", "203.0.113.4");
      const write = () =>
        fetch(`http://127.0.0.1:${port}${SSO_WRITE}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
            cookie,
            "cf-connecting-ip": "203.0.113.4",
          },
          body: "{}",
        });
      for (let i = 0; i < LARGE_READS_PER_HOUR; i++) expect((await write()).status).toBe(400);
      // The seventh sends only its head: the limit answers with no byte read.
      seventh = ssoPost(port, cookie, "203.0.113.4", 0);
      await seventh.sent;
      expect(await answered(seventh, 5000)).toBe(
        'HTTP/1.1 429 Too Many Requests {"error":"rate_limited"}',
      );
    } finally {
      seventh?.socket.destroy();
      await close();
    }
  });
});
