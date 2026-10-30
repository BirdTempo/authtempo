import type { AddressInfo } from "node:net";
import net from "node:net";
import {
  createAuth,
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  type LimiterPort,
} from "@authtempo/core";
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

/** An app of core with SAML and the password sign-up on, on a real port, with `limiter` when given. */
async function startApp(limiter?: LimiterPort) {
  const auth = createAuth({
    baseURL: "http://localhost",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    organizations: {},
    sso: { saml: true, dns: [{ name: "a", txt: async () => [] }] },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    ...(limiter === undefined ? {} : { limiter }),
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
  /**
   * The status line of the answer and its JSON body, the status line of a
   * redirect, "closed", or null while none of them came.
   */
  const answer = () => {
    const raw = st.raw ?? "";
    const status = raw.split("\r\n")[0] ?? "";
    const json = /\{[^}]*\}/.exec(raw)?.[0];
    if (json !== undefined) return `${status} ${json}`;
    if (raw.includes("\r\n\r\n") && / 3\d\d /.test(status)) return status;
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

describe("a large read that cannot start through the Fastify binding (ruling 72 Minor 1 of the 12j lane)", () => {
  it("answers 503 to seven retries of another account while one holds the user half, and no 429", {
    timeout: 60_000,
  }, async () => {
    const { port, close } = await startApp();
    let held: ReturnType<typeof rawPost> | undefined;
    try {
      const holder = await signedIn(port, "hold@probe.example", "203.0.113.5");
      const admin = await signedIn(port, "admin@probe.example", "203.0.113.6");
      /** A write of 4 KiB by the admin, as a browser fetch sends it: "<status> <body>". */
      const write = async () => {
        const res = await fetch(`http://127.0.0.1:${port}${SSO_WRITE}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
            cookie: admin,
            "cf-connecting-ip": "203.0.113.6",
          },
          body: `{}${" ".repeat(4094)}`,
        });
        return `${res.status} ${await res.text()}`;
      };
      // The holder sends 8 MiB less 16 bytes of a write and stalls: the user half is full.
      held = ssoPost(port, holder, "203.0.113.5", SSO_CAP - 16);
      await held.sent;
      await sleep(1000);
      expect(held.answer()).toBeNull();
      // Seven tries, one more than the large reads of an hour: each answers 503 and counts none.
      const tries: string[] = [];
      for (let i = 0; i <= LARGE_READS_PER_HOUR; i++) tries.push(await write());
      console.log(`body-stall: the admin's tries during the hold ${JSON.stringify(tries)}`);
      expect(tries).toEqual(Array(LARGE_READS_PER_HOUR + 1).fill('503 {"error":"body_busy"}'));
      expect(held.answer()).toBeNull();
      // The holder goes away: the admin's write reads, and the schema refuses the body. No 429.
      held.socket.destroy();
      let after = await write();
      for (let i = 0; i < 50 && after.startsWith("503 "); i++) {
        await sleep(100);
        after = await write();
      }
      expect(after).toBe('400 {"error":"invalid_body"}');
    } finally {
      held?.socket.destroy();
      await close();
    }
  });
});

// Ruling 75 of the 12j lane: a large read of a user that stops at a
// deadline (408) spends the rest of that user's large reads of the window.
// So a stalled account cannot start its next hold of the user half until
// the window of sso-large-read:user ends. A write that arrives whole spends
// nothing. The limiter of these apps runs on a clock that the test moves.
describe("the stall of a large read of a user through the Fastify binding (ruling 75 of the 12j lane)", () => {
  /** A memory limiter on the time of the process plus an offset that the test moves. */
  function movedLimiter() {
    let offset = 0;
    const limiter = createMemoryLimiter({ now: () => new Date(Date.now() + offset) });
    const advance = (ms: number) => {
      offset += ms;
    };
    return { limiter, advance };
  }

  /** A small SSO connection write of `cookie` from `ip`, as a browser fetch sends it: "<status> <body>". */
  const smallWrite = async (port: number, cookie: string, ip: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${SSO_WRITE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        cookie,
        "cf-connecting-ip": ip,
      },
      body: `{}${" ".repeat(4094)}`,
    });
    return `${res.status} ${await res.text()}`;
  };

  it("refuses the next large read of a user whose read ended by 408, before any byte, and reads it in the next window", {
    timeout: 60_000,
  }, async () => {
    const { limiter, advance } = movedLimiter();
    const { port, close } = await startApp(limiter);
    const posts: ReturnType<typeof rawPost>[] = [];
    try {
      const cookie = await signedIn(port, "stall@probe.example", "203.0.113.50");
      // The first large read of the hour sends 64 KiB of 8 MiB and stops: 408 at the idle limit.
      const stalled = ssoPost(port, cookie, "203.0.113.50", 65_536);
      posts.push(stalled);
      await stalled.sent;
      expect(await answered(stalled, IDLE_MS + 5_000)).toBe(
        'HTTP/1.1 408 Request Timeout {"error":"body_timeout"}',
      );
      console.log(`body-stall: the stalled write of a user answered at ${stalled.at()} ms`);
      // Five reads of the hour were left, and the stall spent them: the next write sends only
      // its head, and the answer comes with no byte read.
      const next = ssoPost(port, cookie, "203.0.113.50", 0);
      posts.push(next);
      await next.sent;
      expect(await answered(next, 5000)).toBe(
        'HTTP/1.1 429 Too Many Requests {"error":"rate_limited"}',
      );
      // In the next window of the limiter, the account reads a write again.
      advance(3600 * 1000);
      expect(await smallWrite(port, cookie, "203.0.113.50")).toBe('400 {"error":"invalid_body"}');
    } finally {
      for (const p of posts) p.socket.destroy();
      await close();
    }
  });

  it("keeps the 6 starts of a user whose small writes arrive whole at once", {
    timeout: 60_000,
  }, async () => {
    const { limiter } = movedLimiter();
    const { port, close } = await startApp(limiter);
    try {
      const cookie = await signedIn(port, "fast@probe.example", "203.0.113.51");
      const answers: string[] = [];
      for (let i = 0; i < LARGE_READS_PER_HOUR; i++)
        answers.push(await smallWrite(port, cookie, "203.0.113.51"));
      // Each of the 6 writes reads, and the schema refuses it: no write spent another's start.
      expect(answers).toEqual(Array(LARGE_READS_PER_HOUR).fill('400 {"error":"invalid_body"}'));
      // The seventh is past the limit of the hour.
      expect(await smallWrite(port, cookie, "203.0.113.51")).toBe('429 {"error":"rate_limited"}');
    } finally {
      await close();
    }
  });
});

// Ruling 75 of the 12j lane withdrew a count of the large reads of the
// whole deployment (60 per hour). With it, 10 free accounts spent the 60
// reads with small writes in seconds, and every SSO connection write of the
// deployment answered 429 until the window ended.
describe("the large reads of one account do not limit another (ruling 75 of the 12j lane)", () => {
  it("reads the SSO write of an eleventh account after ten accounts spend their large reads", {
    timeout: 60_000,
  }, async () => {
    const { port, close } = await startApp();
    try {
      /** A small SSO connection write of `cookie` from `ip`: "<status> <body>". */
      const write = async (cookie: string, ip: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${SSO_WRITE}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost",
            cookie,
            "cf-connecting-ip": ip,
          },
          body: "{}",
        });
        return `${res.status} ${await res.text()}`;
      };
      const answers: string[] = [];
      for (let i = 0; i < 10; i++) {
        const ip = `203.0.113.${20 + i}`;
        const cookie = await signedIn(port, `p${i}@probe.example`, ip);
        for (let n = 0; n < LARGE_READS_PER_HOUR; n++) answers.push(await write(cookie, ip));
      }
      // Ten accounts start 6 large reads each, 60 in all: each reads, and the schema refuses it.
      expect(answers).toEqual(
        Array(10 * LARGE_READS_PER_HOUR).fill('400 {"error":"invalid_body"}'),
      );
      // The large reads of an eleventh account are its own: its write reads at once.
      const cookie = await signedIn(port, "late@probe.example", "203.0.113.40");
      expect(await write(cookie, "203.0.113.40")).toBe('400 {"error":"invalid_body"}');
    } finally {
      await close();
    }
  });
});

