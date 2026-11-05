import type { BrowserWebAuthn } from "@authtempo/client";
import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@authtempo/core";
import { SoftAuthenticator } from "@authtempo/core/testing";
import { describe, expect, it, vi } from "vitest";
import readme from "../README.md?raw";
import {
  CLIENT_SESSION_KEYS,
  CLIENT_USER_KEYS,
  createAuthClient,
  expoClient,
  organizationClient,
} from "../src/client/index.js";
import { COMPAT_CODES } from "../src/errors.js";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, emailOTP, magicLink, organization, passkey } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import type { BetterAuthOptions, CompatDatabase, InvitationEmailData } from "../src/types.js";
import { proofOf } from "./proof-helpers.js";

const BASE = "https://api.example.com";
const PASSWORD = "correct horse battery";

function server(
  o: {
    minPasswordLength?: number;
    plugins?: BetterAuthOptions["plugins"];
    requireEmailVerification?: boolean;
    session?: BetterAuthOptions["session"];
  } = {},
) {
  const invitations: InvitationEmailData[] = [];
  const mails: { kind: "verify" | "reset"; email: string; token: string }[] = [];
  const database: CompatDatabase = {
    kind: "authtempo-compat-database",
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
      ...(o.requireEmailVerification !== undefined
        ? { requireEmailVerification: o.requireEmailVerification }
        : {}),
      sendResetPassword: async (d) =>
        void mails.push({ kind: "reset", email: d.user.email, token: d.token }),
    },
    emailVerification: {
      sendVerificationEmail: async (d) =>
        void mails.push({ kind: "verify", email: d.user.email, token: d.token }),
    },
    socialProviders: { google: { clientId: "g", clientSecret: "s" } },
    ...(o.session ? { session: o.session } : {}),
    plugins: [
      bearer(),
      organization({ sendInvitationEmail: async (d) => void invitations.push(d) }),
      ...(o.plugins ?? []),
    ],
    authtempo: {
      passwordHash: betterAuthPasswordHash({
        pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }),
      }),
    },
  });
  const seen: Request[] = [];
  // The sign-up proof cookie of each address, as the browser of its sign-up keeps it (plan 12q).
  const proofs = new Map<string, string>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    seen.push(req.clone());
    const body = new URL(req.url).pathname.endsWith("/password/sign-up")
      ? ((await req.clone().json()) as { email?: string })
      : null;
    const res = await auth.handler(req);
    if (body?.email && res.headers.getSetCookie().some((c) => c.startsWith("__Host-tempo_signup=")))
      proofs.set(body.email, proofOf(res));
    return res;
  };
  /**
   * Confirms the newest verify link of the address, as a person does, and
   * signs in again. The confirm claims the address, and the claim ends the
   * sign-up session, so the sign-up token is dead after it.
   */
  const verifiedToken = async (email: string) => {
    const link = [...mails].reverse().find((m) => m.kind === "verify" && m.email === email);
    if (!link) throw new Error(`no verify link for ${email}`);
    // The browser of the sign-up holds its proof, so the password stays (ruling 11 of plan 12q).
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/password/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: BASE,
          cookie: proofs.get(email) ?? "",
        },
        body: new URLSearchParams({ token: link.token }).toString(),
      }),
    );
    if (res.status !== 302) throw new Error(`the verify link answered ${res.status}`);
    return (await auth.api.signInEmail({ body: { email, password: PASSWORD } })).token;
  };
  return { auth, fetchImpl, seen, invitations, mails, verifiedToken, proofs };
}

