import { createAuth, type MailMessage } from "@authtempo/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPostgresAdapter, createPostgresLimiter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The live check (plan 11d) on the real adapter and the owned limiter: 130
// parallel checks of one session pass exactly 120 times, and the answer turns
// false after the sign-out.

const BASE = "https://api.example.com";
let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

it("passes 120 of 130 parallel live checks of one session on Postgres, and answers false after the sign-out", async () => {
  let now = Date.now();
  const clock = { now: () => new Date(now) };
  const sent: MailMessage[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createPostgresAdapter(db.sql),
    limiter: createPostgresLimiter(db.sql, clock),
    clock,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
  });
  const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  expect(
    (await auth.handle(json("/auth/magic-link/request", { email: "ada@example.com" }))).status,
  ).toBe(200);
  const match = /token=([A-Za-z0-9_%-]+)/.exec(sent.at(-1)?.text ?? "");
  const token = decodeURIComponent(match?.[1] ?? "");
  const verify = await auth.handle(json("/auth/magic-link/verify", { token }));
  expect(verify.status).toBe(200);
  const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const minted = await auth.handle(new Request(`${BASE}/auth/token`, { headers: { cookie } }));
  expect(minted.status).toBe(200);
  const { token: jwt } = (await minted.json()) as { token: string };
  const live = () =>
    auth.handle(
      new Request(`${BASE}/auth/token/live`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
      }),
    );

  const statuses = (await Promise.all(Array.from({ length: 130 }, live))).map((r) => r.status);
  expect(statuses.filter((s) => s === 200)).toHaveLength(120);
  expect(statuses.filter((s) => s === 429)).toHaveLength(10);

  // A new window, then the sign-out ends the session behind the JWT.
  now += 61_000;
  expect((await auth.handle(json("/auth/sign-out", {}, { cookie }))).status).toBe(200);
  const after = await live();
  expect(after.status).toBe(200);
  expect(await after.json()).toEqual({ live: false });
});
