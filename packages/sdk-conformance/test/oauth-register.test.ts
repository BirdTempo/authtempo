import { registerOAuthClient } from "@authtempo/client/oauth";
import { createAuth, createMemoryAdapter } from "@authtempo/core";
import { expect, it } from "vitest";

const BASE = "https://api.example.com";
const TOKEN = "iat-0123456789abcdef0123456789abcdef";

/** The SHA-256 hex of a text, computed here. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The SDK's register call against core in process (plan 12e). The route
 * takes the credential form `initialAccessToken`, and the SDK must send it.
 */
it("registers through the SDK with the initial access token that core asks for", async () => {
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    oauth: {
      resources: [`${BASE}/mcp`],
      registration: { cimd: false, dynamic: true, initialAccessTokenHash: await sha256(TOKEN) },
    },
  });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    auth.handle(new Request(input, init))) as typeof globalThis.fetch;
  const base = {
    issuer: `${BASE}/auth`,
    clientName: "CLI",
    redirectUris: ["http://127.0.0.1:8123/cb"],
    fetch,
  };
  expect(await registerOAuthClient(base)).toEqual({
    ok: false,
    code: "invalid_token",
    status: 401,
  });
  const ok = await registerOAuthClient({ ...base, initialAccessToken: TOKEN });
  expect(ok).toMatchObject({ ok: true, value: { clientId: expect.stringMatching(/^cl_/) } });
});
