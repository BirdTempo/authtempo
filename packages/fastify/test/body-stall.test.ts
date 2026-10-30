import type { AddressInfo } from "node:net";
import net from "node:net";
import { createAuth, createMemoryAdapter } from "@authtempo/core";
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
      for (const e of ends) {
        expect(e.first).toBe("HTTP/1.1 408 Request Timeout");
        expect(e.afterMs).toBeGreaterThanOrEqual(IDLE_MS - 500);
        expect(e.afterMs).toBeLessThan(IDLE_MS + 2_000);
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
