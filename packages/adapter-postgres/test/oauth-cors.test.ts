import { createAuth, type MailMessage } from "@authtempo/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPostgresAdapter, createPostgresLimiter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The token endpoint's CORS (plan 11d) on the real adapter: the preflight reads
// the client row from Postgres, and two parallel exchanges of one code from
// the client's origin spend the code once (threat T10).

const BASE = "https://api.example.com";
const REDIRECT = "https://client.example.com/callback";
const ORIGIN = "https://client.example.com";
const RESOURCE = `${BASE}/mcp`;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

async function sha256Base64Url(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

it("exchanges one code once of two parallel posts from the client's origin on Postgres", async () => {
  const sent: MailMessage[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createPostgresAdapter(db.sql),
    limiter: createPostgresLimiter(db.sql),
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    oauth: { resources: [RESOURCE], registration: { cimd: false } },
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    auth.handle(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
  const registeredRes = await post("/auth/oauth/register", {
    redirect_uris: [REDIRECT],
    client_name: "SPA",
  });
  const { client_id: clientId } = (await registeredRes.json()) as { client_id: string };

  // The preflight reads the client row from Postgres.
  const pre = await auth.handle(
    new Request(`${BASE}/auth/oauth/token?client_id=${clientId}`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    }),
  );
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);

  // A signed-in person allows the client on the consent page.
  await post("/auth/magic-link/request", { email: "ada@example.com" });
  const token = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "";
  const verify = await post("/auth/magic-link/verify", { token });
  const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const verifier = "v".repeat(43);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: "S256",
    scope: "openid",
    resource: RESOURCE,
    state: "st-1",
  });
  const page = await auth.handle(
    new Request(`${BASE}/auth/oauth/authorize?${query}`, { headers: { cookie } }),
  );
  expect(page.status).toBe(200);
  const requestId = /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
  const allowed = await auth.handle(
    new Request(`${BASE}/auth/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE,
        cookie,
      },
      body: new URLSearchParams({ request_id: requestId ?? "", decision: "allow" }).toString(),
    }),
  );
  const code = new URL(allowed.headers.get("location") ?? "").searchParams.get("code") ?? "";
  expect(code.startsWith("oc_")).toBe(true);

  const exchange = () =>
    auth.handle(
      new Request(`${BASE}/auth/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: REDIRECT,
          resource: RESOURCE,
        }).toString(),
      }),
    );
  const answers = await Promise.all([exchange(), exchange()]);
  expect(answers.map((r) => r.status).sort()).toEqual([200, 400]);
  for (const r of answers) expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
});
