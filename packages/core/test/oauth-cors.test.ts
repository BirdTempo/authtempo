import { describe, expect, it } from "vitest";
import { CAPTCHA_HEADER } from "../src/captcha.js";
import { ORIGIN_CHECK_PER_IP } from "../src/engine/oauth-clients.js";
import { APP_ORIGIN, BASE_URL } from "./helpers.js";
import {
  codeFor,
  oauthHandle,
  REDIRECT,
  RESOURCE,
  registered,
  SCOPES,
  tokenPost,
} from "./oauth-helpers.js";

const CLIENT_ORIGIN = new URL(REDIRECT).origin;
const EVIL = "https://evil.example.net";

const exchangeFrom = (
  origin: string | null,
  code: string,
  clientId: string,
  verifier: string,
  extra: Record<string, string> = {},
) =>
  tokenPost(
    {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
    },
    { ...(origin !== null ? { origin } : {}), ...extra },
  );

const refreshFrom = (origin: string | null, refreshToken: string, clientId: string) =>
  tokenPost(
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId },
    origin !== null ? { origin } : {},
  );

const preflight = (origin: string, query: string, method = "POST", path = "/auth/oauth/token") =>
  new Request(`${BASE_URL}${path}${query}`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": "content-type",
    },
  });

describe("CORS on the token endpoint for a registered client's origin (plan 11d)", () => {
  it("answers a code exchange from the client's own origin with the exact origin and no credentials (T1, T2)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const res = await h.auth.handle(exchangeFrom(CLIENT_ORIGIN, c.code, c.clientId, c.verifier));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin");
    expect(((await res.json()) as { access_token?: string }).access_token).toBeTypeOf("string");
  });

  it("answers an error to the client's own origin with the same headers, so the app reads the code (T1)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const res = await h.auth.handle(
      exchangeFrom(CLIENT_ORIGIN, c.code, c.clientId, "x".repeat(43)),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
    expect(res.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
  });

  it("refuses an origin that the named client did not register, and spends nothing (T1, T4)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const refused = await h.auth.handle(exchangeFrom(EVIL, c.code, c.clientId, c.verifier));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "origin_not_trusted" });
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    // The code is not spent: the client's own server still exchanges it.
    expect((await h.auth.handle(exchangeFrom(null, c.code, c.clientId, c.verifier))).status).toBe(
      200,
    );
  });

  it("refuses a foreign origin whose form names no client, or an unknown one", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    for (const clientId of ["", `cl_${"z".repeat(43)}`]) {
      const res = await h.auth.handle(exchangeFrom(CLIENT_ORIGIN, c.code, clientId, c.verifier));
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    const json = new Request(`${BASE_URL}/auth/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: CLIENT_ORIGIN },
      body: "{}",
    });
    expect((await h.auth.handle(json)).status).toBe(403);
  });

  it("keeps a refresh token bound to its client across origins (T5)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h, "mcp:read offline_access");
    const first = (await (
      await h.auth.handle(exchangeFrom(null, c.code, c.clientId, c.verifier))
    ).json()) as { refresh_token: string };
    const other = await registered(h, ["https://b.example.org/cb"], "Client B");
    // The client of the token, from another client's origin: refused before the spend.
    const fromB = await h.auth.handle(
      refreshFrom("https://b.example.org", first.refresh_token, c.clientId),
    );
    expect(fromB.status).toBe(403);
    // Client B from its own origin with A's token: invalid_grant, and nothing spent.
    const asB = await h.auth.handle(
      refreshFrom("https://b.example.org", first.refresh_token, other),
    );
    expect(asB.status).toBe(400);
    expect(await asB.json()).toEqual({ error: "invalid_grant" });
    expect(asB.headers.get("access-control-allow-origin")).toBe("https://b.example.org");
    // A's own origin refreshes, so the token was not spent by either refusal.
    const own = await h.auth.handle(refreshFrom(CLIENT_ORIGIN, first.refresh_token, c.clientId));
    expect(own.status).toBe(200);
    expect(own.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
  });

  it("answers the preflight of a registered client's origin with no credentials, and refuses every other preflight (T3, T6)", async () => {
    const h = oauthHandle();
    const clientId = await registered(h);
    const ok = await h.auth.handle(preflight(CLIENT_ORIGIN, `?client_id=${clientId}`));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(ok.headers.get("access-control-allow-methods")).toBe("POST");
    // The captcha header of the router's preflight (plan 12b), and the DPoP proof (plan 12e).
    expect(ok.headers.get("access-control-allow-headers")).toBe(
      `content-type, ${CAPTCHA_HEADER}, dpop`,
    );
    expect(CAPTCHA_HEADER).toBe("x-captcha-response");
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    expect(ok.headers.get("vary")).toContain("Origin");
    for (const req of [
      preflight(EVIL, `?client_id=${clientId}`),
      preflight(CLIENT_ORIGIN, ""),
      preflight(CLIENT_ORIGIN, `?client_id=cl_${"z".repeat(43)}`),
      preflight(CLIENT_ORIGIN, `?client_id=${clientId}`, "GET"),
      preflight(CLIENT_ORIGIN, `?client_id=${clientId}`, "POST", "/auth/oauth/revoke"),
      preflight(CLIENT_ORIGIN, `?client_id=${clientId}`, "POST", "/auth/oauth/register"),
    ]) {
      const res = await h.auth.handle(req);
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("answers the preflight of a client of api.oauth.clients, whose kind is api (plan 12e)", async () => {
    const h = oauthHandle();
    const made = await h.auth.api.oauth?.clients.create({ redirectUris: [REDIRECT] });
    if (!made?.ok) throw new Error("create failed");
    expect(made.value.client.kind).toBe("api");
    const res = await h.auth.handle(preflight(CLIENT_ORIGIN, `?client_id=${made.value.client.id}`));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
  });

  it("never fetches at a preflight: a client metadata document URL answers 403 (T6)", async () => {
    let fetched = 0;
    const h = oauthHandle({
      oauth: {
        resources: [RESOURCE],
        scopes: SCOPES,
        registration: { cimd: true },
        fetch: async () => {
          fetched++;
          return new Response("{}", { status: 404 });
        },
      },
    });
    const res = await h.auth.handle(
      preflight(CLIENT_ORIGIN, `?client_id=${encodeURIComponent(`${CLIENT_ORIGIN}/client.json`)}`),
    );
    expect(res.status).toBe(403);
    expect(fetched).toBe(0);
  });

  it("gives no web origin to a private-use scheme or to the origin null (T7)", async () => {
    const h = oauthHandle();
    const native = await registered(h, ["com.example.app:/callback"], "Native");
    for (const origin of ["com.example.app:", "null", "https://com.example.app"]) {
      const res = await h.auth.handle(preflight(origin, `?client_id=${native}`));
      expect(res.status).toBe(403);
    }
  });

  it("answers the same with a session cookie, and sends no credential header (T3)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const res = await h.auth.handle(
      exchangeFrom(CLIENT_ORIGIN, c.code, c.clientId, c.verifier, { cookie: c.cookie }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("counts the origin check on its own key, and a server request keeps its own budget (T8)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    expect(ORIGIN_CHECK_PER_IP).toEqual({ seconds: 900, max: 60 });
    for (let i = 0; i < 60; i++)
      expect((await h.auth.handle(exchangeFrom(EVIL, c.code, c.clientId, c.verifier))).status).toBe(
        403,
      );
    const limited = await h.auth.handle(exchangeFrom(EVIL, c.code, c.clientId, c.verifier));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await h.auth.handle(exchangeFrom(null, c.code, c.clientId, c.verifier))).status).toBe(
      200,
    );
  });

  it("keeps the credentialed CORS of a trusted origin (T9)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const res = await h.auth.handle(exchangeFrom(APP_ORIGIN, c.code, c.clientId, c.verifier));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("passes the Fetch Metadata rule for the client's own origin on a cross-site form post (plan 12b)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const res = await h.auth.handle(
      exchangeFrom(CLIENT_ORIGIN, c.code, c.clientId, c.verifier, {
        "sec-fetch-site": "cross-site",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(CLIENT_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("refuses a cross-site form post from an unregistered origin, and spends nothing (plan 12b)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    const res = await h.auth.handle(
      exchangeFrom(EVIL, c.code, c.clientId, c.verifier, { "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin_not_trusted" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect((await h.auth.handle(exchangeFrom(null, c.code, c.clientId, c.verifier))).status).toBe(
      200,
    );
  });

  it("keeps the Fetch Metadata 403 of a cross-site or same-site form post with no Origin (plan 12b)", async () => {
    const h = oauthHandle();
    const c = await codeFor(h);
    for (const site of ["cross-site", "same-site"]) {
      const res = await h.auth.handle(
        exchangeFrom(null, c.code, c.clientId, c.verifier, { "sec-fetch-site": site }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "origin_not_trusted" });
    }
    expect((await h.auth.handle(exchangeFrom(null, c.code, c.clientId, c.verifier))).status).toBe(
      200,
    );
  });

  it("answers a cross-site or same-site form post from a trusted Origin with credentialed CORS: trust is not worse than a client's origin", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const h = oauthHandle();
      const c = await codeFor(h);
      const res = await h.auth.handle(
        exchangeFrom(APP_ORIGIN, c.code, c.clientId, c.verifier, { "sec-fetch-site": site }),
      );
      expect({ site, status: res.status }).toEqual({ site, status: 200 });
      expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    }
  });

  it("keeps the 403 of a cross-site form post to revoke from the client's own origin (plan 12b)", async () => {
    const h = oauthHandle();
    await registered(h);
    const res = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/revoke`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: CLIENT_ORIGIN,
          "sec-fetch-site": "cross-site",
        },
        body: "token=x",
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps the 403 of every other OAuth POST from a foreign origin", async () => {
    const h = oauthHandle();
    const res = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: CLIENT_ORIGIN },
        body: "token=x",
      }),
    );
    expect(res.status).toBe(403);
  });
});