describe("createAuthClient", () => {
  it("answers UNEXPECTED_RESPONSE and no user when a core server sends the uniform sign-up answer (plan 12b)", async () => {
    // A core server with its default answer. The shim's own server sets uniformSignUp false.
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: async () =>
          new Response(JSON.stringify({ sent: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    });
    const up = await c.signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    expect(up.data).toBeNull();
    expect(up.error).toMatchObject({ code: "UNEXPECTED_RESPONSE", status: 200 });
  });

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

  it("keeps a session alive for ten days under deferSessionRefresh, with one refresh per due day (plan 12a)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = server({ session: { deferSessionRefresh: true } });
      const c = createAuthClient({
        baseURL: BASE,
        basePath: "/api/auth",
        fetchOptions: { customFetchImpl: s.fetchImpl },
      });
      await c.signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
      const signedIn = await c.signIn.email({ email: "pat@example.com", password: PASSWORD });
      const native = createAuthClient({
        baseURL: BASE,
        basePath: "/api/auth",
        fetchOptions: {
          customFetchImpl: s.fetchImpl,
          headers: { authorization: `Bearer ${signedIn.data?.token}` },
        },
      });
      const days: { user: string | null; refreshes: number }[] = [];
      for (let day = 0; day < 10; day++) {
        if (day > 0) vi.setSystemTime(Date.now() + 86_400_000);
        const from = s.seen.length;
        const r = await native.getSession();
        const refreshes = s.seen
          .slice(from)
          .filter((q) => q.method === "POST" && q.url.endsWith("/api/auth/session/refresh")).length;
        days.push({ user: r.data?.user.email ?? null, refreshes });
      }
      // Better Auth's default updateAge is one day, so each later day is due once.
      expect(days).toEqual(
        Array.from({ length: 10 }, (_, d) => ({
          user: "pat@example.com",
          refreshes: d === 0 ? 0 : 1,
        })),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the GET answer when the deferred refresh fails (plan 12a)", async () => {
    const seen: string[] = [];
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: async (input, init) => {
          const req = new Request(input, init);
          seen.push(`${req.method} ${new URL(req.url).pathname}`);
          if (req.method === "POST")
            return new Response("<html>bad gateway</html>", { status: 502 });
          return Response.json({
            user: {
              id: "u1",
              email: "pat@example.com",
              emailVerified: true,
              name: null,
              image: null,
            },
            session: {
              id: "s1",
              expiresAt: "2026-01-08T00:00:00.000Z",
              activeOrganizationId: null,
            },
            needsRefresh: true,
          });
        },
      },
    });
    const r = await c.getSession();
    expect(r.error).toBeNull();
    expect(r.data?.user.email).toBe("pat@example.com");
    expect(seen).toEqual(["GET /api/auth/session", "POST /api/auth/session/refresh"]);
  });

  it("resends the verify mail through sendVerificationEmail (plan 8b)", async () => {
    const s = server();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    await c.signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    expect(await c.sendVerificationEmail({ email: "pat@example.com" })).toMatchObject({
      data: { status: true },
      error: null,
    });
    expect(
      s.mails.filter((m) => m.kind === "verify" && m.email === "pat@example.com"),
    ).toHaveLength(2);
  });

  it("answers core's body cap as PAYLOAD_TOO_LARGE with the status 413 (12j ruling 43)", async () => {
    const s = server();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    // More than the cap of the route (64 KiB) and than core's largest cap (8 MiB).
    const long = await c.sendVerificationEmail({ email: `${"x".repeat(9_000_000)}@example.com` });
    expect(long).toEqual({
      data: null,
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Payload too large",
        status: 413,
        statusText: "Payload Too Large",
      },
    });
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

  it("refuses additionalData at the social start, because no shim hook can read it", async () => {
    const s = server();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    const r = await c.signIn.social({
      provider: "google",
      disableRedirect: true,
      additionalData: { plan: "pro" },
    });
    expect(r).toEqual({
      data: null,
      error: expect.objectContaining({
        code: "NOT_SUPPORTED",
        message:
          "core takes no additionalData through the shim: use social.stateData of core's createAuth, and read stateData in its hooks.session.afterCreate and hooks.identity.afterLink",
      }),
    });
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
      ...(extra.webauthn ? { authtempo: { webauthn: extra.webauthn } } : {}),
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

  it("renames a passkey as Better Auth's updatePasskey does, and keeps an empty register name as none (plan 12a)", async () => {
    const s = server({
      plugins: [passkey({ rpID: "example.com", rpName: "Example", origin: BASE })],
    });
    const soft = await SoftAuthenticator.create({ rpID: "example.com", origin: BASE });
    const webauthn: BrowserWebAuthn = {
      create: async (options) => soft.register(options.challenge),
      get: async (options) => soft.authenticate(options.challenge),
    };
    await plain(s).signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    const token = await s.verifiedToken("pat@example.com");
    const c = plain(s, { headers: { authorization: `Bearer ${token}` }, webauthn });
    // Better Auth 1.7.2 trims the register name and keeps an empty one; core keeps none.
    const added = await c.passkey.addPasskey({ name: "  " });
    expect(added.error).toBeNull();
    expect(added.data?.name).toBeNull();
    const id = added.data?.id ?? "";
    const renamed = await c.passkey.updatePasskey({ id, name: " Work laptop  " });
    expect(renamed).toEqual({
      data: { passkey: { ...added.data, name: "Work laptop" } },
      error: null,
    });
    expect((await c.passkey.listUserPasskeys()).data?.map((p) => p.name)).toEqual(["Work laptop"]);
    expect(await c.passkey.updatePasskey({ id: "pk_unknown", name: "Mine" })).toEqual({
      data: null,
      error: {
        code: "PASSKEY_NOT_FOUND",
        message: "Passkey not found",
        status: 404,
        statusText: "Not Found",
      },
    });
    expect((await c.passkey.updatePasskey({ id, name: "   " })).error).toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
    });
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
  it("answers { token: null, user } and keeps no token at a sign-up with requireEmailVerification (plan 12b)", async () => {
    const s = server({ requireEmailVerification: true });
    const setItem = vi.fn();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [expoClient({ scheme: "reception", storage: { getItem: () => null, setItem } })],
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    const up = await c.signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    expect(up.error).toBeNull();
    expect(up.data).toMatchObject({ token: null, user: { email: "pat@example.com" } });
    expect(setItem).not.toHaveBeenCalled();
  });

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
    expect(c.getCookie()).toBe(`__Host-tempo_session=${up.data?.token}`);
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

describe("createAuthClient: fix round 1", () => {
  const expoOf = (s: ReturnType<typeof server>, fetchImpl?: typeof fetch, extra: object = {}) =>
    createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [
        expoClient({ scheme: "reception", storagePrefix: "reception", storage: memoryStorage() }),
      ],
      fetchOptions: { customFetchImpl: fetchImpl ?? s.fetchImpl, ...extra },
    });

  it("makes a client with no baseURL and no location without a throw, and answers an error at the call (consumere server render)", async () => {
    expect(typeof location).toBe("undefined");
    let c: ReturnType<typeof createAuthClient> | undefined;
    expect(() => {
      c = createAuthClient();
    }).not.toThrow();
    const r = await c?.signIn.email({ email: "a@example.com", password: PASSWORD });
    expect(r).toMatchObject({ data: null, error: { code: "BASE_URL_REQUIRED" } });
    expect(r?.error?.message).toContain("Pass baseURL");
    expect((await c?.signIn.social({ provider: "google" }))?.error?.code).toBe("BASE_URL_REQUIRED");
  });

  it("drops a session read that was in flight when the person signed out", async () => {
    const s = server();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held = false;
    const slow: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      const res = await s.fetchImpl(req);
      if (!held && req.method === "GET" && new URL(req.url).pathname.endsWith("/session")) {
        held = true;
        await gate;
      }
      return res;
    };
    const c = expoOf(s, slow);
    await c.signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    const stop = c.useSession.subscribe(() => {});
    await vi.waitFor(() => expect(held).toBe(true));
    await c.signOut();
    release();
    await vi.waitFor(() => expect(c.useSession.get().isPending).toBe(false));
    await vi.waitFor(() => expect(c.useSession.get().isRefetching).toBe(false));
    expect(c.useSession.get().data).toBeNull();
    stop();
  });

  it("stops waiting and shows the error when an app callback throws; an unreadable store means no token", async () => {
    const s = server();
    await expoOf(s).signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    const token = await s.verifiedToken("pat@example.com");
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: s.fetchImpl,
        headers: { authorization: `Bearer ${token}` },
        onSuccess: () => {
          throw new Error("app callback failed");
        },
      },
    });
    const stop = c.useSession.subscribe(() => {});
    await vi.waitFor(() => expect(c.useSession.get().isPending).toBe(false));
    expect(c.useSession.get().error).toMatchObject({ message: "app callback failed" });
    stop();
    const broken = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [
        expoClient({
          scheme: "reception",
          storage: {
            getItem: () => {
              throw new Error("store locked");
            },
            setItem: () => {},
          },
        }),
      ],
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    expect(() => broken.getCookie()).not.toThrow();
    expect(broken.getCookie()).toBe("");
    expect((await broken.getSession()).error).toBeNull();
  });

  it("hands onSuccess the final successful response once, never a failed sub-response or the session read", async () => {
    const s = server();
    const owner = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    await owner.signUp.email({ email: "owner@example.com", password: PASSWORD, name: "Owner" });
    const ownerToken = await s.verifiedToken("owner@example.com");
    const seen: { status: number; url: string }[] = [];
    const o = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: s.fetchImpl,
        headers: { authorization: `Bearer ${ownerToken}` },
        onSuccess: (ctx) => void seen.push({ status: ctx.response.status, url: ctx.request.url }),
      },
    });
    const orgId = (await o.organization.create({ name: "Acme", slug: "acme" })).data?.id ?? "";
    await o.organization.setActive({ organizationId: orgId });
    seen.length = 0;
    // No organizationId: the client reads the session first. That read stays silent.
    await o.organization.inviteMember({ email: "new@example.com", role: "member" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain("/organizations/invite");
    await owner.signUp.email({ email: "new@example.com", password: PASSWORD, name: "New" });
    const newToken = await s.verifiedToken("new@example.com");
    const seenMember: { status: number }[] = [];
    const n = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: s.fetchImpl,
        headers: { authorization: `Bearer ${newToken}` },
        onSuccess: (ctx) => void seenMember.push({ status: ctx.response.status }),
      },
    });
    await n.organization.acceptInvitation({ invitationId: s.invitations[0]?.id ?? "" });
    seenMember.length = 0;
    // A member below admin gets 403 from the invitations list inside this call.
    const full = await n.organization.getFullOrganization({ organizationId: orgId });
    expect(full.data?.invitations).toEqual([]);
    expect(seenMember).toEqual([{ status: 200 }]);
  });

  it("answers NOT_SUPPORTED for rememberMe: false and accepts true", async () => {
    const s = server();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    await c.signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    const refused = await c.signIn.email({
      email: "pat@example.com",
      password: PASSWORD,
      rememberMe: false,
    });
    expect(refused).toMatchObject({ data: null, error: { code: "NOT_SUPPORTED", status: 501 } });
    const accepted = await c.signIn.email({
      email: "pat@example.com",
      password: PASSWORD,
      rememberMe: true,
    });
    expect(accepted.error).toBeNull();
  });
});

