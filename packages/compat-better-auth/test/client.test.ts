import type { BrowserWebAuthn } from "@tempo-auth/client";
import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@tempo-auth/core";
import { SoftAuthenticator } from "@tempo-auth/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_SESSION_KEYS,
  CLIENT_USER_KEYS,
  createAuthClient,
  expoClient,
  organizationClient,
} from "../src/client/index.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, magicLink, organization, passkey } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import type { BetterAuthOptions, CompatDatabase, InvitationEmailData } from "../src/types.js";

const BASE = "https://api.example.com";
const PASSWORD = "correct horse battery";

function server(o: { minPasswordLength?: number; plugins?: BetterAuthOptions["plugins"] } = {}) {
  const invitations: InvitationEmailData[] = [];
  const mails: { kind: "verify" | "reset"; email: string; token: string }[] = [];
  const database: CompatDatabase = {
    kind: "tempo-auth-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
  const auth = betterAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: ["reception://"],
    database,
    emailAndPassword: {
      enabled: true,
      ...(o.minPasswordLength !== undefined ? { minPasswordLength: o.minPasswordLength } : {}),
      sendResetPassword: async (d) =>
        void mails.push({ kind: "reset", email: d.user.email, token: d.token }),
    },
    emailVerification: {
      sendVerificationEmail: async (d) =>
        void mails.push({ kind: "verify", email: d.user.email, token: d.token }),
    },
    socialProviders: { google: { clientId: "g", clientSecret: "s" } },
    plugins: [
      bearer(),
      organization({ sendInvitationEmail: async (d) => void invitations.push(d) }),
      ...(o.plugins ?? []),
    ],
    tempoAuth: {
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  });
  const seen: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    seen.push(req.clone());
    return auth.handler(req);
  };
  /**
   * Confirms the newest verify link of the address, as a person does, and
   * signs in again. The confirm claims the address, and the claim ends the
   * sign-up session, so the sign-up token is dead after it.
   */
  const verifiedToken = async (email: string) => {
    const link = [...mails].reverse().find((m) => m.kind === "verify" && m.email === email);
    if (!link) throw new Error(`no verify link for ${email}`);
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/password/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
        body: new URLSearchParams({ token: link.token }).toString(),
      }),
    );
    if (res.status !== 302) throw new Error(`the verify link answered ${res.status}`);
    return (await auth.api.signInEmail({ body: { email, password: PASSWORD } })).token;
  };
  return { auth, fetchImpl, seen, invitations, mails, verifiedToken };
}

