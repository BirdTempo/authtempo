import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const RESOURCE = `${BASE_URL}/mcp`;
const OAUTH = { resources: [RESOURCE], registration: { cimd: false, dynamic: true } };

/** A signed-in browser, and the rows an allow and a code exchange write for one client. */
async function grantedBrowser() {
  const server = makeServer({ oauth: OAUTH });
  const { fetch } = inProcessFetch(server.auth);
  const browser = createClient({ baseURL: BASE_URL, fetch });
  await browser.magicLink.request({ email: "ada@example.com" });
  const verified = await browser.magicLink.verify({
    token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
  });
  if (!verified.ok) throw new Error(verified.code);
  if ("twoFactor" in verified.value) throw new Error("no session: a second-factor challenge");
  const userId = verified.value.user.id;
  const now = server.clock.now();
  const clientId = `cl_${"a".repeat(43)}`;
  await server.storage.create("oauthClient", {
    id: clientId,
    kind: "registered",
    name: "Agent",
    redirectUris: ["https://agent.example.com/cb"],
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    // A public client, as plan 12e's schema version 11 reads a row of version 10.
    authMethod: "none",
    secretHash: null,
    secretExpiresAt: null,
    previousSecretHash: null,
    previousSecretUntil: null,
    jwks: null,
    jwksUri: null,
    grantTypes: ["authorization_code", "refresh_token"],
    credentialsScopes: [],
    introspect: false,
    postLogoutRedirectUris: [],
    backchannelLogoutUri: null,
    backchannelLogoutSessionRequired: false,
    subjectType: "public",
    dpopBound: false,
  });
  await server.storage.create("oauthConsent", {
    id: "consent-1",
    userId,
    clientId,
    scopes: ["openid", "offline_access"],
    createdAt: now,
    updatedAt: now,
  });
  await server.storage.create("oauthToken", {
    id: "token-1",
    tokenHash: "h1",
    familyId: "family-1",
    userId,
    clientId,
    scopes: ["openid", "offline_access"],
    resource: RESOURCE,
    expiresAt: new Date(now.getTime() + 86_400_000),
    usedAt: null,
    parentId: null,
    dpopJkt: null,
    createdAt: now,
    updatedAt: now,
  });
  return { server, fetch, browser, clientId, now, userId };
}

describe("oauth grants (plan 9g final fix wave)", () => {
  it("lists the signed-in person's grants and revokes one", async () => {
    const { server, browser, clientId, now } = await grantedBrowser();
    expect(await browser.oauth.grants()).toEqual({
      ok: true,
      value: [
        {
          clientId,
          clientName: "Agent",
          scopes: ["openid", "offline_access"],
          createdAt: now.toISOString(),
          refreshTokens: 1,
        },
      ],
    });
    expect(await browser.oauth.revoke({ clientId })).toEqual({ ok: true, value: { ok: true } });
    expect(await browser.oauth.grants()).toEqual({ ok: true, value: [] });
    expect(await server.storage.findMany("oauthToken", [])).toEqual([]);
    // A client that had no grant answers the same.
    expect(await browser.oauth.revoke({ clientId: "cl_none" })).toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it("answers unauthorized with no session and for a tk_ token, and not_found without oauth", async () => {
    const { server, fetch, clientId, userId } = await grantedBrowser();
    const anonymous = createClient({ baseURL: BASE_URL, fetch, credentials: "omit" });
    const no = { ok: false, code: "unauthorized", status: 401 };
    expect(await anonymous.oauth.grants()).toEqual(no);
    expect(await anonymous.oauth.revoke({ clientId })).toEqual(no);
    // The token create takes a session of the user (plan 12p): a magic link in process.
    await server.auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
    const link = await server.auth.api.verifyMagicLink({
      token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    if (!link.ok || !("token" in link.value)) throw new Error("no session");
    const session = await server.auth.api.getSession(link.value.token);
    if (!session || session.user.id !== userId) throw new Error("no session");
    const created = await server.auth.api.tokens.create({ session, name: "cli" });
    if (!created.ok) throw new Error(created.code);
    const cli = createClient({
      baseURL: BASE_URL,
      fetch,
      credentials: "omit",
      token: () => created.value.token,
    });
    expect(await cli.oauth.grants()).toEqual(no);
    expect(await cli.oauth.revoke({ clientId })).toEqual(no);
    expect(await server.storage.findMany("oauthConsent", [])).toHaveLength(1);
    const off = makeServer();
    const offBrowser = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(off.auth).fetch });
    const notFound = { ok: false, code: "not_found", status: 404 };
    expect(await offBrowser.oauth.grants()).toEqual(notFound);
    expect(await offBrowser.oauth.revoke({ clientId })).toEqual(notFound);
  });
});