describe("the shim's own codes (plan 9 final review M-4, M-5)", () => {
  const counted = () => {
    const calls: string[] = [];
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      fetchOptions: {
        customFetchImpl: async (input) => {
          calls.push(String(input));
          return new Response(null, { status: 500 });
        },
      },
    });
    return { c, calls };
  };

  it("answers BASE_URL_REQUIRED with status 0: no HTTP response exists", async () => {
    const r = await createAuthClient().signIn.email({ email: "a@example.com", password: PASSWORD });
    expect(r.error).toMatchObject({ code: "BASE_URL_REQUIRED", status: 0, statusText: "" });
  });

  it("answers NOT_SUPPORTED (501) for callbackURL on signIn.email and signUp.email and sends no request", async () => {
    const { c, calls } = counted();
    const signIn = await c.signIn.email({
      email: "pat@example.com",
      password: PASSWORD,
      callbackURL: "/welcome",
    });
    const signUp = await c.signUp.email({
      email: "pat@example.com",
      password: PASSWORD,
      name: "Pat",
      callbackURL: "/welcome",
    });
    for (const r of [signIn, signUp])
      expect(r).toMatchObject({ data: null, error: { code: "NOT_SUPPORTED", status: 501 } });
    expect(calls).toEqual([]);
  });

  it("lists every code of the table with its status in the README", () => {
    for (const [code, status] of Object.entries(COMPAT_CODES))
      expect({ code, row: readme.includes(`| \`${code}\` | ${status} |`) }).toEqual({
        code,
        row: true,
      });
  });

  it("gives each shim code the table's status in every README row that names it (plan 9b)", () => {
    // Every table row with a cell that is exactly a COMPAT_CODES code: the next cell is its status.
    const rows: { code: string; status: string }[] = [];
    for (const line of readme.split("\n").filter((l) => l.startsWith("|"))) {
      const cells = line.split("|").map((c) => c.trim());
      cells.forEach((c, i) => {
        const code = /^`([A-Z_]+)`$/.exec(c)?.[1];
        if (code && Object.hasOwn(COMPAT_CODES, code))
          rows.push({ code, status: cells[i + 1] ?? "" });
      });
    }
    // The codes table names each code once; the client-only table names two again.
    expect(rows.map((r) => r.code).sort()).toEqual(
      [...Object.keys(COMPAT_CODES), "INVALID_REDIRECT_URL", "BASE_URL_REQUIRED"].sort(),
    );
    for (const r of rows)
      expect(r).toEqual({
        code: r.code,
        status: String(COMPAT_CODES[r.code as keyof typeof COMPAT_CODES]),
      });
  });
});

