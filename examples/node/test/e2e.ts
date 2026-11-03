// One magic link sign-in through the real HTTP server of this runtime, on the
// docker compose Postgres (plan 11a, Review Focus 5). `pnpm test` runs it with
// Node and then with Bun. It prints one summary line and exits 1 on a failure.
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import type { MailMessage } from "@authtempo/core";
import { DEFAULT_COOKIE_NAME } from "@authtempo/core/credentials";
import postgres from "postgres";
import { createApp, type Serve } from "../src/app.ts";

const runtime = "Bun" in globalThis ? "bun" : "node";

/** The address of a test server: `node scripts/test-servers.mjs up` writes it, and `pnpm test` passes it. */
function serverUrl(name: string): string {
  const url = process.env[name];
  if (url === undefined || url === "")
    throw new Error(
      `${name} is not set. Run: node scripts/test-servers.mjs up (pnpm test runs it for you)`,
    );
  return url;
}
const version = runtime === "bun" ? Bun.version : process.versions.node;
const serve: Serve =
  runtime === "bun"
    ? (await import("../src/server-bun.ts")).serveBun
    : (await import("../src/server-node.ts")).serveNode;
/** A socket that holds a free port of 127.0.0.1 from the OS, so a listen on the port fails. */
async function holdPort(): Promise<{ port: number; close(): Promise<void> }> {
  const { createServer } = await import("node:net");
  const held = createServer();
  await new Promise<void>((done, fail) => {
    held.once("error", fail);
    held.listen(0, "127.0.0.1", () => done());
  });
  const address = held.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => new Promise<void>((done) => held.close(() => done())) };
}
/**
 * A free port from the OS. A fixed port met EADDRINUSE when this test and the
 * init scaffold test of the CLI ran at once (lane item P1 of plan 12g).
 */
async function freePort(): Promise<number> {
  const probe = await holdPort();
  await probe.close();
  return probe.port;
}
/** The most ports that `listen` tries. */
const LISTEN_TRIES = 3;
/**
 * Serves the handler of `make(base)` on a free port. The probe of freePort
 * closes before the server listens, so another process can take the port.
 * A listen that fails with EADDRINUSE then tries a new port.
 */
