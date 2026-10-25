import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import { createPbkdf2PasswordHash, type MailMessage } from "@authtempo/core";
import { createRecordingSms } from "@authtempo/core/testing";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import worker, { createWorker, type Env } from "../src/index";

// The tsconfig has workers-types only, so type the one Node global this file reads.
const processEnv = (
  globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process.env;

/** The address of a test server: `node scripts/test-servers.mjs up` writes it, and `pnpm test` passes it. */
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
    throw new Error(
      `this test needs Postgres at ${ADMIN_URL}: ${why}. Run: node scripts/test-servers.mjs up`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  await applyPostgresMigrations(sql);
  await sql.end({ timeout: 5 });
});

// The drop is slow while other suites create, write, and drop databases on
// the same Postgres. Measured on 2026-10-20, it took 0.03 to 0.8 s alone.
// While core, compat, and the adapters ran their tests, it took 8.3, 15.4,
// and 28.6 s (one-minute load 13 to 28). The default hook limit of 10 s
// failed the unfiltered runs, so the drop gets 60 s, about twice the worst.
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

// The phone code request and the code-mode sign-up do their store work and
// their send after the answer (ruling 23 of plan 12i). That work queries the
// per-request client, so the Worker must end the client after it, not at once.
it("sends the phone code and the sign-up code after the answer on the per-request client", async () => {
  const sms = createRecordingSms();
  const sent: MailMessage[] = [];
  const app = createWorker(
    {
      async send(m) {
        sent.push(m);
      },
    },
    undefined,
    () => ({
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), verifyBy: "code" },
      phone: { sms, regions: ["+1"], signUp: true },
    }),
  );

  const phone = await app.fetch(json("/auth/phone/request", { phone: "+14155550100" }), env, ctx);
  expect(phone.status).toBe(200);
  const signUp = await app.fetch(
    json("/auth/password/sign-up", {
      email: "grace@example.com",
      password: "correct horse battery",
    }),
    env,
    ctx,
  );
  expect(signUp.status).toBe(200);
  await Promise.all(pending);

  expect(sms.sent).toHaveLength(1);
  expect(sent.map((m) => m.to)).toEqual(["grace@example.com"]);
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const users = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM ta_user WHERE email = 'grace@example.com'`;
    expect(users[0]?.n).toBe(1);
    const codes = await sql<
      { purpose: string }[]
    >`SELECT purpose FROM ta_verification WHERE purpose IN ('phone-otp', 'password-verify-otp') ORDER BY purpose`;
    expect(codes.map((c) => c.purpose)).toEqual(["password-verify-otp", "phone-otp"]);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
