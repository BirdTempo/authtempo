import { applyD1Migrations, env } from "cloudflare:test";
import type { MailMessage } from "@authtempo/core";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { createApp } from "../src/index.js";

// The values of wrangler.jsonc and vitest.config.ts, written out here, so a
// change on either side fails a test.
const BASE = "https://example.test";
const RESOURCE = `${BASE}/mcp`;
const METADATA = `${BASE}/.well-known/oauth-protected-resource/mcp`;
/** The client metadata document that the outbound service of vitest.config.ts serves. */
const CLIENT_ID = "https://agent.example.com/client.json";
const REDIRECT = "http://127.0.0.1:33418/callback";

// The migrations of @authtempo/adapter-d1 on the local D1 database, as
// `wrangler d1 migrations apply` writes them on a real one.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/** The app with a mail port that keeps the mails. */
function start() {
  const sent: MailMessage[] = [];
  const app = createApp(env, {
    mail: {
      async send(m) {
        sent.push(m);
      },
    },
  });
  return { app, sent };
}

type App = ReturnType<typeof start>["app"];

const post = (path: string, headers: Record<string, string>, body: string) =>
  new Request(`${BASE}${path}`, { method: "POST", headers, body });

/** A person signed in by magic link: the session cookie and the user id. */
async function signIn(app: App, sent: MailMessage[]) {
  const json = { "content-type": "application/json" };
  const ask = await app.fetch(
    post("/auth/magic-link/request", json, JSON.stringify({ email: "ada@example.com" })),
  );
  expect(await ask.json()).toEqual({ sent: true });
  const link = /https:\/\/\S+/.exec(sent.at(-1)?.text ?? "")?.[0] ?? "";
  const token = new URL(link).searchParams.get("token") ?? "";
  const verify = await app.fetch(post("/auth/magic-link/verify", json, JSON.stringify({ token })));
  expect(verify.status).toBe(200);
  const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const { user } = (await verify.json()) as { user: { id: string } };
  return { cookie, userId: user.id };
}

async function s256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let bin = "";
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * An access token through the real flow of an MCP client with a metadata
 * document: the authorize request with PKCE S256, the consent, and the code
 * exchange. Core fetches the document through the guarded fetch.
 */
async function accessToken(app: App, cookie: string, scope: string): Promise<string> {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    scope,
    resource: RESOURCE,
    state: "st",
  });
  const page = await app.fetch(
    new Request(`${BASE}/auth/oauth/authorize?${query}`, { headers: { cookie } }),
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Agent");
  const id = /name="request_id" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const allowed = await app.fetch(
    post(
      "/auth/oauth/authorize",
      { ...form, origin: BASE, cookie },
      new URLSearchParams({ request_id: id, decision: "allow" }).toString(),
    ),
  );
  const location = new URL(allowed.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("st");
  const tokens = await app.fetch(
    post(
      "/auth/oauth/token",
      form,
      new URLSearchParams({
        grant_type: "authorization_code",
        code: location.searchParams.get("code") ?? "",
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        resource: RESOURCE,
      }).toString(),
    ),
  );
  expect(tokens.status).toBe(200);
  return ((await tokens.json()) as { access_token: string }).access_token;
}

/** One JSON-RPC message to the MCP route, with a bearer when one is given. */
function mcp(app: App, body: unknown, bearer?: string) {
  return app.fetch(
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify(body),
    }),
  );
}

/** The JSON-RPC message of an answer: a 2025-era answer comes as one server-sent event. */
async function message(res: Response): Promise<unknown> {
  const text = await res.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data === undefined ? text : data.slice("data: ".length));
}

const WHOAMI = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "whoami", arguments: {} },
};

describe("the MCP server example (plan 11e)", () => {
  it("signs a client in by its metadata document, and answers whoami with the caller", async () => {
    const { app, sent } = start();
    const { cookie, userId } = await signIn(app, sent);
    const token = await accessToken(app, cookie, "mcp:tools");
    const res = await mcp(app, WHOAMI, token);
    expect(res.status).toBe(200);
    const answer = (await message(res)) as {
      id: number;
      result: { structuredContent: unknown; isError?: boolean };
    };
    expect(answer.id).toBe(1);
    expect(answer.result.isError ?? false).toBe(false);
    expect(answer.result.structuredContent).toEqual({
      userId,
      clientId: CLIENT_ID,
      scopes: ["mcp:tools"],
    });
  });

  it("answers 401 with resource_metadata to a request with no token", async () => {
    const { app } = start();
    const res = await mcp(app, WHOAMI);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${METADATA}", scope="mcp:tools"`,
    );
    const doc = await app.fetch(new Request(METADATA));
    expect(doc.status).toBe(200);
    expect(await doc.json()).toMatchObject({
      resource: RESOURCE,
      scopes_supported: expect.arrayContaining(["mcp:tools"]),
    });
  });

  it("answers 403 with scope mcp:tools to a token with openid only", async () => {
    const { app, sent } = start();
    const { cookie } = await signIn(app, sent);
    const token = await accessToken(app, cookie, "openid");
    const res = await mcp(app, WHOAMI, token);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="mcp:tools", resource_metadata="${METADATA}"`,
    );
  });

  it("has no dynamic registration: POST /auth/oauth/register answers not_found", async () => {
    const { app } = start();
    // With registration.dynamic false, core mounts no register route (src/http/routes/oauth.ts),
    // so its router answers 404 not_found, and the metadata names no registration_endpoint.
    const res = await app.fetch(
      post(
        "/auth/oauth/register",
        { "content-type": "application/json" },
        JSON.stringify({ client_name: "Agent", redirect_uris: [REDIRECT] }),
      ),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    const meta = await app.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    expect(meta.status).toBe(200);
    expect(await meta.json()).not.toHaveProperty("registration_endpoint");
  });

  it("answers 500 to a sign-in request until the app has a mail transport", async () => {
    const res = await worker.fetch(
      post(
        "/auth/magic-link/request",
        { "content-type": "application/json" },
        JSON.stringify({ email: "ada@example.com" }),
      ),
      env,
    );
    expect(res.status).toBe(500);
  });
});
