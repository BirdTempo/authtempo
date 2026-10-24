import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { DEVICE_GRANT, findUserCode, normalizeUserCode } from "../src/engine/oauth-device.js";
import { revokeGrant } from "../src/engine/oauth-grants.js";
import { changePassword, requestPasswordReset, resetPassword } from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import type { LimiterPort } from "../src/limiter/port.js";
import { fromBase64Url } from "../src/primitives/crypto.js";
import type { SecretVersion } from "../src/primitives/keyring.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, emailOf, makeAuth, post } from "./helpers.js";
import {
  approvedDevice,
  basicHeader,
  type Handle,
  REDIRECT,
  RESOURCE,
  SCOPES,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";
import { FAST, pwHandle } from "./password-helpers.js";
import { dpopKey } from "./support/dpop-key.js";

/**
 * The device grant (plan 12e Task 14, RFC 8628 read 2026-10-20, ruling 44).
 * A rule that spans instances runs on two core instances over one storage,
 * one clock, and one limiter.
 */

const SECRET_1 = "0123456789abcdef0123456789abcdef";
const SECRET_2 = "Zq8vR2kL9mN4pX7wT1yB6cD3hF5jG0sQ";
const ISSUER = `${BASE_URL}/auth`;
const DEVICE_URL = `${ISSUER}/oauth/device`;
const START_URL = `${ISSUER}/oauth/device_authorization`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const dec = new TextDecoder();

interface Shared {
  storage: Handle["storage"];
  clock: Handle["clock"];
  limiter: LimiterPort;
}

/** One core instance; with `shared`, on its storage, clock, and limiter. */
function instance(
  shared?: Shared,
  oauth: Partial<NonNullable<Exclude<AuthConfig["oauth"], false>>> = {},
  extra: Partial<AuthConfig> = {},
): Handle & { limiter: LimiterPort } {
  const base = shared ?? makeAuth();
  const limiter = shared?.limiter ?? createMemoryLimiter(base.clock);
  const input: AuthConfig = {
    baseURL: BASE_URL,
    // `secrets` alone names every version.
    ...(extra.secrets ? {} : { secret: SECRET_1 }),
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter,
    oauth: {
      resources: [RESOURCE],
      scopes: SCOPES,
      registration: { cimd: false, dynamic: true },
      device: {},
      ...oauth,
    },
    ...extra,
  };
  return {
    auth: createAuth(input),
    config: resolveConfig(input),
    storage: base.storage,
    clock: base.clock,
    limiter,
  };
}

/** A public client with the device grant, registered through the route. */
async function deviceClient(h: Handle, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await h.auth.handle(
    post("/auth/oauth/register", {
      redirect_uris: [REDIRECT],
      client_name: "Living room TV",
      grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
      ...extra,
    }),
  );
  if (res.status !== 201) throw new Error(`register answered ${res.status}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

function form(url: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

interface Started {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function start(
  h: Handle,
  clientId: string,
  scope = "openid mcp:read offline_access",
  headers: Record<string, string> = {},
): Promise<Started> {
  const res = await h.auth.handle(
    form(START_URL, { client_id: clientId, scope, resource: RESOURCE }, headers),
  );
  if (res.status !== 200) throw new Error(`device_authorization answered ${res.status}`);
  return (await res.json()) as Started;
}

/** A post of the device page as the browser sends it: this origin, the session cookie. */
const pagePost = (cookie: string, body: Record<string, string>, origin = BASE_URL) =>
  form(DEVICE_URL, body, { cookie, origin });

const poll = (clientId: string, deviceCode: string, headers: Record<string, string> = {}) =>
  tokenPost({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId }, headers);

async function answer(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(dec.decode(fromBase64Url(jwt.split(".")[1] ?? ""))) as Record<string, unknown>;
}

/** The person types the code, sees the consent, and decides. Answers the HTML of the last page. */
async function decide(h: Handle, cookie: string, userCode: string, decision: "allow" | "deny") {
  const consent = await h.auth.handle(pagePost(cookie, { user_code: userCode }));
  expect(consent.status).toBe(200);
  const done = await h.auth.handle(pagePost(cookie, { user_code: userCode, decision }));
  expect(done.status).toBe(200);
  return done.text();
}

/** The HMAC-SHA256 hex of `text` under `secret`, computed here, apart from core's helper. */
async function hmacHex(secret: string, text: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function deviceRows(h: Handle) {
  return h.storage.findMany("oauthDevice", []);
}

describe("the device grant (plan 12e Task 14, RFC 8628)", () => {
  it("starts a device authorization with the RFC 8628 3.2 answer", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const res = await h.auth.handle(
      form(START_URL, { client_id: clientId, scope: "mcp:read", resource: RESOURCE }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Started;
    expect(Object.keys(body).sort()).toEqual([
      "device_code",
      "expires_in",
      "interval",
      "user_code",
      "verification_uri",
      "verification_uri_complete",
    ]);
    expect(body.device_code).toMatch(/^od_[A-Za-z0-9_-]{43}$/);
    expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(body.verification_uri).toBe("https://api.example.com/auth/oauth/device");
    expect(body.verification_uri_complete).toBe(
      `https://api.example.com/auth/oauth/device?user_code=${body.user_code}`,
    );
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
    // The row holds the hashes of both codes, never a code.
    const [row] = await deviceRows(h);
    expect(row).toMatchObject({ clientId, status: "pending", scopes: ["mcp:read"], interval: 5 });
    expect(JSON.stringify(row)).not.toContain(body.device_code);
    expect(JSON.stringify(row)).not.toContain(body.user_code.replace("-", ""));
    // A client without the grant, a pairwise client, a bad resource, and a bad scope.
    const plain = await h.auth.handle(
      post("/auth/oauth/register", { redirect_uris: [REDIRECT], client_name: "Plain" }),
    );
    const plainId = ((await plain.json()) as { client_id: string }).client_id;
    const refused = async (body: Record<string, string>) =>
      answer(await h.auth.handle(form(START_URL, body)));
    expect(
      await refused({ client_id: plainId, scope: "mcp:read", resource: RESOURCE }),
    ).toMatchObject({ status: 400, body: { error: "unauthorized_client" } });
    expect(
      await refused({ client_id: clientId, scope: "mcp:read", resource: `${RESOURCE}/x` }),
    ).toMatchObject({ status: 400, body: { error: "invalid_target" } });
    expect(await refused({ client_id: clientId, scope: "mcp:read" })).toMatchObject({
      body: { error: "invalid_target" },
    });
    expect(
      await refused({ client_id: clientId, scope: "mcp:nope", resource: RESOURCE }),
    ).toMatchObject({ status: 400, body: { error: "invalid_scope" } });
    expect(await refused({ client_id: clientId, resource: RESOURCE })).toMatchObject({
      body: { error: "invalid_scope" },
    });
    expect(
      await refused({ client_id: "cl_unknown", scope: "mcp:read", resource: RESOURCE }),
    ).toMatchObject({ status: 400, body: { error: "invalid_client" } });
    expect((await deviceRows(h)).length).toBe(1);
  });

  it("answers authorization_pending, then slow_down with 5 more seconds, then the tokens after the approval, once", async () => {
    const h = instance();
    const other = instance(h);
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const started = await start(h, clientId);
    expect(await answer(await h.auth.handle(poll(clientId, started.device_code)))).toEqual({
      status: 400,
      body: { error: "authorization_pending" },
    });
    // 4 s later, on another instance: too early. The interval grows by 5 to 10.
    h.clock.advance(4_000);
    expect(await answer(await other.auth.handle(poll(clientId, started.device_code)))).toEqual({
      status: 400,
      body: { error: "slow_down" },
    });
    const [slowed] = await deviceRows(h);
    expect(slowed?.interval).toBe(10);
    // 6 s after the slow poll: on time for 5, early for 10.
    h.clock.advance(6_000);
    expect((await answer(await h.auth.handle(poll(clientId, started.device_code)))).body).toEqual({
      error: "slow_down",
    });
    expect((await deviceRows(h))[0]?.interval).toBe(15);
    const done = await decide(h, s.cookie, started.user_code, "allow");
    expect(done).toContain("The device is connected.");
    h.clock.advance(15_000);
    const tokens = await answer(await other.auth.handle(poll(clientId, started.device_code)));
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({
      token_type: "Bearer",
      scope: "openid mcp:read offline_access",
      expires_in: expect.any(Number),
    });
    expect(tokens.body.refresh_token).toMatch(/^or_/);
    const id = claimsOf(String(tokens.body.id_token));
    expect(id).toMatchObject({ iss: ISSUER, sub: s.user.id, aud: clientId, sid: s.session.id });
    expect(id.auth_time).toBe(Math.floor(s.session.createdAt.getTime() / 1000));
    expect(id.nonce).toBeUndefined();
    expect(claimsOf(String(tokens.body.access_token))).toMatchObject({
      sub: s.user.id,
      aud: RESOURCE,
      client_id: clientId,
    });
    // The consent is the one that grantConsent writes, so a later authorize needs no page.
    expect(
      await h.storage.findOne("oauthConsent", [{ field: "clientId", op: "eq", value: clientId }]),
    ).toMatchObject({ userId: s.user.id, scopes: ["openid", "mcp:read", "offline_access"] });
    // A second spend, on either instance and on time, answers invalid_grant.
    h.clock.advance(20_000);
    for (const i of [h, other])
      expect(await answer(await i.auth.handle(poll(clientId, started.device_code)))).toEqual({
        status: 400,
        body: { error: "invalid_grant" },
      });
    expect((await deviceRows(h))[0]?.status).toBe("spent");
  });

  it("answers access_denied after a deny and expired_token after the life", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const denied = await start(h, clientId);
    expect(await decide(h, s.cookie, denied.user_code, "deny")).toContain(
      "The device is not connected.",
    );
    expect(await answer(await h.auth.handle(poll(clientId, denied.device_code)))).toEqual({
      status: 400,
      body: { error: "access_denied" },
    });
    // A denied code ends: the page finds it no more, so no later allow can approve it.
    const again = await h.auth.handle(
      pagePost(s.cookie, { user_code: denied.user_code, decision: "allow" }),
    );
    expect(await again.text()).toContain("That code is not valid, or it has expired.");
    expect((await answer(await h.auth.handle(poll(clientId, denied.device_code)))).body).toEqual({
      error: "access_denied",
    });
    const late = await start(h, clientId);
    h.clock.advance(600_000 - 1);
    expect((await answer(await h.auth.handle(poll(clientId, late.device_code)))).body).toEqual({
      error: "authorization_pending",
    });
    h.clock.advance(1);
    expect(await answer(await h.auth.handle(poll(clientId, late.device_code)))).toEqual({
      status: 400,
      body: { error: "expired_token" },
    });
    // The page refuses the expired code too.
    const page = await h.auth.handle(pagePost(s.cookie, { user_code: late.user_code }));
    expect(await page.text()).toContain("That code is not valid, or it has expired.");
  });

  it("binds the device code to the client that asked and to the key of its proof", async () => {
    const h = instance();
    const other = instance(h);
    const clientId = await deviceClient(h);
    const thief = await deviceClient(h);
    const s = await signedIn(h);
    const key = await dpopKey();
    const nowS = () => Math.floor(h.clock.now().getTime() / 1000);
    const startProof = await key.proof({ htu: START_URL, iat: nowS() });
    const started = await start(h, clientId, "mcp:read", { dpop: startProof });
    expect((await deviceRows(h))[0]?.dpopJkt).toBe(key.jkt);
    await decide(h, s.cookie, started.user_code, "allow");
    // Another client's poll with the same device code: no tokens, nothing spent.
    expect(await answer(await other.auth.handle(poll(thief, started.device_code)))).toEqual({
      status: 400,
      body: { error: "invalid_grant" },
    });
    // No proof, or a proof of another key: refused, nothing spent.
    expect(
      (await answer(await other.auth.handle(poll(clientId, started.device_code)))).body,
    ).toEqual({ error: "invalid_dpop_proof" });
    const stranger = await dpopKey();
    const wrong = await stranger.proof({ htu: TOKEN_URL, iat: nowS() });
    expect(
      (await answer(await other.auth.handle(poll(clientId, started.device_code, { dpop: wrong }))))
        .body,
    ).toEqual({ error: "invalid_dpop_proof" });
    expect((await deviceRows(h))[0]?.status).toBe("approved");
    const proof = await key.proof({ htu: TOKEN_URL, iat: nowS() });
    const tokens = await answer(
      await other.auth.handle(poll(clientId, started.device_code, { dpop: proof })),
    );
    expect(tokens.status).toBe(200);
    expect(tokens.body.token_type).toBe("DPoP");
    expect(claimsOf(String(tokens.body.access_token)).cnf).toEqual({ jkt: key.jkt });
    // A bad proof at the start is refused, and no row is written.
    const bad = await h.auth.handle(
      form(
        START_URL,
        { client_id: clientId, scope: "mcp:read", resource: RESOURCE },
        { dpop: await key.proof({ htu: TOKEN_URL, iat: nowS() }) },
      ),
    );
    expect(await answer(bad)).toEqual({ status: 400, body: { error: "invalid_dpop_proof" } });
    expect((await deviceRows(h)).length).toBe(1);
  });

  it("fills the code field from user_code and still needs a submit (RFC 8628 3.3.1)", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const started = await start(h, clientId);
    const page = await h.auth.handle(
      new Request(started.verification_uri_complete, { headers: { cookie: s.cookie } }),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain(
      `<input type="text" name="user_code" value="${started.user_code}" autocomplete="off"`,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain('name="decision"');
    expect((await deviceRows(h))[0]?.status).toBe("pending");
    // A value of another form leaves the field empty.
    const odd = await h.auth.handle(
      new Request(`${DEVICE_URL}?user_code=%22%3E%3Cb%3E`, { headers: { cookie: s.cookie } }),
    );
    expect(await odd.text()).toContain('name="user_code" value=""');
  });

  it("upper-cases the input and drops every character outside the alphabet", async () => {
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode(" b c d f  g h j k ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BAC.DEF:GHIJOK")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJKL")).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
    const h = instance();
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const started = await start(h, clientId, "mcp:read");
    const letters = started.user_code.replace("-", "");
    const typed = `${letters.slice(0, 3).toLowerCase()} e ${letters.slice(3).toLowerCase()}!`;
    const page = await h.auth.handle(pagePost(s.cookie, { user_code: typed }));
    const html = await page.text();
    expect(html).toContain('name="decision" value="allow"');
    expect(html).toContain(`<input type="hidden" name="user_code" value="${started.user_code}">`);
  });

  it("shows the warning line on the consent page (RFC 8628 5.4)", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const started = await start(h, clientId, "mcp:read");
    const page = await h.auth.handle(pagePost(s.cookie, { user_code: started.user_code }));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('<p class="warn">Approve only a device that is in front of you.</p>');
    expect(html).toContain("Allow Living room TV on a device to use your");
    expect(html).toContain(`Client id: <code>${clientId}</code>`);
    expect(html).toContain(`<code>${started.user_code}</code>`);
    expect(html).toContain("Read your documents <code>mcp:read</code>");
    expect(html).toContain(`For <code>${RESOURCE}</code>.`);
    expect(html).not.toContain("<script");
    // A custom page gets the same input.
    const seen: unknown[] = [];
    const custom = instance(h, {
      devicePage: (input) => {
        seen.push(input);
        return "<p>custom</p>";
      },
    });
    const res = await custom.auth.handle(pagePost(s.cookie, { user_code: started.user_code }));
    expect(await res.text()).toBe("<p>custom</p>");
    expect(seen[0]).toMatchObject({
      step: "consent",
      clientName: "Living room TV",
      clientId,
      userCode: started.user_code,
      warning: "Approve only a device that is in front of you.",
      fields: { user_code: started.user_code },
    });
  });

  it("stores a keyed hash of the user code under the current secret version, and finds it after a second version is added", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const started = await start(h, clientId, "mcp:read");
    const letters = started.user_code.replace("-", "");
    const [row] = await deviceRows(h);
    expect(row?.secretVersion).toBe(1);
    expect(row?.userCodeHash).toBe(await hmacHex(SECRET_1, letters));
    // A second version becomes current on another instance over the same storage.
    const secrets: SecretVersion[] = [
      { version: 2, value: SECRET_2 },
      { version: 1, value: SECRET_1 },
    ];
    const rotated = instance(h, {}, { secrets });
    expect((await findUserCode(rotated.config, started.user_code))?.id).toBe(row?.id);
    const s = await signedIn(rotated);
    const page = await rotated.auth.handle(pagePost(s.cookie, { user_code: started.user_code }));
    expect(await page.text()).toContain('name="decision" value="allow"');
    // A new code keys under version 2.
    const next = await start(rotated, clientId, "mcp:read");
    const fresh = (await deviceRows(h)).find((r) => r.id !== row?.id);
    expect(fresh?.secretVersion).toBe(2);
    expect(fresh?.userCodeHash).toBe(await hmacHex(SECRET_2, next.user_code.replace("-", "")));
    // The keyed hash differs by secret value: an instance with version 1 only finds no row of version 2.
    expect(await findUserCode(h.config, next.user_code)).toBeNull();
  });

  it("limits the code form to 5 per session per 15 minutes", async () => {
    const h = instance();
    const other = instance(h);
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const started = await start(h, clientId, "mcp:read");
    const wrong = started.user_code === "BBBB-BBBB" ? "CCCC-CCCC" : "BBBB-BBBB";
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const at = i % 2 === 0 ? h : other;
      const res = await at.auth.handle(pagePost(s.cookie, { user_code: wrong }));
      statuses.push(res.status);
      if (res.status === 429) expect(await res.json()).toEqual({ error: "rate_limited" });
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5).every((x) => x === 429)).toBe(true);
    // The right code from the same session is refused too, and no code is approved.
    const right = await h.auth.handle(
      pagePost(s.cookie, { user_code: started.user_code, decision: "allow" }),
    );
    expect(right.status).toBe(429);
    expect((await deviceRows(h)).map((r) => r.status)).toEqual(["pending"]);
    // After 15 minutes the session may try again.
    h.clock.advance(900_000);
    const later = await h.auth.handle(pagePost(s.cookie, { user_code: started.user_code }));
    expect(later.status).toBe(200);
  });

  it("holds one session to 9 guesses in the life of a 10-minute code (ruling 48)", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const guess = async () =>
      (await h.auth.handle(pagePost(s.cookie, { user_code: "BBBB-BBBB" }))).status;
    // One form opens the session window 899 s before the code starts.
    expect(await guess()).toBe(200);
    h.clock.advance(899_000);
    const started = await start(h, clientId, "mcp:read");
    expect(started.user_code).not.toBe("BBBB-BBBB");
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push(await guess());
    // The first window ends, and a second one opens in the life of the code.
    h.clock.advance(1_000);
    for (let i = 0; i < 6; i++) statuses.push(await guess());
    expect(statuses).toEqual([200, 200, 200, 200, 429, 200, 200, 200, 200, 200, 429]);
    // The second window lasts past the end of the code: no more guess reaches it.
    h.clock.advance(598_000);
    expect(await guess()).toBe(429);
    expect(statuses.filter((x) => x === 200)).toHaveLength(9);
  });

  it("limits the code form to 20 per IP and one found code to 10 per 15 minutes", async () => {
    const h = instance(undefined, {}, { clientIp: () => "203.0.113.9" });
    const clientId = await deviceClient(h);
    const started = await start(h, clientId, "mcp:read");
    // Ten sessions see the consent of one code; the eleventh is refused.
    const sessions = [];
    for (let i = 0; i < 12; i++) sessions.push(await signedIn(h, `p${i}@example.com`));
    const seen: number[] = [];
    for (const s of sessions.slice(0, 11))
      seen.push((await h.auth.handle(pagePost(s.cookie, { user_code: started.user_code }))).status);
    expect(seen).toEqual([...Array(10).fill(200), 429]);
    // Nine more forms from the IP fill its 20, each from a session under its own count.
    const wrong = { user_code: started.user_code === "BBBB-BBBB" ? "CCCC-CCCC" : "BBBB-BBBB" };
    const form9 = [11, 11, 11, 11, 11, 0, 1, 2, 3];
    for (const i of form9)
      expect((await h.auth.handle(pagePost(sessions[i]?.cookie ?? "", wrong))).status).toBe(200);
    // The 21st form of the IP is refused, from a session that sent one form only.
    const over = await h.auth.handle(pagePost(sessions[4]?.cookie ?? "", wrong));
    expect(await answer(over)).toEqual({ status: 429, body: { error: "rate_limited" } });
  });

  it("sends a browser with no session to the sign-in step with a held request", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const started = await start(h, clientId, "mcp:read");
    // Core's sign-in page lands back on the device page with the code.
    const res = await h.auth.handle(new Request(started.verification_uri_complete));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/oauth/sign-in`);
    const next = `/auth/oauth/device?user_code=${started.user_code}`;
    expect(location.searchParams.get("next")).toBe(next);
    const signIn = await h.auth.handle(new Request(location.toString()));
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("content-type")).toContain("text/html");
    const bare = await h.auth.handle(new Request(DEVICE_URL));
    expect(new URL(bare.headers.get("location") ?? "").searchParams.get("next")).toBe(
      "/auth/oauth/device",
    );
    // The sign-in route takes the device page only in these two forms.
    const refused = [
      "/auth/oauth/device?user_code=BCDF-GHJ",
      "/auth/oauth/device?user_code=BCDFGHJK",
      "/auth/oauth/device?user_code=AEIO-UAEI",
      `/auth/oauth/device?user_code=${started.user_code}&x=1`,
      "/auth/oauth/device/x",
      "/auth/oauth/devices",
      "/auth/oauth/grants",
    ];
    for (const n of refused) {
      const r = await h.auth.handle(
        new Request(`${ISSUER}/oauth/sign-in?next=${encodeURIComponent(n)}`),
      );
      expect(r.status, n).toBe(302);
      expect(r.headers.get("location"), n).toContain("auth_error=invalid_request");
    }
    // With the app's own sign-in route: a held row with no user code, then back to the page.
    const app = instance(h, { signInURL: `${APP_ORIGIN}/sign-in` });
    const held = await app.auth.handle(new Request(started.verification_uri_complete));
    const at = new URL(held.headers.get("location") ?? "");
    expect(`${at.origin}${at.pathname}`).toBe(`${APP_ORIGIN}/sign-in`);
    const requestId = at.searchParams.get("request_id") ?? "";
    expect(requestId).toMatch(/^oq_/);
    const rows = await h.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "oauth-request" },
    ]);
    expect(rows.map((r) => r.data)).toEqual([
      { params: "device=1", userId: null, minAuthTime: null },
    ]);
    expect(JSON.stringify(rows)).not.toContain(started.user_code.replace("-", ""));
    const back = `${ISSUER}/oauth/authorize?request_id=${requestId}`;
    // Still no session: the sign-in step again.
    const noSession = await app.auth.handle(new Request(back));
    expect(noSession.headers.get("location")).toBe(at.toString());
    const s = await signedIn(app);
    const after = await app.auth.handle(new Request(back, { headers: { cookie: s.cookie } }));
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe(DEVICE_URL);
    // The held row ends with its one use.
    const twice = await app.auth.handle(new Request(back, { headers: { cookie: s.cookie } }));
    expect(await answer(twice)).toEqual({ status: 400, body: { error: "invalid_request" } });
  });

  it("counts each GET with no session on the authorize key, before a held row (ruling 48)", async () => {
    const h = instance(
      undefined,
      { signInURL: `${APP_ORIGIN}/sign-in` },
      {
        clientIp: () => "203.0.113.7",
      },
    );
    const held = () =>
      h.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "oauth-request" }]);
    for (let i = 0; i < 60; i++)
      expect((await h.auth.handle(new Request(DEVICE_URL))).status).toBe(302);
    expect(await held()).toHaveLength(60);
    expect(await answer(await h.auth.handle(new Request(DEVICE_URL)))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    expect(await held()).toHaveLength(60);
    // The authorize step of the same IP shares the count.
    const clientId = await deviceClient(h);
    const authorize = await h.auth.handle(
      new Request(
        `${ISSUER}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId })}`,
      ),
    );
    expect(await answer(authorize)).toEqual({ status: 429, body: { error: "rate_limited" } });
    // A signed-in person still gets the page: the count is for a request that holds a row.
    const s = await signedIn(h);
    const page = await h.auth.handle(new Request(DEVICE_URL, { headers: { cookie: s.cookie } }));
    expect(page.status).toBe(200);
  });

  it("needs Origin equal to baseURL on the POST", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const started = await start(h, clientId, "mcp:read");
    const body = { user_code: started.user_code, decision: "allow" };
    // A trusted origin passes the router and still is not the page's own origin.
    for (const origin of [APP_ORIGIN, "https://evil.example.com"]) {
      const res = await h.auth.handle(pagePost(s.cookie, body, origin));
      expect(await answer(res)).toEqual({ status: 403, body: { error: "origin_not_trusted" } });
    }
    const none = await h.auth.handle(form(DEVICE_URL, body, { cookie: s.cookie }));
    expect(await answer(none)).toEqual({ status: 403, body: { error: "origin_not_trusted" } });
    const noSession = await h.auth.handle(form(DEVICE_URL, body, { origin: BASE_URL }));
    expect(await answer(noSession)).toEqual({ status: 401, body: { error: "unauthorized" } });
    const json = await h.auth.handle(
      new Request(DEVICE_URL, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL, cookie: s.cookie },
        body: JSON.stringify(body),
      }),
    );
    expect(await answer(json)).toEqual({ status: 400, body: { error: "invalid_request" } });
    const odd = await h.auth.handle(pagePost(s.cookie, { ...body, decision: "maybe" }));
    expect(await answer(odd)).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect((await deviceRows(h))[0]?.status).toBe("pending");
  });

  it("refuses an unverified user and decides nothing", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const s = await signedIn(h, "new@example.com", false);
    const started = await start(h, clientId, "mcp:read");
    const res = await h.auth.handle(
      pagePost(s.cookie, { user_code: started.user_code, decision: "allow" }),
    );
    expect(await res.text()).toContain("Verify your email address before you connect a device.");
    expect((await deviceRows(h))[0]?.status).toBe("pending");
  });

  it("serves no device route while oauth.device is off", async () => {
    const h = instance(undefined, { device: false });
    const res = await h.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", DEVICE_GRANT],
      }),
    );
    expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_client_metadata" } });
    const s = await signedIn(h);
    for (const req of [
      form(START_URL, { client_id: "cl_x", scope: "mcp:read", resource: RESOURCE }),
      new Request(DEVICE_URL, { headers: { cookie: s.cookie } }),
      pagePost(s.cookie, { user_code: "BCDF-GHJK" }),
    ])
      expect((await h.auth.handle(req)).status).toBe(404);
    const grant = await h.auth.handle(poll("cl_x", `od_${"a".repeat(43)}`));
    expect(await answer(grant)).toEqual({ status: 400, body: { error: "unsupported_grant_type" } });
    const signIn = await h.auth.handle(
      new Request(`${ISSUER}/oauth/sign-in?next=${encodeURIComponent("/auth/oauth/device")}`),
    );
    expect(signIn.headers.get("location")).toContain("auth_error=invalid_request");
  });

  it("accepts the device grant URN in a client grant list when oauth.device is on", async () => {
    const h = instance();
    const res = await h.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", DEVICE_GRANT],
      }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { grant_types: string[] }).grant_types).toEqual([
      "authorization_code",
      DEVICE_GRANT,
    ]);
    const clients = h.auth.api.oauth?.clients;
    if (!clients) throw new Error("oauth is off");
    const made = await clients.create({
      redirectUris: [REDIRECT],
      grantTypes: ["authorization_code", DEVICE_GRANT],
    });
    expect(made.ok && made.value.client.grantTypes).toEqual(["authorization_code", DEVICE_GRANT]);
  });

  it("refuses the device grant for a pairwise client", async () => {
    const h = instance();
    const pairwise = {
      redirect_uris: [REDIRECT],
      subject_type: "pairwise",
      grant_types: ["authorization_code", DEVICE_GRANT],
    };
    const res = await h.auth.handle(post("/auth/oauth/register", pairwise));
    expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_client_metadata" } });
    const clients = h.auth.api.oauth?.clients;
    if (!clients) throw new Error("oauth is off");
    const made = await clients.create({
      redirectUris: [REDIRECT],
      subjectType: "pairwise",
      grantTypes: ["authorization_code", DEVICE_GRANT],
    });
    expect(made).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    // An update cannot add the grant to a pairwise client, nor make a device client pairwise.
    const pw = await clients.create({ redirectUris: [REDIRECT], subjectType: "pairwise" });
    if (!pw.ok) throw new Error(pw.error);
    const add = await clients.update({
      clientId: pw.value.client.id,
      grantTypes: ["authorization_code", DEVICE_GRANT],
    });
    expect(add).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    const dev = await deviceClient(h);
    expect(await clients.update({ clientId: dev, subjectType: "pairwise" })).toMatchObject({
      ok: false,
      error: "invalid_client_metadata",
    });
  });

  it("keeps the device grant of a metadata document, and drops it for a pairwise one", async () => {
    const docs = new Map<string, Record<string, unknown>>();
    const fetchFn = (async (input: RequestInfo | URL) => {
      const doc = docs.get(String(input));
      if (!doc) throw new Error(`no fake answer for ${String(input)}`);
      return new Response(JSON.stringify(doc), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const h = instance(undefined, { registration: { cimd: true, dynamic: true }, fetch: fetchFn });
    const doc = (id: string, extra: Record<string, unknown> = {}) => {
      docs.set(id, {
        client_id: id,
        client_name: "Doc client",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", DEVICE_GRANT],
        ...extra,
      });
      return id;
    };
    const plain = doc("https://client.example.com/device.json");
    expect((await start(h, plain, "mcp:read")).user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    const pairwise = doc("https://client.example.com/pairwise.json", { subject_type: "pairwise" });
    const res = await h.auth.handle(
      form(START_URL, { client_id: pairwise, scope: "mcp:read", resource: RESOURCE }),
    );
    expect(await answer(res)).toEqual({ status: 400, body: { error: "unauthorized_client" } });
    expect(
      (await h.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: pairwise }]))
        ?.grantTypes,
    ).toEqual(["authorization_code"]);
  });

  it("refuses a poll from a client that lost the device grant, and keeps the row", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const deviceCode = await approvedDevice(h, clientId, s.cookie);
    const clients = h.auth.api.oauth?.clients;
    if (!clients) throw new Error("oauth is off");
    const lost = await clients.update({ clientId, grantTypes: ["authorization_code"] });
    if (!lost.ok) throw new Error(lost.error);
    h.clock.advance(5_000);
    expect(await answer(await h.auth.handle(poll(clientId, deviceCode)))).toEqual({
      status: 400,
      body: { error: "unauthorized_client" },
    });
    expect((await deviceRows(h)).map((r) => r.status)).toEqual(["approved"]);
    // A metadata document that drops the grant refuses the poll too.
    const docs = new Map<string, Record<string, unknown>>();
    const fetchFn = (async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(docs.get(String(input))), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const cimd = { registration: { cimd: true, dynamic: true }, fetch: fetchFn };
    const url = "https://client.example.com/device.json";
    const doc = (grants: string[]) => ({
      client_id: url,
      client_name: "Doc client",
      redirect_uris: [REDIRECT],
      grant_types: grants,
    });
    docs.set(url, doc(["authorization_code", DEVICE_GRANT]));
    const a = instance(undefined, cimd);
    const docCode = await approvedDevice(a, url, (await signedIn(a)).cookie);
    docs.set(url, doc(["authorization_code"]));
    const b = instance(a, cimd);
    a.clock.advance(5_000);
    expect(await answer(await b.auth.handle(poll(url, docCode)))).toEqual({
      status: 400,
      body: { error: "unauthorized_client" },
    });
    expect((await deviceRows(a)).map((r) => r.status)).toEqual(["approved"]);
  });

  it("deletes expired device rows at the sweep", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const spent = await start(h, clientId, "mcp:read");
    await decide(h, s.cookie, spent.user_code, "allow");
    expect((await h.auth.handle(poll(clientId, spent.device_code))).status).toBe(200);
    await start(h, clientId, "mcp:read");
    h.clock.advance(300_000);
    const young = await start(h, clientId, "mcp:read");
    expect((await deviceRows(h)).length).toBe(3);
    h.clock.advance(300_001);
    const swept = await sweepExpired(h.config);
    expect(swept.oauthDevices).toBe(2);
    const left = await deviceRows(h);
    expect(left.length).toBe(1);
    expect(left[0]?.expiresAt.getTime()).toBe(h.clock.now().getTime() + 299_999);
    expect((await answer(await h.auth.handle(poll(clientId, young.device_code)))).body).toEqual({
      error: "authorization_pending",
    });
    // The row of a swept code is gone: its poll answers invalid_grant.
    expect((await answer(await h.auth.handle(poll(clientId, spent.device_code)))).body).toEqual({
      error: "invalid_grant",
    });
  });

  it("limits the device authorization request to 30 per IP per 15 minutes, a failed auth too (spec 8.16 item 13)", async () => {
    const h = instance(undefined, {}, { clientIp: () => "203.0.113.8" });
    const clientId = await deviceClient(h);
    const startOf = (id: string) =>
      h.auth.handle(form(START_URL, { client_id: id, scope: "mcp:read", resource: RESOURCE }));
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++)
      statuses.push((await startOf(i % 2 === 0 ? clientId : "cl_unknown")).status);
    expect(statuses).toEqual(Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 200 : 400)));
    expect(await answer(await startOf(clientId))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    // Another IP has its own count.
    const other = instance(h, {}, { clientIp: () => "203.0.113.9" });
    expect(
      (
        await other.auth.handle(
          form(START_URL, { client_id: clientId, scope: "mcp:read", resource: RESOURCE }),
        )
      ).status,
    ).toBe(200);
    h.clock.advance(900_000);
    expect((await startOf(clientId)).status).toBe(200);
  });

  it("draws each user code from the alphabet", async () => {
    const h = instance();
    const clientId = await deviceClient(h);
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const { user_code } = await start(h, clientId, "mcp:read");
      for (const c of user_code.replace("-", "")) seen.add(c);
    }
    expect([...seen].every((c) => ALPHABET.includes(c))).toBe(true);
    expect(seen.size).toBeGreaterThan(10);
  });
});

describe("the poll count of a device code (review M1 of plan 12e, RFC 8628 3.5)", () => {
  const IP = { clientIp: () => "203.0.113.7" };
  const UNKNOWN = `od_${"A".repeat(43)}`;

  it("lets a device poll at its interval for 9 minutes and gives the tokens of an approval then", async () => {
    const h = instance(undefined, {}, IP);
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const started = await start(h, clientId, "mcp:read");
    const seen = new Set<string>();
    // 108 polls, one each 5 seconds: more than the 60 of oauth-token:ip.
    for (let t = 0; t < 540; t += 5) {
      const a = await answer(await h.auth.handle(poll(clientId, started.device_code)));
      seen.add(`${a.status} ${String(a.body.error)}`);
      h.clock.advance(5_000);
    }
    expect([...seen]).toEqual(["400 authorization_pending"]);
    await decide(h, s.cookie, started.user_code, "allow");
    const tokens = await answer(await h.auth.handle(poll(clientId, started.device_code)));
    expect(tokens.status).toBe(200);
    expect(tokens.body.access_token).toEqual(expect.any(String));
  });

  it("spends no token budget of another client on the IP over a whole code life", async () => {
    const h = instance(undefined, {}, IP);
    const clientId = await deviceClient(h);
    const other = await deviceClient(h);
    const started = await start(h, clientId, "mcp:read");
    const seen: string[] = [];
    for (let t = 0; t <= 600; t += 5) {
      seen.push(
        String((await answer(await h.auth.handle(poll(clientId, started.device_code)))).body.error),
      );
      h.clock.advance(5_000);
    }
    expect(seen.slice(0, 120).every((e) => e === "authorization_pending")).toBe(true);
    expect(seen.slice(120)).toEqual(["expired_token"]);
    // The other client still has all 60 requests of oauth-token:ip.
    const refresh = () =>
      h.auth.handle(
        tokenPost({
          grant_type: "refresh_token",
          refresh_token: `or_${"B".repeat(43)}`,
          client_id: other,
        }),
      );
    for (let i = 0; i < 60; i++)
      expect(await answer(await refresh())).toEqual({
        status: 400,
        body: { error: "invalid_grant" },
      });
    expect(await answer(await refresh())).toEqual({ status: 429, body: { error: "rate_limited" } });
  });

  it("counts a poll of an unknown device code on oauth-token:ip, and a known code on its own key", async () => {
    const h = instance(undefined, {}, IP);
    const clientId = await deviceClient(h);
    const started = await start(h, clientId, "mcp:read");
    for (let i = 0; i < 30; i++) {
      expect((await answer(await h.auth.handle(poll(clientId, UNKNOWN)))).body).toEqual({
        error: "invalid_grant",
      });
      expect((await answer(await h.auth.handle(poll(clientId, "od_short")))).body).toEqual({
        error: "invalid_grant",
      });
    }
    expect(await answer(await h.auth.handle(poll(clientId, UNKNOWN)))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    // A guess costs, and the device of a known code still polls.
    expect((await answer(await h.auth.handle(poll(clientId, started.device_code)))).body).toEqual({
      error: "authorization_pending",
    });
  });

  it("counts a poll of a known code under another client id on oauth-token:ip (review n1)", async () => {
    const h = instance(undefined, {}, IP);
    const owner = await deviceClient(h);
    const other = await deviceClient(h, { token_endpoint_auth_method: "client_secret_post" });
    const started = await start(h, owner, "mcp:read");
    const wrongSecret = () =>
      h.auth.handle(
        tokenPost({
          grant_type: DEVICE_GRANT,
          device_code: started.device_code,
          client_id: other,
          client_secret: `cs_${"C".repeat(43)}`,
        }),
      );
    for (let i = 0; i < 60; i++)
      expect(await answer(await wrongSecret())).toEqual({
        status: 400,
        body: { error: "invalid_client" },
      });
    expect(await answer(await wrongSecret())).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    // The owner of the code still polls on the key of its code.
    expect((await answer(await h.auth.handle(poll(owner, started.device_code)))).body).toEqual({
      error: "authorization_pending",
    });
  });

  it("counts a Basic poll of the code's own client on the code key, and its failed auth on oauth-token:ip too", async () => {
    const h = instance(undefined, {}, IP);
    const reg = await h.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        client_name: "Secret TV",
        grant_types: [DEVICE_GRANT],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    );
    const { client_id: owner, client_secret: secret } = (await reg.json()) as {
      client_id: string;
      client_secret: string;
    };
    const other = await deviceClient(h);
    const started = await start(h, owner, "mcp:read", {
      authorization: basicHeader(owner, secret),
    });
    const pollAs = (key: string) =>
      h.auth.handle(
        tokenPost(
          { grant_type: DEVICE_GRANT, device_code: started.device_code },
          { authorization: basicHeader(owner, key) },
        ),
      );
    // 70 polls at the interval: more than the 60 of oauth-token:ip, so they count on the code key.
    for (let i = 0; i < 70; i++) {
      expect((await answer(await pollAs(secret))).body).toEqual({ error: "authorization_pending" });
      h.clock.advance(5_000);
    }
    for (let i = 0; i < 60; i++)
      expect((await answer(await pollAs(`cs_${"D".repeat(43)}`))).body).toEqual({
        error: "invalid_client",
      });
    // The 60 failed auths spent oauth-token:ip, so a request of another client meets the limit.
    expect(
      await answer(
        await h.auth.handle(
          tokenPost({
            grant_type: "refresh_token",
            refresh_token: `or_${"B".repeat(43)}`,
            client_id: other,
          }),
        ),
      ),
    ).toEqual({ status: 429, body: { error: "rate_limited" } });
  });

  it("holds one code to 130 polls in its life: the polls past the cap answer slow_down and change nothing", async () => {
    const h = instance(undefined, {}, IP);
    const clientId = await deviceClient(h);
    const started = await start(h, clientId, "mcp:read");
    const seen: string[] = [];
    for (let i = 0; i < 140; i++)
      seen.push(
        String((await answer(await h.auth.handle(poll(clientId, started.device_code)))).body.error),
      );
    expect(seen[0]).toBe("authorization_pending");
    expect(seen.slice(1).every((e) => e === "slow_down")).toBe(true);
    // Polls 2 to 130 each add 5 seconds; polls 131 to 140 reach no row.
    expect((await deviceRows(h))[0]?.interval).toBe(650);
  });
});

describe("the end of a decided device code (plan 12e Task 14, ruling 44 S4)", () => {
  const OAUTH = {
    resources: [RESOURCE],
    scopes: SCOPES,
    registration: { cimd: false, dynamic: true },
    device: {},
  };

  /** A user who approved a device code of a device client, and the poll request of the code. */
  async function approved() {
    const h = pwHandle({ hash: FAST }, { oauth: OAUTH });
    const clientId = await deviceClient(h);
    const s = await signedIn(h);
    const deviceCode = await approvedDevice(h, clientId, s.cookie, "mcp:read offline_access");
    // A second code that nobody decided: a pending row names no user, so it stays.
    const pending = await start(h, clientId, "mcp:read");
    return { h, clientId, s, deviceCode, pending };
  }

  async function resetByLink(h: ReturnType<typeof pwHandle>, email: string) {
    await requestPasswordReset(h.config, { email, ip: null });
    const r = await resetPassword(h.config, {
      token: h.mails.at(-1)?.token ?? "",
      password: "a new long password",
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
  }

  const rowsOf = async (h: ReturnType<typeof pwHandle>, userId: string | null) =>
    h.storage.findMany("oauthDevice", [{ field: "userId", op: "eq", value: userId }]);

  it("deletes the user's decided device rows at a reset, a change, and a grant revoke", async () => {
    const ends = [
      async (a: Awaited<ReturnType<typeof approved>>) => resetByLink(a.h, emailOf(a.s.user)),
      async (a: Awaited<ReturnType<typeof approved>>) => {
        const session = await resolveSession(a.h.config, a.s.token);
        if (!session) throw new Error("no session");
        const r = await changePassword(a.h.config, { session, newPassword: "a new long password" });
        if (!r.ok) throw new Error(r.code);
      },
      async (a: Awaited<ReturnType<typeof approved>>) => {
        const r = await revokeGrant(a.h.config, { userId: a.s.user.id, clientId: a.clientId });
        if (!r.ok) throw new Error(r.code);
      },
    ];
    for (const end of ends) {
      const a = await approved();
      expect((await rowsOf(a.h, a.s.user.id)).map((r) => r.status)).toEqual(["approved"]);
      await end(a);
      expect(await rowsOf(a.h, a.s.user.id)).toEqual([]);
      expect((await rowsOf(a.h, null)).map((r) => r.status)).toEqual(["pending"]);
      a.h.clock.advance(5_000);
      expect(await answer(await a.h.auth.handle(poll(a.clientId, a.deviceCode)))).toEqual({
        status: 400,
        body: { error: "invalid_grant" },
      });
      expect(await a.h.storage.findMany("oauthToken", [])).toEqual([]);
    }
  });

  it("keeps the device rows of another client at a grant revoke", async () => {
    const a = await approved();
    const other = await deviceClient(a.h);
    const kept = await approvedDevice(a.h, other, a.s.cookie, "mcp:read");
    const r = await revokeGrant(a.h.config, { userId: a.s.user.id, clientId: a.clientId });
    if (!r.ok) throw new Error(r.code);
    expect((await rowsOf(a.h, a.s.user.id)).map((row) => [row.clientId, row.status])).toEqual([
      [other, "approved"],
    ]);
    a.h.clock.advance(5_000);
    expect((await a.h.auth.handle(poll(other, kept))).status).toBe(200);
  });

  it("refuses the tokens of a poll when a reset runs between its spend and its token write", async () => {
    const a = await approved();
    const store = a.h.storage as StorageAdapter;
    const create = store.create.bind(store);
    let gate = true;
    // The reset commits, and ends the families it sees, before the poll writes its refresh row.
    (store as { create: StorageAdapter["create"] }).create = (async (model, data) => {
      if (model === "oauthToken" && gate) {
        gate = false;
        await resetByLink(a.h, emailOf(a.s.user));
      }
      return create(model, data);
    }) as StorageAdapter["create"];
    a.h.clock.advance(5_000);
    expect(await answer(await a.h.auth.handle(poll(a.clientId, a.deviceCode)))).toEqual({
      status: 400,
      body: { error: "invalid_grant" },
    });
    expect(gate).toBe(false);
    // The consent stays after a reset, so only the read of the device row refuses the grant.
    expect(await a.h.storage.findMany("oauthConsent", [])).toHaveLength(1);
    expect(await a.h.storage.findMany("oauthToken", [])).toEqual([]);
  });
});
