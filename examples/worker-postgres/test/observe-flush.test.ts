import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import type { MailMessage } from "@authtempo/core";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorker, type Env } from "../src/index";

// The same database setup as sign-in.test.ts, in a database of its own.
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

/** A context whose waitUntil is a spy. `settle` awaits each promise that the Worker gave it. */
function spyContext() {
  const held: Promise<unknown>[] = [];
  const waitUntil = vi.fn((p: Promise<unknown>) => {
    held.push(p);
    pending.push(p);
  });
  const ctx = { waitUntil, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  return { ctx, waitUntil, settle: () => Promise.all(held) };
}

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${DB}`);
  } catch (e) {
    const why = (e as { code?: string }).code ?? (e as Error).message;
    throw new Error(`this test needs Postgres at ${ADMIN_URL}: ${why}. Run: docker compose up -d`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  await applyPostgresMigrations(sql);
  await sql.end({ timeout: 5 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The drop gets 60 s under load, as in sign-in.test.ts.
afterAll(async () => {
  await Promise.all(pending);
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end({ timeout: 5 });
}, 60_000);

const json = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("the flush of the Postgres Worker (plan 12h ruling 13)", () => {
  it("passes waitUntil once to handle for GET /auth/health", async () => {
    const { ctx, waitUntil, settle } = spyContext();
    const res = await createWorker({ async send() {} }).fetch(
      new Request(`${BASE}/auth/health`),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    // One call for the flush that handle starts, and one for sql.end.
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await expect(settle()).resolves.toEqual([undefined, undefined]);
  });

  it("flushes the fault of a session read on /me in the same request", async () => {
    const sent: MailMessage[] = [];
    const app = createWorker(
      {
        async send(m) {
          sent.push(m);
        },
      },
      {
        session: {
          afterEnd() {
            throw new RangeError("the tenant store is down");
          },
        },
      },
    );
    const email = "observe-flush@example.com";
    await app.fetch(json("/auth/magic-link/request", { email }), env, spyContext().ctx);
    const link = /https:\/\/\S+/.exec(sent.at(-1)?.text ?? "")?.[0] ?? "";
    const token = new URL(link).searchParams.get("token") ?? "";
    const verify = await app.fetch(
      json("/auth/magic-link/verify", { token }),
      env,
      spyContext().ctx,
    );
    expect(verify.status).toBe(200);
    const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // The session expires, as it does when its time passes.
    const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
    try {
      const ended = await sql`UPDATE ta_session SET expires_at = now() - interval '1 minute'
        WHERE user_id = (SELECT id FROM ta_user WHERE email = ${email})`;
      expect(ended.count).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, waitUntil, settle } = spyContext();
    const me = await app.fetch(new Request(`${BASE}/me`, { headers: { cookie } }), env, ctx);
    expect(me.status).toBe(401);
    // One call for the flush of the finally block, and one for sql.end.
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await settle();
    const lines = error.mock.calls.map((args) => args[0] as { name?: string; hook?: string });
    expect(lines).toContainEqual(
      expect.objectContaining({ name: "hook.after_failed", hook: "session.afterEnd" }),
    );
  });
});
