import { env, runInDurableObject, SELF } from "cloudflare:test";
import { SoftAuthenticator } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { DEMO_LIMITS } from "../src/facts.js";
import type { Gate } from "../src/gate.js";
import { CREATE_ROUTES, USER_ROUTES } from "../src/limits.js";
import { createMailbox } from "../src/mailbox.js";
import {
  call,
  type Jar,
  lastCode,
  lastLink,
  mailbox,
  newSandbox,
  nextIp,
  ORIGIN,
  PASSWORD,
  rowsIn,
  SANDBOX_COOKIE,
  sameSandbox,
  sandboxId,
  signInByLink,
} from "./helpers.js";

const REFUSED = { error: "demo_limit" };

function gate() {
  return env.GATE.get(env.GATE.idFromName("gate"));
}

/** A first visit with no cookie from `ip`. */
function firstVisit(ip: string, headers: Record<string, string> = {}): Promise<Response> {
  return call({ cookies: new Map(), ip }, "GET", "/", undefined, headers);
}

/** Time passes for the gate rows of `ip` (or of each IP): their time moves back by `ms`. */
async function rowsAge(ms: number, ip?: string): Promise<void> {
  await runInDurableObject(gate(), (_instance, state) => {
    if (ip === undefined) state.storage.sql.exec("UPDATE admit SET at = at - ?", ms);
    else state.storage.sql.exec("UPDATE admit SET at = at - ? WHERE ip = ?", ms, ip);
  });
}

function gateIps(): Promise<string[]> {
  return runInDurableObject(gate(), (_instance, state) =>
    state.storage.sql
      .exec<{ ip: string }>("SELECT ip FROM admit")
      .toArray()
      .map((r) => r.ip),
  );
}

