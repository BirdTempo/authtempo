import { createPbkdf2PasswordHash } from "@authtempo/core";
import { createRecordingSms, SoftAuthenticator } from "@authtempo/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import { type BrowserWebAuthn, base64UrlDecode, base64UrlEncode } from "../src/webauthn.js";
import { APP_ORIGIN, BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

/**
 * The client calls of the sign-in additions (plan 12i Task 15), each
 * against a real core instance through the client's transport. A
 * signal of the Signal API goes to a stub of `PublicKeyCredential`.
 */

const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const PW = "correct horse battery";
const RP = { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A seam over the soft authenticator. It keeps each options object that the client gave it. */
function softSeam(soft: SoftAuthenticator) {
  const seen: { create: unknown[]; get: unknown[] } = { create: [], get: [] };
  const seam: BrowserWebAuthn = {
    async create(options) {
      seen.create.push(options);
      // The user handle of the options: a passkey-first user is found by it at a sign-in.
      return soft.register(options.challenge, new Uint8Array(base64UrlDecode(options.user.id)));
    },
    async get(options) {
      seen.get.push(options);
      return soft.authenticate(options.challenge);
    },
  };
  return { seam, seen };
}

/** A fetch over `inner` that keeps each request's method, URL, and body. */
function spied(inner: typeof fetch) {
  const requests: { method: string; url: string; body: string }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push({ method: req.method, url: req.url, body: await req.clone().text() });
    return inner(req);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

/** A stub of `PublicKeyCredential` with the three Signal API methods, each a spy. */
function stubSignals() {
  const pkc = {
    signalUnknownCredential: vi.fn(async () => {}),
    signalAllAcceptedCredentials: vi.fn(async () => {}),
    signalCurrentUserDetails: vi.fn(async () => {}),
  };
  vi.stubGlobal("PublicKeyCredential", pkc);
  return pkc;
}

/** A client signed in by a magic link in its own cookie jar. */
async function signedIn(server: ReturnType<typeof makeServer>, webauthn?: BrowserWebAuthn) {
  const { fetch, jar } = inProcessFetch(server.auth);
  const spy = spied(fetch);
  const client = createClient({
    baseURL: BASE_URL,
    fetch: spy.fetch,
    ...(webauthn ? { webauthn } : {}),
    cookies: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
  });
  const req = await client.magicLink.request({ email: "ada@example.com" });
  if (!req.ok) throw new Error(req.code);
  const v = await client.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
  if (!v.ok) throw new Error(v.code);
  return { client, jar, requests: spy.requests };
}

/** An RS256 key, its public JWK under kid k1, and a signer of compact JWTs. */
async function signer() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const { kty, n, e } = await crypto.subtle.exportKey("jwk", publicKey);
  const jwk = { kty, n, e, kid: "k1", alg: "RS256", use: "sig" };
  const part = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v)));
  async function sign(claims: Record<string, unknown>): Promise<string> {
    const input = `${part({ alg: "RS256", kid: "k1", typ: "JWT" })}.${part(claims)}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(input),
    );
    return `${input}.${base64UrlEncode(sig)}`;
  }
  return { jwk, sign };
}

describe("the client calls of the sign-in additions (plan 12i Task 15)", () => {
  it("passkey.signUp makes an account by a new passkey and opens its session, with the hints", async () => {
    const server = makeServer({
      passkey: { ...RP, signUp: { isolateLimiter: "allow" } },
      lastMethod: {},
    });
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const { seam, seen } = softSeam(soft);
    const { fetch } = inProcessFetch(server.auth);
    const spy = spied(fetch);
    const client = createClient({ baseURL: BASE_URL, fetch: spy.fetch, webauthn: seam });
    const up = await client.passkey.signUp({ name: "Ada", hints: ["client-device"] });
    expect(up).toMatchObject({
      ok: true,
      value: { user: { email: null, name: "Ada" }, via: "passkey" },
    });
    expect(JSON.parse(spy.requests[0]?.body ?? "")).toEqual({
      name: "Ada",
      hints: ["client-device"],
    });
    expect(seen.create[0]).toMatchObject({ hints: ["client-device"] });
    const s = await client.session();
    expect(s.ok && s.value?.user.name).toBe("Ada");
    // The new passkey is the account's way in.
    const again = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: seam,
    });
    expect(await again.passkey.signIn()).toMatchObject({
      ok: true,
      value: { user: { name: "Ada" } },
    });
    // The server refuses a sign-up while the config is off.
    const off = makeServer({ passkey: RP });
    const closed = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(off.auth).fetch,
      webauthn: seam,
    });
    expect(await closed.passkey.signUp({ name: "Ada" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("passkey.register and passkey.signIn send the hints of one ceremony", async () => {
    const server = makeServer({ passkey: RP });
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const { seam, seen } = softSeam(soft);
    const { client, requests } = await signedIn(server, seam);
    const reg = await client.passkey.register({ name: "key", hints: ["security-key"] });
    expect(reg.ok).toBe(true);
    expect(seen.create[0]).toMatchObject({ hints: ["security-key"] });
    const s = await client.passkey.signIn({ hints: ["hybrid"] });
    expect(s.ok).toBe(true);
    expect(seen.get[0]).toMatchObject({ hints: ["hybrid"] });
    const bodies = requests
      .filter((r) => r.url.endsWith("/options"))
      .map((r) => JSON.parse(r.body) as unknown);
    expect(bodies).toEqual([{ hints: ["security-key"] }, { hints: ["hybrid"] }]);
    // A value of no hint is the server's invalid_body.
    expect(
      await client.passkey.signIn({ hints: ["phone"] as unknown as ["hybrid"] }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
  });

  it("passkey.signIn signals an unknown credential once, and makes no call without the method", async () => {
    const server = makeServer({ passkey: RP });
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const { seam } = softSeam(soft);
    const { client } = await signedIn(server, seam);
    const reg = await client.passkey.register();
    if (!reg.ok) throw new Error(reg.code);
    expect(await client.passkeys.delete({ id: reg.value.id })).toEqual({
      ok: true,
      value: { ok: true },
    });
    // No Signal API in this runtime: the answer passes through, and nothing throws.
    vi.stubGlobal("PublicKeyCredential", {});
    expect(await client.passkey.signIn()).toEqual({
      ok: false,
      code: "passkey_unknown",
      status: 400,
    });
    const pkc = stubSignals();
    expect(await client.passkey.signIn()).toEqual({
      ok: false,
      code: "passkey_unknown",
      status: 400,
    });
    expect(pkc.signalUnknownCredential).toHaveBeenCalledTimes(1);
    expect(pkc.signalUnknownCredential).toHaveBeenCalledWith({
      rpId: RP.rpID,
      credentialId: soft.credentialId,
    });
    // A signal that rejects is advice only: the answer stays, and nothing throws.
    pkc.signalUnknownCredential.mockRejectedValueOnce(new Error("SecurityError"));
    expect(await client.passkey.signIn()).toMatchObject({ code: "passkey_unknown" });
    // A sign-in that fails for another reason signals nothing.
    vi.stubGlobal("PublicKeyCredential", pkc);
    const other = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const registered = await client.passkey.register();
    expect(registered.ok).toBe(true);
    pkc.signalUnknownCredential.mockClear();
    const bad = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: {
        create: seam.create,
        // An assertion of a known credential with a signature of another key.
        async get(options) {
          const r = await other.authenticate(options.challenge);
          const known = await soft.authenticate(options.challenge);
          return { ...r, id: known.id, rawId: known.rawId };
        },
      },
    });
    expect(await bad.passkey.signIn()).toMatchObject({ ok: false, code: "passkey_failed" });
    expect(pkc.signalUnknownCredential).not.toHaveBeenCalled();
  });

  it("passkey.signalUnknown answers whether the browser has the method, and never throws", async () => {
    const client = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(makeServer().auth).fetch,
    });
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await client.passkey.signalUnknown({ rpId: "example.com", credentialId: "c1" })).toBe(
      false,
    );
    const pkc = stubSignals();
    expect(await client.passkey.signalUnknown({ rpId: "example.com", credentialId: "c1" })).toBe(
      true,
    );
    expect(pkc.signalUnknownCredential).toHaveBeenCalledWith({
      rpId: "example.com",
      credentialId: "c1",
    });
    pkc.signalUnknownCredential.mockRejectedValueOnce(new Error("SecurityError"));
    expect(await client.passkey.signalUnknown({ rpId: "example.com", credentialId: "c1" })).toBe(
      false,
    );
  });

  it("passkeys.sync gives the browser the passkeys that the server holds", async () => {
    const server = makeServer({ passkey: RP });
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const { client } = await signedIn(server, softSeam(soft).seam);
    expect((await client.passkey.register()).ok).toBe(true);
    const s = await client.session();
    const userId = s.ok ? (s.value?.user.id ?? "") : "";
    vi.stubGlobal("PublicKeyCredential", {});
    expect(await client.passkeys.sync()).toEqual({ ok: true, value: { signaled: false } });
    const pkc = stubSignals();
    expect(await client.passkeys.sync()).toEqual({ ok: true, value: { signaled: true } });
    expect(pkc.signalAllAcceptedCredentials).toHaveBeenCalledWith({
      rpId: RP.rpID,
      userId: base64UrlEncode(new TextEncoder().encode(userId)),
      allAcceptedCredentialIds: [soft.credentialId],
    });
    // With no session the read fails, and the browser hears nothing.
    pkc.signalAllAcceptedCredentials.mockClear();
    const anon = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    expect(await anon.passkeys.sync()).toMatchObject({ ok: false, code: "unauthorized" });
    expect(pkc.signalAllAcceptedCredentials).not.toHaveBeenCalled();
  });

  it("passkeys.signalDetails gives the browser the names of the registration options", async () => {
    const server = makeServer({ passkey: RP, username: {} });
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const { seam, seen } = softSeam(soft);
    const { client } = await signedIn(server, seam);
    expect((await client.user.update({ name: "Ada Lovelace" })).ok).toBe(true);
    expect((await client.username.set({ username: "Ada" })).ok).toBe(true);
    expect((await client.passkey.register()).ok).toBe(true);
    const options = seen.create[0] as { user: { id: string; name: string; displayName: string } };
    const pkc = stubSignals();
    expect(await client.passkeys.signalDetails()).toEqual({ ok: true, value: { signaled: true } });
    expect(pkc.signalCurrentUserDetails).toHaveBeenCalledWith({
      rpId: RP.rpID,
      userId: options.user.id,
      name: "ada",
      displayName: "Ada Lovelace",
    });
    expect(options.user).toMatchObject({ name: "ada", displayName: "Ada Lovelace" });
  });

  it("password.signIn takes a username or a phone in place of an address", async () => {
    const sms = createRecordingSms();
    const server = makeServer({
      password: { hash: FAST, uniformSignUp: false },
      username: {},
      phone: { sms, regions: ["+1"], isolateLimiter: "allow" },
      lastMethod: {},
    });
    const { fetch } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    const up = await client.password.signUp({
      email: "ada@example.com",
      password: PW,
      username: "Ada",
    });
    expect(up.ok).toBe(true);
    // The mailed verify link proves the address. A magic link would claim the
    // unverified account and clear the password (12b).
    expect(
      await client.password.verifyEmail({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") }),
    ).toEqual({ ok: true, value: { verified: true, passwordKept: true } });
    expect(await client.phone.add({ phone: "+14155550100" })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const code = /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect((await client.phone.verifyAdd({ code })).ok).toBe(true);
    const other = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    expect(await other.password.signIn({ username: "ada", password: PW })).toMatchObject({
      ok: true,
      value: { user: { email: "ada@example.com" }, via: "username" },
    });
    expect(await other.password.signIn({ phone: "+14155550100", password: PW })).toMatchObject({
      ok: true,
      value: { user: { email: "ada@example.com" }, via: "phone" },
    });
    expect(await other.signIn.password({ username: "ada", password: PW })).toMatchObject({
      ok: true,
      value: { kind: "session" },
    });
    expect(await other.password.signIn({ username: "nobody", password: PW })).toMatchObject({
      ok: false,
      code: "invalid_credentials",
    });
  });

  it("social.idToken signs in by a Google ID token with the nonce of social.idTokenNonce, and puts neither in a URL", async () => {
    const google = await signer();
    const server = makeServer({
      social: {
        google: { clientId: "web.apps.googleusercontent.com", clientSecret: "g" },
        fetch: async (input) =>
          String(input instanceof Request ? input.url : input) ===
          "https://www.googleapis.com/oauth2/v3/certs"
            ? Response.json({ keys: [google.jwk] })
            : new Response("not found", { status: 404 }),
      },
      lastMethod: {},
    });
    const { fetch } = inProcessFetch(server.auth);
    const spy = spied(fetch);
    const client = createClient({ baseURL: BASE_URL, fetch: spy.fetch });
    const n = await client.social.idTokenNonce({ provider: "google" });
    if (!n.ok) throw new Error(n.code);
    expect(n.value.providerNonce).toMatch(/^[0-9a-f]{64}$/);
    const now = Math.floor(server.clock.now().getTime() / 1000);
    const idToken = await google.sign({
      iss: "https://accounts.google.com",
      aud: "web.apps.googleusercontent.com",
      sub: "g-1",
      email: "ada@example.com",
      email_verified: true,
      name: "Ada",
      iat: now,
      exp: now + 600,
      nonce: n.value.providerNonce,
    });
    const r = await client.social.idToken({ provider: "google", idToken, nonce: n.value.nonce });
    expect(r).toMatchObject({
      ok: true,
      value: { user: { email: "ada@example.com" }, via: "social:google" },
    });
    // The token is spent: a replay is refused.
    const replay = await client.social.idToken({
      provider: "google",
      idToken,
      nonce: n.value.nonce,
    });
    expect(replay).toMatchObject({ ok: false, code: "invalid_token" });
    for (const req of spy.requests) {
      expect(req.url).not.toContain(idToken);
      expect(req.url).not.toContain(n.value.nonce);
      expect(req.url).not.toContain(n.value.providerNonce);
    }
    expect(spy.requests.map((q) => new URL(q.url).pathname)).toEqual([
      "/auth/social/google/id-token/nonce",
      "/auth/social/google/id-token",
      "/auth/social/google/id-token",
    ]);
    // oneTapNonce asks the nonce of google.
    const one = await client.social.oneTapNonce();
    expect(one.ok && one.value.providerNonce).toMatch(/^[0-9a-f]{64}$/);
    expect(new URL(spy.requests.at(-1)?.url ?? "").pathname).toBe(
      "/auth/social/google/id-token/nonce",
    );
    // A provider name that core refuses sends nothing.
    const sent = spy.requests.length;
    expect(await client.social.idTokenNonce({ provider: "../x" })).toEqual({
      ok: false,
      code: "invalid_body",
      status: 0,
    });
    expect(await client.social.idToken({ provider: "a/b", idToken })).toEqual({
      ok: false,
      code: "invalid_body",
      status: 0,
    });
    expect(spy.requests).toHaveLength(sent);
  });

  it("multiSession lists, switches, and ends the sessions of one browser, with no token in an answer", async () => {
    const server = makeServer({ multiSession: {} });
    const { fetch, jar } = inProcessFetch(server.auth);
    const client = createClient({ baseURL: BASE_URL, fetch });
    for (const email of ["ada@example.com", "bea@example.com"]) {
      await client.magicLink.request({ email });
      const v = await client.magicLink.verify({
        token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
      });
      if (!v.ok) throw new Error(v.code);
    }
    const list = await client.multiSession.list();
    if (!list.ok) throw new Error(list.code);
    expect(list.value.map((s) => [s.user.email, s.active]).sort()).toEqual([
      ["ada@example.com", false],
      ["bea@example.com", true],
    ]);
    const tokens = [...jar.values()];
    for (const token of tokens) expect(JSON.stringify(list.value)).not.toContain(token);
    const ada = list.value.find((s) => s.user.email === "ada@example.com");
    if (!ada) throw new Error("no session of ada");
    const switched = await client.multiSession.switch({ sessionId: ada.sessionId });
    expect(switched).toMatchObject({ ok: true, value: { user: { email: "ada@example.com" } } });
    const now = await client.session();
    expect(now.ok && now.value?.user.email).toBe("ada@example.com");
    const bea = list.value.find((s) => s.user.email === "bea@example.com");
    expect(await client.multiSession.signOut({ sessionId: bea?.sessionId ?? "" })).toEqual({
      ok: true,
      value: { ok: true },
    });
    const left = await client.multiSession.list();
    expect(left.ok && left.value.map((s) => s.user.email)).toEqual(["ada@example.com"]);
    // A bearer token is refused: the routes read the browser's cookies only.
    const bearer = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      token: () => "ts_not_a_cookie",
    });
    expect(await bearer.multiSession.list()).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("multiSession.switch and multiSession.signOut make the store read the new active user", async () => {
    const server = makeServer({ multiSession: {} });
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    for (const email of ["ada@example.com", "bea@example.com"]) {
      await client.magicLink.request({ email });
      const v = await client.magicLink.verify({
        token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
      });
      if (!v.ok) throw new Error(v.code);
    }
    const stop = client.store.subscribe(() => {});
    await vi.waitFor(() => expect(client.store.get().data?.user.email).toBe("bea@example.com"));
    const list = await client.multiSession.list();
    if (!list.ok) throw new Error(list.code);
    const ada = list.value.find((s) => s.user.email === "ada@example.com");
    if (!ada) throw new Error("no session of ada");
    // A switch makes the store read again: the page shows ada, not bea.
    expect((await client.multiSession.switch({ sessionId: ada.sessionId })).ok).toBe(true);
    await vi.waitFor(() => expect(client.store.get().data?.user.email).toBe("ada@example.com"));
    // The end of the active session makes the first bag session active, and the store reads it.
    expect(await client.multiSession.signOut({ sessionId: ada.sessionId })).toEqual({
      ok: true,
      value: { ok: true },
    });
    await vi.waitFor(() => expect(client.store.get().data?.user.email).toBe("bea@example.com"));
    stop();
  });

  it("lastMethod reads the last method cookie through the closed set, and answers null with none", async () => {
    const server = makeServer({ lastMethod: {} });
    const { fetch, jar } = inProcessFetch(server.auth);
    const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const client = createClient({ baseURL: BASE_URL, fetch, cookies });
    expect(client.lastMethod()).toBeNull();
    await client.magicLink.request({ email: "ada@example.com" });
    await client.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
    expect(jar.get("__Host-tempo_last_method")).toBe("magic_link");
    expect(client.lastMethod()).toBe("magic_link");
    // A value that is not of core's closed set reads as null.
    for (const value of ["admin", "social:", "social:Bad Name", "MAGIC_LINK"])
      expect(
        createClient({
          baseURL: BASE_URL,
          cookies: () => `a=1; __Host-tempo_last_method=${value}`,
        }).lastMethod(),
      ).toBeNull();
    expect(
      createClient({
        baseURL: BASE_URL,
        cookies: () => "__Host-tempo_last_method=social:google",
      }).lastMethod(),
    ).toBe("social:google");
    // The cookie name of the server's lastMethod.cookieName.
    expect(
      createClient({
        baseURL: BASE_URL,
        cookies: () => "__Host-tempo_last_method=passkey; last=phone",
        lastMethodCookie: "last",
      }).lastMethod(),
    ).toBe("phone");
    // The default reads document.cookie, and no document answers null.
    vi.stubGlobal("document", { cookie: "__Host-tempo_last_method=email_otp" });
    expect(createClient({ baseURL: BASE_URL }).lastMethod()).toBe("email_otp");
    vi.stubGlobal("document", undefined);
    expect(createClient({ baseURL: BASE_URL }).lastMethod()).toBeNull();
  });

  it("social.startURL and identities.link carry the app payload as base64url JSON", async () => {
    const client = createClient({ baseURL: BASE_URL });
    const data = { cart: "c-1", items: [1, 2] };
    const url = client.social.startURL({ provider: "google", next: "/shop", data });
    if (!url.ok) throw new Error(url.code);
    const q = new URL(url.value).searchParams;
    expect(q.get("next")).toBe("/shop");
    const decoded = new TextDecoder().decode(base64UrlDecode(q.get("data") ?? ""));
    expect(JSON.parse(decoded)).toEqual(data);
    expect(q.get("data")).toMatch(/^[A-Za-z0-9_-]+$/);
    // The link start posts the same form in its body.
    const requests: string[] = [];
    const nav: string[] = [];
    const navClient = createClient({
      baseURL: BASE_URL,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(await new Request(input, init).text());
        return Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
      }) as typeof fetch,
      navigate: (u) => void nav.push(u),
    });
    expect((await navClient.identities.link({ provider: "google", data })).ok).toBe(true);
    const body = JSON.parse(requests.at(-1) ?? "") as { data: string };
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(body.data)))).toEqual(data);
    expect(nav).toEqual(["https://accounts.google.com/o/oauth2/v2/auth?x=1"]);
  });

  it("user.update answers the user of an account with no address", async () => {
    const sms = createRecordingSms();
    const server = makeServer({
      phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    });
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    await client.phone.request({ phone: "+14155550100" });
    const code = /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect((await client.phone.verify({ phone: "+14155550100", code })).ok).toBe(true);
    expect(await client.user.update({ name: "Ada" })).toMatchObject({
      ok: true,
      value: { user: { email: null, name: "Ada" } },
    });
  });
});