describe("one status per code (plan 9b)", () => {
  it("answers INVALID_REDIRECT_URL with the table's 403 for the handoff mismatch, as the server does", async () => {
    const { handoffError } = await import("../src/client/create-auth-client.js");
    const { COMPAT_CODES } = await import("../src/errors.js");
    expect(handoffError({ code: "redirect_mismatch", status: 0 })).toEqual({
      code: "INVALID_REDIRECT_URL",
      message: "Invalid redirect url",
      status: COMPAT_CODES.INVALID_REDIRECT_URL,
      statusText: "Forbidden",
    });
  });
});

describe("createAuthClient: the residual throws (plan 9b2)", () => {
  it("refuses a relative or non-http baseURL at construction with one error", () => {
    expect(() => createAuthClient({ baseURL: "/api/auth" })).toThrow(
      "authtempo compat: baseURL must be an absolute http or https URL, for example https://api.example.com/api/auth; got /api/auth",
    );
    expect(() => createAuthClient({ baseURL: "ftp://files.example.com" })).toThrow(
      /must be an absolute http or https URL/,
    );
    expect(() => createAuthClient({ baseURL: `${BASE}/api/auth` })).not.toThrow();
    // No baseURL stays legal: the base is read at the first call (consumere's server render).
    expect(() => createAuthClient()).not.toThrow();
  });

  it("answers UNEXPECTED_RESPONSE, never a rejection, when the token store throws on write", async () => {
    const s = server();
    const onError = vi.fn();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [
        expoClient({
          scheme: "reception",
          storage: {
            getItem: () => null,
            setItem: () => {
              throw new Error("store full");
            },
          },
        }),
      ],
      fetchOptions: { customFetchImpl: s.fetchImpl, onError },
    });
    const up = await c.signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    expect(up).toMatchObject({ data: null, error: { code: "UNEXPECTED_RESPONSE", status: 0 } });
    expect(up.error?.message).toContain("store full");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].error).toMatchObject({ code: "UNEXPECTED_RESPONSE" });
    const signedIn = await c.signIn.email({ email: "pat@example.com", password: PASSWORD });
    expect(signedIn).toMatchObject({ data: null, error: { code: "UNEXPECTED_RESPONSE" } });
  });

  it("answers UNEXPECTED_RESPONSE, never a rejection, when the token store throws after a system-browser sign-in", async () => {
    const s = server();
    // The handoff redeem answers a real sign-up session, so the token store is the only step that fails.
    const redeeming: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      if (!new URL(req.url).pathname.endsWith("/handoff/redeem")) return s.fetchImpl(req);
      return s.fetchImpl(
        new Request(`${BASE}/api/auth/password/sign-up`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "pat@example.com", password: PASSWORD, name: "Pat" }),
        }),
      );
    };
    const onError = vi.fn();
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [
        expoClient({
          scheme: "reception",
          webBrowser: {
            openAuthSessionAsync: async () => ({
              type: "success",
              url: "reception://auth?code=c1",
            }),
          },
          storage: {
            getItem: () => null,
            setItem: () => {
              throw new Error("store full");
            },
          },
        }),
      ],
      fetchOptions: { customFetchImpl: redeeming, onError },
    });
    const social = await c.signIn.social({ provider: "google" });
    expect(social).toMatchObject({ data: null, error: { code: "UNEXPECTED_RESPONSE", status: 0 } });
    expect(social.error?.message).toContain("store full");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0].error).toMatchObject({ code: "UNEXPECTED_RESPONSE" });
  });

  it("ends the reads when a listener refetches on every notify", async () => {
    const s = server();
    let reads = 0;
    const counting: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      if (req.method === "GET" && new URL(req.url).pathname.endsWith("/session")) {
        reads++;
        // A runaway loop ends here, so a regression fails on the count and not on a crashed worker.
        if (reads === 50) stop();
      }
      return s.fetchImpl(req);
    };
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      plugins: [
        expoClient({ scheme: "reception", storagePrefix: "reception", storage: memoryStorage() }),
      ],
      fetchOptions: { customFetchImpl: counting },
    });
    // The listener of an app that refetches on each change it sees.
    const stop = c.useSession.subscribe(() => void c.useSession.refetch());
    await c.signUp.email({ email: "pat@example.com", password: PASSWORD, name: "Pat" });
    await vi.waitFor(() => expect(c.useSession.get().data?.user.email).toBe("pat@example.com"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = reads;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(settled);
    // Ceiling 3: a guarded store reads twice (first subscriber, sign-up refresh); one more is slack.
    expect(reads).toBeLessThanOrEqual(3);
    stop();
  });
});