async function count(jar: Jar, table: string): Promise<number> {
  const rows = await rowsIn(jar, `SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

/** Ten users in the sandbox of `jar`, each a password sign-up of its own visitor. */
async function tenUsers(jar: Jar): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const res = await call(sameSandbox(jar), "POST", "/auth/password/sign-up", {
      email: `user${i}@example.com`,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
  }
  expect(await count(jar, "ta_user")).toBe(10);
}

/**
 * For each route that can make a user: one request through it that makes a
 * new user when no demo limit stops it. A visitor of the sandbox of `jar`
 * sends it, for the new address `email`.
 */
const USER_ROUTE_CALLS: Record<string, (jar: Jar, email: string) => Promise<Response>> = {
  "POST /password/sign-up": (jar, email) =>
    call(jar, "POST", "/auth/password/sign-up", { email, password: PASSWORD }),
  "POST /magic-link/verify": async (jar, email) => {
    expect((await call(jar, "POST", "/auth/magic-link/request", { email })).status).toBe(200);
    const token = (await lastLink(jar, email)).searchParams.get("token") ?? "";
    return call(jar, "POST", "/auth/magic-link/verify", new URLSearchParams({ token }));
  },
  "POST /otp/verify": async (jar, email) => {
    expect((await call(jar, "POST", "/auth/otp/request", { email })).status).toBe(200);
    return call(jar, "POST", "/auth/otp/verify", { email, code: await lastCode(jar, email) });
  },
  "GET /social/:provider/callback": async (jar, email) => {
    const start = await call(jar, "GET", "/auth/social/demo/start");
    const authorize = new URL(start.headers.get("location") ?? "");
    const page = `${authorize.pathname}${authorize.search}`;
    // The free address field of the pick page gives a new identity.
    const res = await call(jar, "POST", page, new URLSearchParams({ identity: "free", email }));
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location") ?? "");
    return call(jar, "GET", `${back.pathname}${back.search}`);
  },
  "POST /password/reset": async (jar, email) => {
    const sent = await call(jar, "POST", "/auth/password/reset/request", { email });
    expect(sent.status).toBe(200);
    const token = (await lastLink(jar, email)).searchParams.get("token") ?? "";
    const form = new URLSearchParams({ token, password: "new horse battery staple" });
    return call(jar, "POST", "/auth/password/reset", form);
  },
  "POST /otp/reset": async (jar, email) => {
    expect((await call(jar, "POST", "/auth/otp/reset/request", { email })).status).toBe(200);
    const code = await lastCode(jar, email);
    return call(jar, "POST", "/auth/otp/reset", { email, code, password: "a new long password" });
  },
};

/** For each create route: one request that makes one row of its table. */
const CREATE_ROUTE_CALLS = {
  "POST /passkey/register/verify": async (jar: Jar, i: number) => {
    const soft = await SoftAuthenticator.create({ rpID: "demo.authtempo.com", origin: ORIGIN });
    const options = await call(jar, "POST", "/auth/passkey/register/options", {});
    expect(options.status).toBe(200);
    const { challenge } = (await options.json()) as { challenge: string };
    return call(jar, "POST", "/auth/passkey/register/verify", {
      response: await soft.register(challenge),
      name: `Device ${i}`,
    });
  },
  "POST /tokens": (jar: Jar, i: number) =>
    call(jar, "POST", "/auth/tokens", { name: `script ${i}` }),
  "POST /organizations/create": (jar: Jar, i: number) =>
    call(jar, "POST", "/auth/organizations/create", { slug: `org-${i}`, name: `Org ${i}` }),
} as const;

const CREATE_CASES = [
  ["POST /passkey/register/verify", "ta_passkey", "passkeysPerSandbox"],
  ["POST /tokens", "ta_api_token", "tokensPerSandbox"],
  ["POST /organizations/create", "ta_organization", "organizationsPerSandbox"],
] as const;

describe("the limits of the demo", () => {
  it("admits the 5th sandbox from one IP and refuses the 6th", async () => {
    const ip = "203.0.113.7";
    expect(DEMO_LIMITS.sandboxesPerIp).toBe(5);
    for (let i = 1; i <= DEMO_LIMITS.sandboxesPerIp; i++)
      expect((await firstVisit(ip)).status, `visit ${i}`).toBe(303);
    const sixth = await firstVisit(ip);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("set-cookie")).toBeNull();
    expect(await sixth.json()).toEqual({ ...REFUSED, limit: "sandboxesPerIp" });
  });

  it("admits again after the window", async () => {
    const ip = "203.0.113.8";
    for (let i = 0; i < 5; i++) expect((await firstVisit(ip)).status).toBe(303);
    // 10 s before the end of the window the rows still count.
    await rowsAge(3_590_000, ip);
    expect((await firstVisit(ip)).status).toBe(429);
    await rowsAge(10_001, ip);
    expect((await firstVisit(ip)).status).toBe(303);
  });

  it("refuses the 11th user through each user route", async () => {
    expect(USER_ROUTES.filter((r) => !(r in USER_ROUTE_CALLS))).toEqual([]);
    for (const [route, make] of Object.entries(USER_ROUTE_CALLS)) {
      const jar = await newSandbox();
      await tenUsers(jar);
      const res = await make(sameSandbox(jar), "eleventh@example.com");
      const body = await res.text();
      expect({ route, status: res.status, body }).toEqual({
        route,
        status: 429,
        body: JSON.stringify({ ...REFUSED, limit: "usersPerSandbox" }),
      });
      expect(await count(jar, "ta_user")).toBe(10);
    }
  });

  it("refuses the 11th passkey, token, and organization", async () => {
    expect(Object.keys(CREATE_ROUTES).sort()).toEqual(CREATE_CASES.map((c) => c[0]).sort());
    for (const [route, table, limit] of CREATE_CASES) {
      const jar = await newSandbox();
      await signInByLink(jar, "ada@example.com");
      for (let i = 1; i <= 10; i++)
        expect((await CREATE_ROUTE_CALLS[route](jar, i)).status, `${route} ${i}`).toBe(200);
      expect(await count(jar, table)).toBe(10);
      const res = await CREATE_ROUTE_CALLS[route](jar, 11);
      expect({ route, status: res.status }).toEqual({ route, status: 429 });
      expect(await res.json()).toEqual({ ...REFUSED, limit });
      expect(await count(jar, table)).toBe(10);
    }
  });

  it("keeps the newest 50 mails", async () => {
    const jar = await newSandbox();
    // Core limits the mail of one flow, so the test sends through the port itself.
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(sandboxId(jar)));
    await runInDurableObject(stub, async (_instance, state) => {
      const box = createMailbox(state.storage.sql);
      for (let i = 0; i < 52; i++)
        await box.send({ to: `p${i}@example.com`, subject: "s", text: "t" });
    });
    const mail = await mailbox(jar);
    expect(mail).toHaveLength(50);
    expect(mail[0]?.to).toBe("p51@example.com");
    expect(mail[49]?.to).toBe("p2@example.com");
  });

  it("answers 413 to a body above 16 KiB, with and without content-length", async () => {
    const jar = await newSandbox();
    const cookie = `${SANDBOX_COOKIE}=${sandboxId(jar)}`;
    const send = (size: number, stream: boolean) => {
      const bytes = new Uint8Array(size).fill(0x61);
      // A stream body has no content-length, so the Worker counts the bytes it reads.
      const body = stream
        ? new ReadableStream<Uint8Array>({
            start(c) {
              for (let at = 0; at < size; at += 1000) c.enqueue(bytes.slice(at, at + 1000));
              c.close();
            },
          })
        : bytes;
      return SELF.fetch(`${ORIGIN}/auth/password/sign-up`, {
        method: "POST",
        headers: {
          cookie,
          origin: ORIGIN,
          "content-type": "application/json",
          "cf-connecting-ip": nextIp(),
        },
        body,
        redirect: "manual",
      });
    };
    for (const stream of [false, true]) {
      const over = await send(16_385, stream);
      expect({ stream, status: over.status }).toEqual({ stream, status: 413 });
      expect(await over.json()).toEqual({ error: "body_too_large" });
      // A body of the cap itself reaches core, which refuses the bad JSON with 400.
      const at = await send(16_384, stream);
      expect({ stream, status: at.status }).toEqual({ stream, status: 400 });
    }
    const lying = await SELF.fetch(`${ORIGIN}/`, {
      method: "POST",
      headers: { cookie, "content-length": "16385", "cf-connecting-ip": nextIp() },
      body: "x",
    });
    expect(lying.status).toBe(413);
  });

  it("ignores a client IP header from the visitor", async () => {
    const ips = { "cf-connecting-ip": "203.0.113.9", "x-demo-client-ip": "1.2.3.4" };
    const jar: Jar = { cookies: new Map() };
    expect((await call(jar, "GET", "/", undefined, ips)).status).toBe(303);
    const seen = await gateIps();
    expect(seen.filter((ip) => ip === "203.0.113.9")).toHaveLength(1);
    expect(seen).not.toContain("1.2.3.4");
    const sent = await call(
      jar,
      "POST",
      "/auth/magic-link/request",
      { email: "a@example.com" },
      ips,
    );
    expect(sent.status).toBe(200);
    // The limiter stores each key with U+001F and its window after it.
    const rows = await rowsIn(jar, "SELECT key FROM ta_limit WHERE key LIKE 'magic-link:ip:%'");
    const keys = rows.map((r) => String(r.key).split("\u001f")[0]);
    expect(keys).toEqual(["magic-link:ip:203.0.113.9"]);
  });

  it("answers 400 to a request with no cf-connecting-ip", async () => {
    const jar = await newSandbox();
    const cookie = `${SANDBOX_COOKIE}=${sandboxId(jar)}`;
    for (const headers of [{}, { cookie }, { cookie, "x-demo-client-ip": "1.2.3.4" }]) {
      const res = await SELF.fetch(`${ORIGIN}/`, { headers, redirect: "manual" });
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toEqual({ error: "no_client_ip" });
    }
  });

  // Last in the file: it fills the gate. The other tests of the file run before it.
  it("refuses a new sandbox above the total", async () => {
    // An hour passes for the rows of the earlier tests.
    await rowsAge(3_600_001);
    const results = await runInDurableObject(gate(), async (instance: Gate) => {
      const out: boolean[] = [];
      for (let i = 0; i < 600; i++)
        out.push((await instance.admit(`10.0.${i >> 8}.${i & 255}`, Date.now())).ok);
      return out;
    });
    expect(results.filter((ok) => ok)).toHaveLength(600);
    const next = await firstVisit("203.0.113.10");
    expect(next.status).toBe(429);
    expect(await next.json()).toEqual({ ...REFUSED, limit: "sandboxesTotal" });
    await rowsAge(3_600_001);
  });
});
