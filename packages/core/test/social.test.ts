import { describe, expect, it } from "vitest";
import {
  completeSocial,
  OAUTH_STATE_PREFIX,
  resolveSocialUser,
  startSocial,
} from "../src/engine/social.js";
import { findOrCreateUserByEmail } from "../src/engine/users.js";
import { createRouter } from "../src/http/router.js";
import { socialRoutes } from "../src/http/routes/social.js";
import { sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import type { UserRow } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { APP_ORIGIN, BASE_URL, get } from "./helpers.js";
import {
  type FakeIdToken,
  fakeFetch,
  fakeJwt,
  GOOGLE,
  socialAuth,
  stateRow,
} from "./social-helpers.js";

const GOOGLE_ISS = "https://accounts.google.com";
const APPLE_ISS = "https://appleid.apple.com";

/** Starts a Google flow and returns what the callback needs. */
async function started(auth: ReturnType<typeof socialAuth>, provider = "google", next = "/home") {
  const r = await startSocial(auth.config, { provider, next, ip: "1.1.1.1" });
  if (!r.ok) throw new Error(`start failed: ${r.code}`);
  const url = new URL(r.value.location);
  const state = url.searchParams.get("state") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  return { url, state, nonce, bindToken: r.value.bindToken };
}

function googleToken(nonce: string, claims: Record<string, unknown>) {
  return {
    audience: GOOGLE.clientId,
    issuer: GOOGLE_ISS,
    claims: {
      sub: "g-1",
      email: "ada@example.com",
      email_verified: true,
      name: "Ada",
      picture: "https://p/a.png",
      nonce,
      ...claims,
    },
  };
}

describe("startSocial", () => {
  it("writes one oauth-state row and redirects with state, nonce, S256 challenge, and scope (%20)", async () => {
    const auth = socialAuth();
    const { url, state, nonce, bindToken } = await started(auth);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(state).toMatch(new RegExp(`^${OAUTH_STATE_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(url.searchParams.get("client_id")).toBe("gid");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/auth/social/google/callback`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.search).toContain("scope=openid%20email%20profile");
    const row = await stateRow(auth.storage, state);
    expect(row).toMatchObject({ purpose: "oauth-state", identifier: "google", consumedAt: null });
    expect(row?.expiresAt.getTime()).toBe(auth.clock.now().getTime() + 10 * 60_000);
    const data = row?.data as {
      verifier: string;
      nonceHash: string;
      bindHash: string;
      next: string;
    };
    expect(url.searchParams.get("code_challenge")).toBe(await sha256Base64Url(data.verifier));
    expect(data.nonceHash).toBe(await sha256Hex(nonce));
    expect(data.bindHash).toBe(await sha256Hex(bindToken));
    expect(data.next).toBe("/home");
    expect(JSON.stringify(row)).not.toContain(state.slice(3));
  });
  it("adds Apple's response_mode and replaces an unsafe next", async () => {
    const auth = socialAuth();
    const { url, state } = await started(auth, "apple", "https://evil.example");
    expect(url.origin + url.pathname).toBe("https://appleid.apple.com/auth/authorize");
    expect(url.searchParams.get("response_mode")).toBe("form_post");
    expect(url.search).toContain("scope=name%20email");
    expect((await stateRow(auth.storage, state))?.data).toMatchObject({ next: "/" });
  });
  it("answers not_found for a provider that is not configured and rate_limited after 30 starts per ip", async () => {
    const auth = socialAuth();
    expect(await startSocial(auth.config, { provider: "github", ip: null })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    for (let i = 0; i < 30; i++)
      expect((await startSocial(auth.config, { provider: "google", ip: "2.2.2.2" })).ok).toBe(true);
    expect(await startSocial(auth.config, { provider: "google", ip: "2.2.2.2" })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect((await startSocial(auth.config, { provider: "google", ip: "3.3.3.3" })).ok).toBe(true);
  });
});

describe("completeSocial", () => {
  function complete(
    auth: ReturnType<typeof socialAuth>,
    s: Awaited<ReturnType<typeof started>>,
    over: Partial<Parameters<typeof completeSocial>[1]> = {},
  ) {
    return completeSocial(auth.config, {
      provider: "google",
      state: s.state,
      code: "code-1",
      error: null,
      bindToken: s.bindToken,
      ip: "1.1.1.1",
      userAgent: "ua",
      ...over,
    });
  }

  it("exchanges the code with PKCE, verifies the token, creates the user with both identities, and opens a session", async () => {
    const jwtTokens: Record<string, ReturnType<typeof googleToken>> = {};
    const auth = socialAuth({}, fakeJwt(jwtTokens));
    const s = await started(auth);
    jwtTokens["idtok-default"] = googleToken(s.nonce, {});
    const r = await complete(auth, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (!("token" in r.value)) throw new Error("the sign-in answered a challenge");
    expect(r.value.next).toBe("/home");
    expect(r.value.user).toMatchObject({
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada",
      image: "https://p/a.png",
    });
    expect(r.value.token).toMatch(/^ts_/);
    const call = auth.calls[0];
    expect(call?.url).toBe("https://oauth2.googleapis.com/token");
    expect(call?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const row = await stateRow(auth.storage, s.state);
    expect(call?.form).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: `${BASE_URL}/auth/social/google/callback`,
      client_id: "gid",
      client_secret: "gsecret",
      code_verifier: (row?.data as { verifier: string } | undefined)?.verifier,
    });
    expect(row?.consumedAt).not.toBeNull();
    const identities = await auth.storage.findMany("identity", [], {
      sort: { field: "provider", dir: "asc" },
    });
    expect(identities.map((i) => [i.provider, i.subject])).toEqual([
      ["email", "ada@example.com"],
      ["google", "g-1"],
    ]);
    expect(await auth.storage.findMany("session", [])).toHaveLength(1);
  });

  it("fills no name from a profile name with a right-to-left override (plan 12a Task 7 review R2-L1)", async () => {
    const jwtTokens: Record<string, ReturnType<typeof googleToken>> = {};
    const auth = socialAuth({}, fakeJwt(jwtTokens));
    const s = await started(auth);
    jwtTokens["idtok-default"] = googleToken(s.nonce, { name: "Ada\u202Eevil" });
    const r = await complete(auth, s);
    expect(r.ok && r.value.user).toMatchObject({ name: null, image: "https://p/a.png" });
  });

  it("drops a name with a control character, a 3000-character picture, and a picture that is not https (final review I-2)", async () => {
    const cases: Array<Record<string, unknown>> = [
      { name: "Ada\nX", picture: `https://p/${"a".repeat(3000)}` },
      { name: "Ada\u0000", picture: "javascript:alert(1)" },
    ];
    for (const claims of cases) {
      const jwtTokens: Record<string, ReturnType<typeof googleToken>> = {};
      const auth = socialAuth({}, fakeJwt(jwtTokens));
      const s = await started(auth);
      jwtTokens["idtok-default"] = googleToken(s.nonce, claims);
      const r = await complete(auth, s);
      expect(r.ok && r.value.user).toMatchObject({ name: null, image: null });
    }
  });

  it("rejects a resubmitted callback with invalid_token and keeps one session (Review Focus 2)", async () => {
    const jwtTokens: Record<string, ReturnType<typeof googleToken>> = {};
    const auth = socialAuth({}, fakeJwt(jwtTokens));
    const s = await started(auth);
    jwtTokens["idtok-default"] = googleToken(s.nonce, {});
    expect((await complete(auth, s)).ok).toBe(true);
    expect(await complete(auth, s)).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await auth.storage.findMany("session", [])).toHaveLength(1);
  });

  it("rejects a Google state on the Apple callback and consumes it (Review Focus 1)", async () => {
    const auth = socialAuth();
    const s = await started(auth);
    expect(await complete(auth, s, { provider: "apple" })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect((await stateRow(auth.storage, s.state))?.consumedAt).not.toBeNull();
    expect(await complete(auth, s)).toMatchObject({ ok: false, code: "invalid_token" });
    expect(auth.calls).toHaveLength(0);
  });

  it("rejects a missing or wrong binding cookie, an expired state, a malformed state, and a provider error", async () => {
    const auth = socialAuth();
    const s = await started(auth);
    expect(await complete(auth, s, { bindToken: null })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    const s2 = await started(auth);
    expect(await complete(auth, s2, { bindToken: "wrong" })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    const s3 = await started(auth);
    auth.clock.advance(10 * 60_000);
    expect(await complete(auth, s3)).toMatchObject({ ok: false, code: "token_expired" });
    expect(await complete(auth, s3, { state: "nope" })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    const s4 = await started(auth);
    expect(await complete(auth, s4, { error: "access_denied" })).toMatchObject({
      ok: false,
      code: "oauth_denied",
    });
    expect(await complete(auth, s4)).toMatchObject({ ok: false, code: "invalid_token" });
    // A denied callback with a bad state is not a denial: no row, no cookie, no effect.
    const s5 = await started(auth);
    expect(await complete(auth, s5, { error: "access_denied", state: "nope" })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(auth.calls).toHaveLength(0);
  });

  it("fails oauth_failed when the exchange answers an error, has no id_token, or the token does not verify", async () => {
    const bad = fakeFetch(() => new Response("nope", { status: 400 }));
    const a1 = socialAuth({ social: { google: GOOGLE, fetch: bad.fetchFn } });
    expect(await complete(a1, await started(a1))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    const none = fakeFetch(() => Response.json({ access_token: "x" }));
    const a2 = socialAuth({ social: { google: GOOGLE, fetch: none.fetchFn } });
    expect(await complete(a2, await started(a2))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    const a3 = socialAuth({}, fakeJwt({}));
    expect(await complete(a3, await started(a3))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    expect(await a3.storage.findMany("user", [])).toHaveLength(0);
  });

  it("fails oauth_failed on a nonce from another flow (Review Focus 3)", async () => {
    const jwtTokens: Record<string, ReturnType<typeof googleToken>> = {};
    const auth = socialAuth({}, fakeJwt(jwtTokens));
    const other = await started(auth);
    const s = await started(auth);
    jwtTokens["idtok-default"] = googleToken(other.nonce, {});
    expect(await complete(auth, s)).toMatchObject({ ok: false, code: "oauth_failed" });
    expect(await auth.storage.findMany("user", [])).toHaveLength(0);
  });

  it("fails email_required when the token has no email", async () => {
    const jwtTokens: Record<string, ReturnType<typeof googleToken>> = {};
    const auth = socialAuth({}, fakeJwt(jwtTokens));
    const s = await started(auth);
    jwtTokens["idtok-default"] = googleToken(s.nonce, { email: undefined });
    expect(await complete(auth, s)).toMatchObject({ ok: false, code: "email_required" });
  });

  it("signs the Apple client secret per exchange and stores the first-sign-in name", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    const appleToken = (nonce: string): FakeIdToken => ({
      audience: "com.example.web",
      issuer: APPLE_ISS,
      claims: { sub: "001.a", email: "a@privaterelay.appleid.com", email_verified: "true", nonce },
    });
    const s = await started(auth, "apple");
    tokens["idtok-default"] = appleToken(s.nonce);
    const user = JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" } });
    const r = await complete(auth, s, { provider: "apple", user });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user).toMatchObject({
      email: "a@privaterelay.appleid.com",
      name: "Ada Lovelace",
      emailVerified: true,
    });
    expect(auth.calls[0]?.url).toBe("https://appleid.apple.com/auth/token");
    expect(auth.calls[0]?.form.client_secret).toBe(
      `es256.KEY1.${Math.floor(auth.clock.now().getTime() / 1000) + 300}`,
    );
    // A second sign-in sends no name; the stored name stays.
    const s2 = await started(auth, "apple");
    tokens["idtok-default"] = appleToken(s2.nonce);
    const r2 = await complete(auth, s2, { provider: "apple" });
    expect(r2.ok && r2.value.user.name).toBe("Ada Lovelace");
    expect(await auth.storage.findMany("user", [])).toHaveLength(1);
  });

  it("fails oauth_failed without a fetch call when the callback has no code (review M2)", async () => {
    const auth = socialAuth();
    const s = await started(auth);
    expect(await complete(auth, s, { code: null })).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    expect(auth.calls).toHaveLength(0);
  });

  it("fails oauth_failed without a fetch call when the client secret cannot be signed (review M5)", async () => {
    const jwt = fakeJwt({});
    jwt.signES256 = async () => {
      throw new Error("bad pem");
    };
    const auth = socialAuth({}, jwt);
    const s = await started(auth, "apple");
    expect(await complete(auth, s, { provider: "apple" })).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    expect(auth.calls).toHaveLength(0);
  });

  it("fails oauth_failed when the fetch rejects or answers 200 with a body that is not JSON (review M1)", async () => {
    const down = fakeFetch(() => {
      throw new Error("net");
    });
    const a1 = socialAuth({ social: { google: GOOGLE, fetch: down.fetchFn } });
    expect(await complete(a1, await started(a1))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
    const html = fakeFetch(() => new Response("<html>", { status: 200 }));
    const a2 = socialAuth({ social: { google: GOOGLE, fetch: html.fetchFn } });
    expect(await complete(a2, await started(a2))).toMatchObject({
      ok: false,
      code: "oauth_failed",
    });
  });
});

describe("resolveSocialUser", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const profile = {
    subject: "g-1",
    email: "Ada@Example.com",
    emailVerified: true,
    name: "Ada",
    image: null,
  };

  it("links to an existing user with the same verified email and repairs a missing email identity", async () => {
    const auth = socialAuth();
    const existing = await auth.seedUser("ada@example.com");
    const r = await resolveSocialUser(auth.storage, "google", profile, now);
    expect(r.ok && r.value.id).toBe(existing.id);
    const identities = await auth.storage.findMany("identity", [], {
      sort: { field: "provider", dir: "asc" },
    });
    expect(identities.map((i) => i.provider)).toEqual(["email", "google"]);
    expect(
      (await auth.storage.findOne("user", [{ field: "id", op: "eq", value: existing.id }]))?.name,
    ).toBe("Ada");
  });

  it("refuses to link an unverified email to an existing user (Review Focus 4)", async () => {
    const auth = socialAuth();
    const existing = await auth.seedUser("ada@example.com");
    const r = await resolveSocialUser(
      auth.storage,
      "google",
      { ...profile, emailVerified: false },
      now,
    );
    expect(r).toMatchObject({ ok: false, code: "email_taken_unverified" });
    expect(await auth.storage.findMany("identity", [])).toHaveLength(0);
    expect(
      await auth.storage.findOne("user", [{ field: "id", op: "eq", value: existing.id }]),
    ).toEqual(existing);
  });

  it("creates an unverified user with the social identity only when the email is unverified", async () => {
    const auth = socialAuth();
    const r = await resolveSocialUser(
      auth.storage,
      "google",
      { ...profile, emailVerified: false },
      now,
    );
    expect(r.ok && r.value).toMatchObject({ email: "ada@example.com", emailVerified: false });
    expect((await auth.storage.findMany("identity", [])).map((i) => i.provider)).toEqual([
      "google",
    ]);
  });

  it("returns the linked user on a second sign-in and marks the email verified when the provider verifies it", async () => {
    const auth = socialAuth();
    const first = await resolveSocialUser(
      auth.storage,
      "google",
      { ...profile, emailVerified: false, name: null },
      now,
    );
    const second = await resolveSocialUser(auth.storage, "google", profile, now);
    expect(first.ok && second.ok && first.value.id === second.value.id).toBe(true);
    expect(second.ok && second.value.name).toBe("Ada");
    expect(await auth.storage.findMany("user", [])).toHaveLength(1);
  });

  it("retries once after a concurrent unique_violation and returns the winner", async () => {
    const auth = socialAuth();
    const inner = auth.storage;
    const winner: UserRow = {
      id: "01WINNER",
      email: "ada@example.com",
      emailVerified: true,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    };
    // Same shape as `concurrentWinner` in users.test.ts: the first user read
    // inside a transaction misses, and the winner lands through the outer
    // adapter, as another request on another connection would.
    let missed = false;
    const wrap = (a: StorageAdapter): StorageAdapter => ({
      create: (m, d) => a.create(m, d),
      findOne: async (m, w) => {
        if (m === "user" && !missed) {
          missed = true;
          await inner.create("user", winner);
          return null;
        }
        return a.findOne(m, w);
      },
      findMany: (m, w, o) => a.findMany(m, w, o),
      update: (m, w, d) => a.update(m, w, d),
      delete: (m, w) => a.delete(m, w),
      transaction: (fn) => a.transaction((tx) => fn(wrap(tx))),
    });
    const r = await resolveSocialUser(wrap(inner), "google", profile, now);
    expect(r.ok && r.value.id).toBe("01WINNER");
    expect(await inner.findMany("user", [])).toHaveLength(1);
    expect((await inner.findMany("identity", [])).map((i) => i.provider).sort()).toEqual([
      "email",
      "google",
    ]);
  });

  it("revokes an unverified claimant when the real owner signs in by a verified provider (review I1)", async () => {
    const auth = socialAuth();
    // The attacker signs in through a provider that does not verify the address.
    const claim = await resolveSocialUser(
      auth.storage,
      "google",
      { ...profile, subject: "attacker", emailVerified: false, name: null },
      now,
    );
    expect(claim.ok && claim.value.emailVerified).toBe(false);
    const claimant = claim.ok ? claim.value : null;
    if (!claimant) throw new Error("no claimant");
    await auth.storage.create("session", {
      id: "S1",
      userId: claimant.id,
      tokenHash: "h",
      expiresAt: new Date(now.getTime() + 1000),
      lastSeenAt: now,
      ip: null,
      userAgent: null,
      activeOrganizationId: null,
      freshAt: now,
      createdAt: now,
      updatedAt: now,
    });
    // The real owner proves the address through Apple.
    const owner = await resolveSocialUser(
      auth.storage,
      "apple",
      { ...profile, subject: "owner" },
      now,
    );
    expect(owner.ok && owner.value.id).toBe(claimant.id);
    expect(owner.ok && owner.value.emailVerified).toBe(true);
    const identities = await auth.storage.findMany("identity", [], {
      sort: { field: "provider", dir: "asc" },
    });
    expect(identities.map((i) => [i.provider, i.subject])).toEqual([
      ["apple", "owner"],
      ["email", "ada@example.com"],
    ]);
    expect(await auth.storage.findMany("session", [])).toHaveLength(0);
  });

  it("revokes an unverified claimant when the real owner signs in by magic link", async () => {
    const auth = socialAuth();
    await resolveSocialUser(
      auth.storage,
      "google",
      { ...profile, subject: "attacker", emailVerified: false },
      now,
    );
    const { user } = await findOrCreateUserByEmail(auth.storage, "ada@example.com", now);
    expect(user.emailVerified).toBe(true);
    expect((await auth.storage.findMany("identity", [])).map((i) => i.provider)).toEqual(["email"]);
  });

  it("does not verify a claimed address when the provider later verifies a different address (final review C1)", async () => {
    const auth = socialAuth();
    // The attacker claims the victim's address, unverified.
    await resolveSocialUser(
      auth.storage,
      "google",
      { ...profile, subject: "attacker", emailVerified: false },
      now,
    );
    // The attacker's provider account now reports a verified address of their own.
    const r = await resolveSocialUser(
      auth.storage,
      "google",
      { ...profile, subject: "attacker", email: "attacker@evil.example", emailVerified: true },
      now,
    );
    expect(r.ok && r.value.emailVerified).toBe(false);
    expect(r.ok && r.value.email).toBe("ada@example.com");
    expect((await auth.storage.findMany("identity", [])).map((i) => i.provider)).toEqual([
      "google",
    ]);
    // The real owner then proves the address and the claimant is revoked.
    const owner = await resolveSocialUser(
      auth.storage,
      "apple",
      { ...profile, subject: "owner" },
      now,
    );
    expect(owner.ok && owner.value.emailVerified).toBe(true);
    expect(
      (await auth.storage.findMany("identity", [])).map((i) => [i.provider, i.subject]).sort(),
    ).toEqual([
      ["apple", "owner"],
      ["email", "ada@example.com"],
    ]);
  });

  it("keeps the identity that carries the proof when the same identity returns verified", async () => {
    const auth = socialAuth();
    await resolveSocialUser(auth.storage, "google", { ...profile, emailVerified: false }, now);
    const r = await resolveSocialUser(auth.storage, "google", profile, now);
    expect(r.ok && r.value.emailVerified).toBe(true);
    expect((await auth.storage.findMany("identity", [])).map((i) => i.provider).sort()).toEqual([
      "email",
      "google",
    ]);
  });
});

describe("social routes", () => {
  it("redirects to appURL after a callback and on an error", async () => {
    const jwtTokens: Record<string, ReturnType<typeof googleToken>> = {};
    const auth = socialAuth({ appURL: APP_ORIGIN }, fakeJwt(jwtTokens));
    const handle = createRouter(auth.config, socialRoutes(auth.config));
    const start = await handle(get("/auth/social/google/start?next=%2Fhome"));
    const bind = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const url = new URL(start.headers.get("location") ?? "");
    jwtTokens["idtok-default"] = googleToken(url.searchParams.get("nonce") ?? "", {});
    const ok = await handle(
      get(
        `/auth/social/google/callback?code=c1&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`,
        { cookie: bind },
      ),
    );
    expect(ok.headers.get("location")).toBe(`${APP_ORIGIN}/home`);
    const bad = await handle(get("/auth/social/google/callback?code=c1&state=nope"));
    expect(bad.headers.get("location")).toBe(`${APP_ORIGIN}/?auth_error=invalid_token`);
    const limited = await handle(get("/auth/social/github/start"));
    expect(limited.status).toBe(404);
  });

  const BIND = "__Secure-tempo_session_oauth";

  it("GET start redirects to the provider and sets the binding cookie", async () => {
    const auth = socialAuth();
    const handle = createRouter(auth.config, socialRoutes(auth.config));
    const res = await handle(get("/auth/social/google/start?next=%2Fhome"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/,
    );
    expect(res.headers.get("set-cookie")).toMatch(
      new RegExp(
        `^${BIND}=[A-Za-z0-9_-]{43}; Path=/auth/social; Max-Age=600; HttpOnly; Secure; SameSite=None$`,
      ),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await handle(get("/auth/social/github/start"))).status).toBe(404);
  });

  it("GET start redirects with auth_error when limited", async () => {
    const auth = socialAuth();
    const handle = createRouter(auth.config, socialRoutes(auth.config));
    for (let i = 0; i < 30; i++) await handle(get("/auth/social/google/start"));
    const res = await handle(get("/auth/social/google/start"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/?auth_error=rate_limited`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("Google callback by GET signs in, sets the session cookie, clears the binding cookie, and redirects to next", async () => {
    const jwtTokens: Record<string, ReturnType<typeof googleToken>> = {};
    const auth = socialAuth({}, fakeJwt(jwtTokens));
    const handle = createRouter(auth.config, socialRoutes(auth.config));
    const start = await handle(get("/auth/social/google/start?next=%2Fhome"));
    const bind = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const nonce = new URL(start.headers.get("location") ?? "").searchParams.get("nonce") ?? "";
    jwtTokens["idtok-default"] = googleToken(nonce, {});
    const res = await handle(
      get(`/auth/social/google/callback?code=c1&state=${encodeURIComponent(state)}`, {
        cookie: bind,
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/home`);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => /^__Host-tempo_session=ts_/.test(c))).toBe(true);
    expect(cookies).toContain(
      `${BIND}=; Path=/auth/social; Max-Age=0; HttpOnly; Secure; SameSite=None`,
    );
  });

  it("Apple callback by POST from Apple's origin passes the router and reads the form", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    const handle = createRouter(auth.config, socialRoutes(auth.config));
    const start = await handle(get("/auth/social/apple/start"));
    const bind = start.headers.get("set-cookie")?.split(";")[0] ?? "";
    const url = new URL(start.headers.get("location") ?? "");
    const state = url.searchParams.get("state") ?? "";
    const nonce = url.searchParams.get("nonce") ?? "";
    tokens["idtok-default"] = {
      audience: "com.example.web",
      issuer: APPLE_ISS,
      claims: { sub: "001.a", email: "a@x.io", email_verified: true, nonce },
    };
    const res = await handle(
      new Request(`${BASE_URL}/auth/social/apple/callback`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://appleid.apple.com",
          cookie: bind,
        },
        body: new URLSearchParams({
          code: "c1",
          state,
          user: JSON.stringify({ name: { firstName: "Ada", lastName: "L" } }),
        }).toString(),
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/`);
    expect((await auth.storage.findMany("user", []))[0]?.name).toBe("Ada L");
    // A GET on the Apple callback is not a route.
    expect((await handle(get("/auth/social/apple/callback?code=x&state=y"))).status).toBe(404);
  });

  it("callback failures redirect with the code, clear the binding cookie, and set no session cookie", async () => {
    const auth = socialAuth();
    const handle = createRouter(auth.config, socialRoutes(auth.config));
    const start = await handle(get("/auth/social/google/start"));
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const noCookie = await handle(
      get(`/auth/social/google/callback?code=c1&state=${encodeURIComponent(state)}`),
    );
    expect(noCookie.status).toBe(302);
    expect(noCookie.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    expect(noCookie.headers.getSetCookie()).toEqual([]);
    const stray = await handle(get("/auth/social/google/callback?error=access_denied&state=x"));
    expect(stray.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
    expect(stray.headers.getSetCookie()).toEqual([]);
    const start2 = await handle(get("/auth/social/google/start"));
    const bind2 = start2.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state2 = new URL(start2.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const denied = await handle(
      get(`/auth/social/google/callback?error=access_denied&state=${encodeURIComponent(state2)}`, {
        cookie: bind2,
      }),
    );
    expect(denied.headers.get("location")).toBe(`${BASE_URL}/?auth_error=oauth_denied`);
    expect(denied.headers.getSetCookie()).toEqual([
      `${BIND}=; Path=/auth/social; Max-Age=0; HttpOnly; Secure; SameSite=None`,
    ]);
    const empty = await handle(
      new Request(`${BASE_URL}/auth/social/apple/callback`, {
        method: "POST",
        headers: { origin: "https://appleid.apple.com" },
      }),
    );
    expect(empty.status).toBe(302);
    expect(empty.headers.get("location")).toBe(`${BASE_URL}/?auth_error=invalid_token`);
  });
});