describe("createAuthClient", () => {
  it("signs up, signs in, and reads the session in Better Auth's shapes (Review Focus 4)", async () => {
    const s = server();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    const up = await c.signUp.email({
      email: "pat@example.com",
      password: "correct horse battery",
      name: "Pat",
    });
    expect(up.error).toBeNull();
    expect(Object.keys(up.data?.user ?? {}).sort()).toEqual([...CLIENT_USER_KEYS].sort());
    const signedIn = await c.signIn.email({
      email: "pat@example.com",
      password: "correct horse battery",
    });
    expect(signedIn.data).toMatchObject({
      redirect: false,
      token: expect.stringMatching(/^ts_/),
      user: { email: "pat@example.com", name: "Pat" },
    });
    // The test fetch keeps no cookie jar, so read the session with the token, as a native app does.
    const native = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: s.fetchImpl,
        headers: { authorization: `Bearer ${signedIn.data?.token}` },
      },
    });
    const session = await native.getSession();
    expect(Object.keys(session.data?.session ?? {}).sort()).toEqual(
      [...CLIENT_SESSION_KEYS].sort(),
    );
    expect(session.data?.session.expiresAt).toBeInstanceOf(Date);
    expect(s.seen.at(-1)?.headers.get("authorization")).toBe(`Bearer ${signedIn.data?.token}`);
  });

  it("answers Better Auth's error shape with core's status (Review Focus 5)", async () => {
    const s = server();
    const onError = vi.fn();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: { customFetchImpl: s.fetchImpl, onError },
    });
    await c.signUp.email({
      email: "pat@example.com",
      password: "correct horse battery",
      name: "Pat",
    });
    const wrong = await c.signIn.email({
      email: "pat@example.com",
      password: "wrong horse battery",
    });
    expect(wrong).toEqual({
      data: null,
      error: {
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
        status: 401,
        statusText: "Unauthorized",
      },
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error: wrong.error }));
    expect(
      (
        await c.signUp.email({
          email: "pat@example.com",
          password: "correct horse battery",
          name: "Pat",
        })
      ).error,
    ).toMatchObject({ code: "USER_ALREADY_EXISTS", status: 409 });
    expect(
      (await c.signUp.email({ email: "q@example.com", password: "short", name: "Q" })).error,
    ).toMatchObject({ code: "PASSWORD_TOO_SHORT", status: 400 });
    expect(
      (await c.sendVerificationEmail({ email: "pat@example.com", callbackURL: "/dashboard" }))
        .error,
    ).toMatchObject({ code: "NOT_SUPPORTED", status: 501 });
    expect(
      (await c.organization.create({ name: "Acme", slug: "acme", logo: "https://x" })).error,
    ).toMatchObject({ code: "NOT_SUPPORTED", status: 501 });
  });

  it("hands the real response to onSuccess, so the bearer plugin's set-auth-token reaches the app (consumer-i mobile)", async () => {
    const s = server();
    const tokens: string[] = [];
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: s.fetchImpl,
        onSuccess: (ctx) => {
          const t = ctx.response.headers.get("set-auth-token");
          if (t) tokens.push(t);
        },
      },
    });
    const up = await c.signUp.email({
      email: "pat@example.com",
      password: "correct horse battery",
      name: "Pat",
    });
    expect(tokens).toEqual([up.data?.token]);
  });

  it("builds the social start URL with callbackURL as next and does not navigate when told not to", async () => {
    const s = server();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    const r = await c.signIn.social({
      provider: "google",
      callbackURL: "/dashboard",
      disableRedirect: true,
    });
    expect(r.data).toEqual({
      url: `${BASE}/api/auth/social/google/start?next=%2Fdashboard`,
      redirect: false,
    });
    const start = await s.auth.handler(new Request(r.data?.url ?? ""));
    expect(start.status).toBe(302);
    expect(start.headers.get("location")?.startsWith("https://accounts.google.com/")).toBe(true);
  });

  it("runs consumer-i's organization calls: create, setActive, inviteMember, getFullOrganization, acceptInvitation", async () => {
    const s = server();
    const owner = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [organizationClient()],
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    await owner.signUp.email({ email: "owner@example.com", password: PASSWORD, name: "Owner" });
    const ownerToken = await s.verifiedToken("owner@example.com");
    const o = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [organizationClient()],
      fetchOptions: {
        customFetchImpl: s.fetchImpl,
        headers: { authorization: `Bearer ${ownerToken}` },
      },
    });
    const created = await o.organization.create({ name: "Acme", slug: "acme" });
    expect(created.data).toMatchObject({
      name: "Acme",
      slug: "acme",
      logo: null,
      members: [{ role: "owner", user: { email: "owner@example.com" } }],
    });
    const orgId = created.data?.id ?? "";
    expect((await o.organization.list()).data).toEqual([
      {
        id: orgId,
        name: "Acme",
        slug: "acme",
        logo: null,
        metadata: null,
        createdAt: expect.any(Date),
      },
    ]);
    expect((await o.organization.setActive({ organizationId: orgId })).data?.id).toBe(orgId);
    const inv = await o.organization.inviteMember({ email: "new@example.com", role: "member" });
    expect(inv.data).toMatchObject({
      organizationId: orgId,
      email: "new@example.com",
      status: "pending",
    });
    const full = await o.organization.getFullOrganization();
    expect(full.data?.members.map((m) => m.user.email)).toEqual(["owner@example.com"]);
    expect(full.data?.invitations.map((i) => i.email)).toEqual(["new@example.com"]);
    await owner.signUp.email({ email: "new@example.com", password: PASSWORD, name: "New" });
    const newToken = await s.verifiedToken("new@example.com");
    const n = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: s.fetchImpl,
        headers: { authorization: `Bearer ${newToken}` },
      },
    });
    const accepted = await n.organization.acceptInvitation({
      invitationId: s.invitations[0]?.id ?? "",
    });
    expect(accepted.data).toMatchObject({
      organization: { id: orgId },
      member: { role: "member" },
    });
  });

  it("keeps the useSession store in step with sign-in and sign-out", async () => {
    const s = server();
    const ex = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [
        expoClient({ scheme: "reception", storagePrefix: "reception", storage: memoryStorage() }),
      ],
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    const changes: boolean[] = [];
    const stop = ex.useSession.subscribe(() => changes.push(ex.useSession.get().data !== null));
    await vi.waitFor(() => expect(ex.useSession.get().isPending).toBe(false));
    expect(ex.useSession.get().data).toBeNull();
    await ex.signUp.email({
      email: "pat@example.com",
      password: "correct horse battery",
      name: "Pat",
    });
    await vi.waitFor(() => expect(ex.useSession.get().data?.user.email).toBe("pat@example.com"));
    await ex.signOut();
    await vi.waitFor(() => expect(ex.useSession.get().data).toBeNull());
    stop();
    expect(changes).toContain(true);
  });
});

