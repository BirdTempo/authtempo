// One magic link sign-in through the real HTTP server of this runtime, on the
// docker compose Postgres (plan 11a, Review Focus 5). `pnpm test` runs it with
// Node and then with Bun. It prints one summary line and exits 1 on a failure.
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import type { MailMessage } from "@authtempo/core";
import postgres from "postgres";
import { createApp, type Serve } from "../src/app.ts";

const runtime = "Bun" in globalThis ? "bun" : "node";
const version = runtime === "bun" ? Bun.version : process.versions.node;
const serve: Serve =
  runtime === "bun"
    ? (await import("../src/server-bun.ts")).serveBun
    : (await import("../src/server-node.ts")).serveNode;
const PORT = runtime === "bun" ? 8792 : 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_URL =
  process.env.TEMPO_AUTH_PG_URL ?? "postgres://tempo:tempo@localhost:5439/tempo_auth";
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
  await admin.unsafe(`CREATE DATABASE ${DB}`);
  sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
  await applyPostgresMigrations(sql);
  const sent: MailMessage[] = [];
  const app = createApp({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    sql,
    mail: {
      async send(m) {
        sent.push(m);
      },
    },
  });
  server = await serve(app.fetch, { port: PORT, hostname: "127.0.0.1", origin: BASE });

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
} catch (e) {
  failures.push(
    `${e instanceof Error ? e.message : String(e)}; is Postgres up (docker compose up -d)?`,
  );
} finally {
  await server?.close();
  await sql?.end({ timeout: 5 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 });
}
const pass = failures.length === 0 && checks === 9;
console.log(
  `${runtime}-e2e: ${pass ? "PASS" : "FAIL"} version=${version} checks=${checks} failures=${failures.length}`,
);
for (const f of failures) console.error(`${runtime}-e2e: ${f}`);
if (!pass) process.exit(1);
