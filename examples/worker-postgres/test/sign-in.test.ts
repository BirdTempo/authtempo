import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import type { MailMessage } from "@authtempo/core";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import worker, { createWorker, type Env } from "../src/index";

// The tsconfig has workers-types only, so type the one Node global this file reads.
const processEnv = (
  globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process.env;
const ADMIN_URL =
  processEnv.TEMPO_AUTH_PG_URL ?? "postgres://tempo:tempo@localhost:5439/tempo_auth";
const DB = `ex_${crypto.randomUUID().replaceAll("-", "")}`;
const DB_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const BASE = "https://example.test";

const env: Env = {
  HYPERDRIVE: { connectionString: DB_URL } as unknown as Hyperdrive,
  BASE_URL: BASE,
  AUTH_SECRET: "0123456789abcdef0123456789abcdef",
};
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil(p: Promise<unknown>) {
    pending.push(p);
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${DB}`);
  } catch (e) {
    // A refused connection arrives as an AggregateError with an empty message,
    // so name the error code when there is one.
    const why = (e as { code?: string }).code ?? (e as Error).message;
    throw new Error(`this test needs Postgres at ${ADMIN_URL}: ${why}. Run: docker compose up -d`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  await applyPostgresMigrations(sql);
  await sql.end({ timeout: 5 });
});

afterAll(async () => {
  await Promise.all(pending);
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

const json = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("signs a person in by magic link on Postgres and reads /me with the session cookie", async () => {
  const sent: MailMessage[] = [];
  const app = createWorker({
    async send(m) {
      sent.push(m);
    },
  });
  const ask = await app.fetch(
    json("/auth/magic-link/request", { email: "ada@example.com" }),
    env,
    ctx,
  );
  expect(await ask.json()).toEqual({ sent: true });
  const link = /https:\/\/\S+/.exec(sent.at(-1)?.text ?? "")?.[0] ?? "";
  const token = new URL(link).searchParams.get("token") ?? "";

  const verify = await app.fetch(json("/auth/magic-link/verify", { token }), env, ctx);
  expect(verify.status).toBe(200);
  const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const me = await app.fetch(new Request(`${BASE}/me`, { headers: { cookie } }), env, ctx);
  expect(await me.json()).toEqual({ email: "ada@example.com" });
});

it("answers 500 to a sign-in request until the app has a mail transport", async () => {
  const res = await worker.fetch(
    json("/auth/magic-link/request", { email: "ada@example.com" }),
    env,
    ctx,
  );
  expect(res.status).toBe(500);
});