async function listen(
  make: (base: string) => (request: Request) => Promise<Response>,
  nextPort: () => Promise<number> = freePort,
): Promise<{ base: string; server: { close(): Promise<void> }; tries: number }> {
  for (let tries = 1; ; tries++) {
    const port = await nextPort();
    const base = `http://127.0.0.1:${port}`;
    try {
      const live = await serve(make(base), { port, hostname: "127.0.0.1", origin: base });
      return { base, server: live, tries };
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EADDRINUSE" || tries >= LISTEN_TRIES) throw e;
    }
  }
}
const ADMIN_URL = serverUrl("TEMPO_AUTH_PG_URL");
const DB = `ex_${runtime}_${crypto.randomUUID().replaceAll("-", "")}`;
const DB_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${DB}`);

const failures: string[] = [];
let checks = 0;
function expectThat(ok: boolean, what: string): void {
  checks++;
  if (!ok) failures.push(what);
}
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
let sql: ReturnType<typeof postgres> | null = null;
let server: { close(): Promise<void> } | null = null;
try {
  // The retry, before the database exists: a held port fails the first
  // listen, and the next port serves.
  const held = await holdPort();
  try {
    const ports = [held.port];
    const probe = await listen(
      () => async () => new Response("ok"),
      async () => ports.shift() ?? freePort(),
    );
    await probe.server.close();
    expectThat(
      probe.tries === 2 && probe.base !== `http://127.0.0.1:${held.port}`,
      `a listen on a held port took ${probe.tries} tries`,
    );
  } finally {
    await held.close();
  }

  await admin.unsafe(`CREATE DATABASE ${DB}`);
  const db = postgres(DB_URL, { max: 2, onnotice: () => {} });
  sql = db;
  await applyPostgresMigrations(db);
  const sent: MailMessage[] = [];
  const live = await listen(
    (base) =>
      createApp({
        baseURL: base,
        secret: "0123456789abcdef0123456789abcdef",
        sql: db,
        mail: {
          async send(m) {
            sent.push(m);
          },
        },
      }).fetch,
  );
  server = live.server;
  const BASE = live.base;

  const ask = await fetch(`${BASE}/auth/magic-link/request`, json({ email: "ada@example.com" }));
  expectThat(ask.status === 200, `the link request answered ${ask.status}`);
  const link = /https?:\/\/\S+/.exec(sent.at(-1)?.text ?? "")?.[0];
  const token = link ? (new URL(link).searchParams.get("token") ?? "") : "";
  expectThat(token.startsWith("ml_"), "no magic link in the mail");
  const verify = await fetch(`${BASE}/auth/magic-link/verify`, json({ token }));
  expectThat(verify.status === 200, `the verify answered ${verify.status}`);
  const cookie = (verify.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  const me = (await (await fetch(`${BASE}/me`, { headers: { cookie } })).json()) as {
    email?: string;
  };
  expectThat(me.email === "ada@example.com", `/me answered ${JSON.stringify(me)}`);
  // A server that is not the auth app verifies a session JWT (plan 11d): /files.
  const minted = (await (await fetch(`${BASE}/auth/token`, { headers: { cookie } })).json()) as {
    token?: string;
  };
  expectThat(typeof minted.token === "string", "GET /auth/token gave no token");
  const files = await fetch(`${BASE}/files`, {
    headers: { authorization: `Bearer ${minted.token ?? ""}` },
  });
  // A 404 answers text, not JSON: the check below then names the status.
  const owner = (await files.json().catch(() => ({}))) as { owner?: string };
  expectThat(
    files.status === 200 && owner.owner === "ada@example.com",
    `/files answered ${files.status}`,
  );
  const anonymous = await fetch(`${BASE}/files`);
  expectThat(anonymous.status === 401, `/files with no token answered ${anonymous.status}`);
  // A Basic header is no bearer: the plain challenge, with no error code (RFC 6750 section 3.1).
  const basic = await fetch(`${BASE}/files`, { headers: { authorization: "Basic dXNlcjpwYXNz" } });
  expectThat(
    basic.status === 401 && basic.headers.get("www-authenticate") === "Bearer",
    `/files with a Basic header answered ${basic.status} with ${basic.headers.get("www-authenticate")}`,
  );
  // A refused bearer gets error="invalid_token": the verifier read it and refused it.
  const refused = await fetch(`${BASE}/files`, {
    headers: { authorization: "Bearer ts_not_a_token" },
  });
  expectThat(
    refused.status === 401 &&
      refused.headers.get("www-authenticate") === 'Bearer error="invalid_token"',
    `/files with a refused bearer answered ${refused.status} with ${refused.headers.get("www-authenticate")}`,
  );
  // The verifier reads the bearer only: a session cookie beside it does not hide the refusal.
  const withCookie = await fetch(`${BASE}/files`, {
    headers: { cookie: `${DEFAULT_COOKIE_NAME}=ts_x`, authorization: "Bearer ts_refused" },
  });
  expectThat(
    withCookie.status === 401 &&
      withCookie.headers.get("www-authenticate") === 'Bearer error="invalid_token"',
    `/files with a cookie and a refused bearer answered ${withCookie.status} with ${withCookie.headers.get("www-authenticate")}`,
  );
} catch (e) {
  failures.push(
    `${e instanceof Error ? e.message : String(e)}; is Postgres up (node scripts/test-servers.mjs up)?`,
  );
} finally {
  await server?.close();
  await sql?.end({ timeout: 5 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 });
}
const pass = failures.length === 0 && checks === 11;
console.log(
  `${runtime}-e2e: ${pass ? "PASS" : "FAIL"} version=${version} checks=${checks} failures=${failures.length}`,
);
for (const f of failures) console.error(`${runtime}-e2e: ${f}`);
if (!pass) process.exit(1);
