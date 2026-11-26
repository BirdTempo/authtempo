import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import type { MailMessage } from "@authtempo/core";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";

// The Worker in workerd, the runtime of Cloudflare Workers, through the local
// form of the Hyperdrive binding. The other tests of this folder call the
// fetch handler on Node, so they never run the socket code of postgres.js
// for Workers. This test does. It does not run the Hyperdrive service: the
// local binding connects workerd to the test Postgres with no pooler.
const processEnv = (
  globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process.env;

function serverUrl(name: string): string {
  const url = processEnv[name];
  if (url === undefined || url === "")
    throw new Error(
      `${name} is not set. Run: node scripts/test-servers.mjs up (pnpm test runs it for you)`,
    );
  return url;
}
const ADMIN_URL = serverUrl("TEMPO_AUTH_PG_URL");
const DB = `ex_${crypto.randomUUID().replaceAll("-", "")}`;
const DB_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);
const BASE = "https://example.test";

let server: TestHarness;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  await applyPostgresMigrations(sql);
  await sql.end({ timeout: 5 });
  // wrangler reads the local connection string of the binding from this name.
  processEnv.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = DB_URL;
  server = createTestHarness({
    root: new URL("./workerd/", import.meta.url).pathname,
    workers: [
      {
        configPath: "./wrangler.jsonc",
        secrets: { AUTH_SECRET: "0123456789abcdef0123456789abcdef" },
      },
    ],
  });
  await server.listen();
}, 120_000);

afterAll(async () => {
  await server?.close();
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end({ timeout: 5 });
}, 60_000);

const json = (path: string, body: unknown) =>
  server.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("runs in workerd, not on Node", async () => {
  const runtime = await server.fetch(`${BASE}/__runtime`);
  expect(await runtime.json()).toEqual({ userAgent: "Cloudflare-Workers" });
});

it("signs a person in by magic link in workerd and reads /me with the session cookie", async () => {
  const ask = await json("/auth/magic-link/request", { email: "ada@example.com" });
  expect([ask.status, await ask.json()]).toEqual([200, { sent: true }]);
  const mails = (await (await server.fetch(`${BASE}/__mail`)).json()) as MailMessage[];
  const link = /https:\/\/\S+/.exec(mails.at(-1)?.text ?? "")?.[0] ?? "";
  const token = new URL(link).searchParams.get("token") ?? "";

  const verify = await json("/auth/magic-link/verify", { token });
  expect(verify.status).toBe(200);
  const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const me = await server.fetch(`${BASE}/me`, { headers: { cookie } });
  expect([me.status, await me.json()]).toEqual([200, { email: "ada@example.com" }]);

  // The rows are in the database of this test, so the Worker wrote through the binding.
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ users: number; sessions: number }[]>`
      SELECT (SELECT count(*)::int FROM ta_user) AS users,
             (SELECT count(*)::int FROM ta_session) AS sessions`;
    expect(rows[0]).toEqual({ users: 1, sessions: 1 });
  } finally {
    await sql.end({ timeout: 5 });
  }
}, 60_000);