/** An ACS post of 8 KB with `cf-connecting-ip: ip`, or with no such header: "302", or "<status> <body>". */
async function acsFrom(port: number, ip: string | null): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (ip !== null) headers["cf-connecting-ip"] = ip;
  const res = await fetch(`http://127.0.0.1:${port}${ACS}`, {
    method: "POST",
    redirect: "manual",
    headers,
    body: `SAMLResponse=${"QUFB".repeat(2000)}&RelayState=x`,
  });
  return res.status === 302 ? "302" : `${res.status} ${await res.text()}`;
}

/** A raw ACS post of `DECLARED` bytes that sends `SENT` and stalls, with `headers`. */
const stalledAcs = (port: number, headers: Record<string, string>) =>
  rawPost(port, ACS, {
    headers,
    type: "application/x-www-form-urlencoded",
    declared: DECLARED,
    send: SENT,
  });

/** Core's LARGE_READ_SHARE in posts of `SENT` bytes: the posts that one client key holds. */
const SHARE_POSTS = 4;

describe("the client with no IP through the Fastify binding (ruling 69 of the 12j lane)", () => {
  it("holds 8 stalled posts with no IP header to the share of one IP, and leaves the ACS open to an IP key", {
    timeout: 60_000,
  }, async () => {
    const { port, close } = await startApp();
    const posts: ReturnType<typeof rawPost>[] = [];
    try {
      for (let i = 0; i < 2 * SHARE_POSTS; i++) {
        const p = stalledAcs(port, {});
        posts.push(p);
        await p.sent;
      }
      await sleep(1500);
      const during = posts.map((p) => p.answer());
      console.log(`body-stall: 8 stalled posts with no IP header ${JSON.stringify(during)}`);
      // Under ruling 66 the client with no IP had no share: all 8 held, and the half was full.
      expect(during.filter((a) => a === null)).toHaveLength(SHARE_POSTS);
      expect(during.filter((a) => a !== null)).toEqual(
        Array(SHARE_POSTS).fill('HTTP/1.1 503 Service Unavailable {"error":"body_busy"}'),
      );
      // A client with an IP key reads its form at once; a caller with no header has no room.
      expect(await acsFrom(port, "198.51.100.9")).toBe("302");
      expect(await acsFrom(port, null)).toBe('503 {"error":"body_busy"}');
    } finally {
      for (const p of posts) p.socket.destroy();
      await close();
    }
  });

  it("gives a header text unknown and a text that is not an IP each the share of one IP, not the key of no IP", {
    timeout: 60_000,
  }, async () => {
    const { port, close } = await startApp();
    const posts: ReturnType<typeof rawPost>[] = [];
    try {
      for (const text of ["unknown", "not-an-ip"]) {
        const mine: ReturnType<typeof rawPost>[] = [];
        for (let i = 0; i <= SHARE_POSTS; i++) {
          const p = stalledAcs(port, { "cf-connecting-ip": text });
          mine.push(p);
          posts.push(p);
          await p.sent;
        }
        await sleep(1500);
        const during = mine.map((p) => p.answer());
        // The text holds the share of one IP, and its next post answers 503.
        expect(
          during.filter((a) => a === null),
          text,
        ).toHaveLength(SHARE_POSTS);
        expect(
          during.filter((a) => a !== null),
          text,
        ).toEqual(['HTTP/1.1 503 Service Unavailable {"error":"body_busy"}']);
        // A caller with no IP header is another client: it reads its form. Before ruling 69 the
        // text unknown held the share of every caller with no IP header.
        expect(await acsFrom(port, null), text).toBe("302");
        // The posts of the text close, and their reads end: the text reads a form again.
        for (const p of mine) p.socket.destroy();
        let again = await acsFrom(port, text);
        for (let i = 0; i < 50 && again !== "302"; i++) {
          await sleep(100);
          again = await acsFrom(port, text);
        }
        expect(again, text).toBe("302");
      }
    } finally {
      for (const p of posts) p.socket.destroy();
      await close();
    }
  });
});