describe("createAuthClient: the other calls the apps make", () => {
  const plain = (
    s: ReturnType<typeof server>,
    extra: { headers?: Record<string, string>; webauthn?: BrowserWebAuthn } = {},
  ) =>
    createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: s.fetchImpl,
        ...(extra.headers ? { headers: extra.headers } : {}),
      },
      ...(extra.webauthn ? { tempoAuth: { webauthn: extra.webauthn } } : {}),
    });

  it("requests a reset, resets the password, and names the length case by the server's minPasswordLength", async () => {
    const s = server({ minPasswordLength: 12 });
    const c = plain(s);
    await c.signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    // No `location` here: an absolute redirectTo cannot be checked against the page origin, so it is refused before any request.
    expect(
      await c.requestPasswordReset({
        email: "pat@example.com",
        redirectTo: "https://other.example.com/reset",
      }),
    ).toEqual({
      data: null,
      error: {
        code: "INVALID_REDIRECT_URL",
        message: "Invalid redirect url",
        status: 403,
        statusText: "Forbidden",
      },
    });
    expect(await c.forgetPassword({ email: "pat@example.com", redirectTo: "/reset" })).toEqual({
      data: { status: true },
      error: null,
    });
    const resets = s.mails.filter((m) => m.kind === "reset");
    expect(resets).toHaveLength(1);
    const token = resets[0]?.token ?? "";
    // 10 code points under minPasswordLength 12. A refused password leaves the link usable.
    expect((await c.resetPassword({ newPassword: "ten chars!", token })).error).toMatchObject({
      code: "PASSWORD_TOO_SHORT",
      status: 400,
    });
    expect(await c.resetPassword({ newPassword: "a new correct horse", token })).toEqual({
      data: { status: true },
      error: null,
    });
    expect(
      (await c.signIn.email({ email: "pat@example.com", password: "a new correct horse" })).error,
    ).toBeNull();
    expect(
      (await c.signIn.email({ email: "pat@example.com", password: PASSWORD })).error,
    ).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
  });

  it("requests a magic link on the web and refuses an absolute callbackURL it cannot check", async () => {
    const sent: string[] = [];
    const s = server({
      plugins: [magicLink({ sendMagicLink: async (d) => void sent.push(d.url) })],
    });
    const c = plain(s);
    expect(
      await c.signIn.magicLink({ email: "pat@example.com", callbackURL: "/dashboard" }),
    ).toEqual({ data: { status: true }, error: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.startsWith(`${BASE}/api/auth/magic-link/verify?token=`)).toBe(true);
    expect(
      await c.signIn.magicLink({
        email: "pat@example.com",
        callbackURL: "https://other.example.com/x",
      }),
    ).toEqual({
      data: null,
      error: {
        code: "INVALID_CALLBACK_URL",
        message: "Invalid callback url",
        status: 403,
        statusText: "Forbidden",
      },
    });
    expect(sent).toHaveLength(1);
  });

  it("adds, lists, signs in with, and deletes a passkey through a WebAuthn seam", async () => {
    const s = server({
      plugins: [passkey({ rpID: "example.com", rpName: "Example", origin: BASE })],
    });
    const soft = await SoftAuthenticator.create({ rpID: "example.com", origin: BASE });
    // A seam over the soft authenticator, so the ceremonies run with no browser. The engine checks the challenge.
    const webauthn: BrowserWebAuthn = {
      create: async (options) => soft.register(options.challenge),
      get: async (options) => soft.authenticate(options.challenge),
    };
    await plain(s).signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    // Core registers a passkey for a verified address only.
    const token = await s.verifiedToken("pat@example.com");
    const c = plain(s, { headers: { authorization: `Bearer ${token}` }, webauthn });
    const added = await c.passkey.addPasskey({ name: "laptop" });
    expect(added.error).toBeNull();
    expect(added.data).toMatchObject({ name: "laptop" });
    expect((await c.passkey.listUserPasskeys()).data?.map((p) => p.name)).toEqual(["laptop"]);
    const signedIn = await plain(s, { webauthn }).signIn.passkey();
    expect(signedIn.error).toBeNull();
    expect(signedIn.data?.user.email).toBe("pat@example.com");
    expect(await c.passkey.deletePasskey({ id: added.data?.id ?? "" })).toEqual({
      data: { status: true },
      error: null,
    });
    expect((await c.passkey.listUserPasskeys()).data).toEqual([]);
  });
});

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

describe("expoClient", () => {
  it("stores the token, answers it from getCookie, and sends it as the bearer header", async () => {
    const s = server();
    const storage = memoryStorage();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [expoClient({ scheme: "reception", storagePrefix: "reception", storage })],
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    expect(c.getCookie()).toBe("");
    const r = await c.signIn.email({ email: "pat@example.com", password: "correct horse battery" });
    expect(r.error).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    const up = await c.signUp.email({
      email: "pat@example.com",
      password: "correct horse battery",
      name: "Pat",
    });
    expect(storage.map.get("reception_tempo_session")).toBe(up.data?.token);
    expect(c.getCookie()).toBe(`tempo_session=${up.data?.token}`);
    expect((await c.getSession()).data?.user.email).toBe("pat@example.com");
    expect(s.seen.at(-1)?.headers.get("authorization")).toBe(`Bearer ${up.data?.token}`);
    // The cookie header line works on its own too, as consumer-i's query.ts sends it.
    const me = await s.auth.api.getSession({ headers: new Headers({ cookie: c.getCookie() }) });
    expect(me?.user.email).toBe("pat@example.com");
    await c.signOut();
    expect(c.getCookie()).toBe("");
  });

  it("answers NOT_SUPPORTED for a system-browser sign-in without expo-web-browser", async () => {
    const s = server();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [expoClient({ scheme: "reception", storage: memoryStorage() })],
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    expect((await c.signIn.social({ provider: "google" })).error).toMatchObject({
      code: "NOT_SUPPORTED",
      status: 501,
    });
  });
});