describe("email codes on the client (plan 9e)", () => {
  function otpSetup(storage?: ReturnType<typeof memoryStorage>) {
    const codes: { email: string; otp: string; type: string }[] = [];
    const s = server({
      minPasswordLength: 12,
      plugins: [
        emailOTP({
          sendVerificationOTP: async (d) => {
            codes.push(d);
          },
        }),
      ],
    });
    const c = createAuthClient({
      baseURL: BASE,
      basePath: "/api/auth",
      ...(storage ? { plugins: [expoClient({ scheme: "reception", storage })] } : {}),
      fetchOptions: { customFetchImpl: s.fetchImpl },
    });
    return { s, c, codes };
  }

  it("sends a sign-in code and signs in with signIn.emailOtp, in Better Auth's shapes", async () => {
    const { s, c, codes } = otpSetup();
    expect(
      await c.emailOtp.sendVerificationOtp({ email: "otp@example.com", type: "sign-in" }),
    ).toEqual({ data: { success: true }, error: null });
    expect(codes).toEqual([
      { email: "otp@example.com", otp: expect.stringMatching(/^\d{6}$/), type: "sign-in" },
    ]);
    const otp = codes[0]?.otp ?? "";
    expect(
      await c.signIn.emailOtp({
        email: "otp@example.com",
        otp: otp === "000000" ? "111111" : "000000",
      }),
    ).toEqual({
      data: null,
      error: {
        code: "INVALID_OTP",
        message: "Invalid otp",
        status: 400,
        statusText: "Bad Request",
      },
    });
    const r = await c.signIn.emailOtp({ email: "otp@example.com", otp });
    expect(r.error).toBeNull();
    expect(r.data?.token).toMatch(/^ts_/);
    expect(Object.keys(r.data?.user ?? {}).sort()).toEqual([...CLIENT_USER_KEYS].sort());
    const me = await s.auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${r.data?.token}` }),
    });
    expect(me?.user.email).toBe("otp@example.com");
  });

  it("answers NOT_SUPPORTED for the other types and for a name, and sends no request", async () => {
    const { s, c } = otpSetup();
    const before = s.seen.length;
    for (const type of ["email-verification", "change-email"] as const)
      expect(
        (await c.emailOtp.sendVerificationOtp({ email: "otp@example.com", type })).error,
      ).toMatchObject({ code: "NOT_SUPPORTED", status: 501 });
    expect(
      (await c.signIn.emailOtp({ email: "otp@example.com", otp: "123456", name: "Pat" })).error,
    ).toMatchObject({ code: "NOT_SUPPORTED", status: 501 });
    expect(s.seen.length).toBe(before);
  });

  it("requests a reset code by forgetPassword.emailOtp and emailOtp.requestPasswordReset, and resets with emailOtp.resetPassword", async () => {
    const { s, c, codes } = otpSetup();
    await s.auth.api.signUpEmail({
      body: { email: "pat@example.com", password: PASSWORD, name: "Pat" },
    });
    expect(await c.forgetPassword.emailOtp({ email: "pat@example.com" })).toEqual({
      data: { success: true },
      error: null,
    });
    expect(await c.emailOtp.requestPasswordReset({ email: "pat@example.com" })).toEqual({
      data: { success: true },
      error: null,
    });
    expect(codes.map((x) => x.type)).toEqual(["forget-password", "forget-password"]);
    // 10 code points under minPasswordLength 12: core spends the code, and the client names the case.
    expect(
      (
        await c.emailOtp.resetPassword({
          email: "pat@example.com",
          otp: codes.at(-1)?.otp ?? "",
          password: "ten chars!",
        })
      ).error,
    ).toMatchObject({ code: "PASSWORD_TOO_SHORT", status: 400 });
    await c.emailOtp.requestPasswordReset({ email: "pat@example.com" });
    expect(
      await c.emailOtp.resetPassword({
        email: "pat@example.com",
        otp: codes.at(-1)?.otp ?? "",
        password: "a new correct horse",
      }),
    ).toEqual({ data: { success: true }, error: null });
    const signedIn = await s.auth.api.signInEmail({
      body: { email: "pat@example.com", password: "a new correct horse" },
    });
    expect(signedIn.user.email).toBe("pat@example.com");
  });

  it("answers success for a malformed address and sends no code; every policy refusal of resetPassword spends the code (README, M-8)", async () => {
    const { s, c, codes } = otpSetup();
    for (const type of ["sign-in", "forget-password"] as const)
      expect(await c.emailOtp.sendVerificationOtp({ email: "not-an-email", type })).toEqual({
        data: { success: true },
        error: null,
      });
    expect(codes).toEqual([]);
    await s.auth.api.signUpEmail({
      body: { email: "pat@example.com", password: PASSWORD, name: "Pat" },
    });
    for (const [password, code] of [
      ["ten chars!", "PASSWORD_TOO_SHORT"],
      ["x".repeat(129), "PASSWORD_TOO_LONG"],
    ] as const) {
      await c.emailOtp.requestPasswordReset({ email: "pat@example.com" });
      const otp = codes.at(-1)?.otp ?? "";
      expect(
        (await c.emailOtp.resetPassword({ email: "pat@example.com", otp, password })).error,
      ).toMatchObject({ code, status: 400 });
      // The refusal spent the code: the same code with a good password answers INVALID_OTP.
      expect(
        (
          await c.emailOtp.resetPassword({
            email: "pat@example.com",
            otp,
            password: "a new correct horse",
          })
        ).error,
      ).toMatchObject({ code: "INVALID_OTP", status: 400 });
    }
  });

  it("keeps the session token in the Expo store after signIn.emailOtp", async () => {
    const storage = memoryStorage();
    const { c, codes } = otpSetup(storage);
    await c.emailOtp.sendVerificationOtp({ email: "otp@example.com", type: "sign-in" });
    const r = await c.signIn.emailOtp({ email: "otp@example.com", otp: codes[0]?.otp ?? "" });
    expect(r.error).toBeNull();
    expect(storage.map.get("better-auth_tempo_session")).toBe(r.data?.token);
  });
});
