import {
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  systemClock,
} from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import { betterAuthPasswordHash } from "../src/hash.js";
import { bearer, expo, magicLink, organization, passkey } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import type { BetterAuthOptions, CompatDatabase, InvitationEmailData } from "../src/types.js";

const BASE = "https://api.example.com";
const APP = "https://app.example.com";
const memoryDatabase = (): CompatDatabase => ({
  kind: "tempo-auth-compat-database",
  dialect: "postgres",
  storage: createMemoryAdapter(),
  limiter: createMemoryLimiter(systemClock),
});
const fast = betterAuthPasswordHash({ pbkdf2: createPbkdf2PasswordHash({ iterations: 1000 }) });
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

function base(extra: Partial<BetterAuthOptions> = {}): BetterAuthOptions {
  return {
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP, "reception://"],
    database: memoryDatabase(),
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: {
      sendVerificationEmail: async (d) =>
        void verifyLinks.push({ email: d.user.email, url: d.url }),
    },
    tempoAuth: { passwordHash: fast },
    ...extra,
  };
}

/** Every verify link the mail port handed to sendVerificationEmail. */
const verifyLinks: { email: string; url: string }[] = [];

/**
 * A verified user with a session, as a person reaches it: sign up, confirm
 * the mailed verify link, and sign in again. The confirm claims the address,
 * and the claim ends the sign-up session (core `engine/users.ts` claimEmail),
 * so the sign-up token is dead after it. The session here is the new sign-in's.
 */
async function verifiedUser(auth: ReturnType<typeof betterAuth>, email: string) {
  const password = "correct horse battery";
  const up = await auth.api.signUpEmail({ body: { email, password, name: "Pat" } });
  // The newest link for the address: two tests use one address.
  const link = [...verifyLinks].reverse().find((l) => l.email === email)?.url;
  if (!link) throw new Error(`no verify link for ${email}`);
  const confirmed = await auth.handler(
    new Request(`${BASE}/api/auth/password/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({
        token: new URL(link).searchParams.get("token") ?? "",
      }).toString(),
    }),
  );
  if (confirmed.status !== 302) throw new Error(`the verify link answered ${confirmed.status}`);
  // The sign-up session ended at the claim.
  expect(
    await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${up.token}` }) }),
  ).toBeNull();
  const signedIn = await auth.api.signInEmail({ body: { email, password } });
  return {
    token: signedIn.token,
    headers: new Headers({ authorization: `Bearer ${signedIn.token}` }),
    userId: up.user.id,
  };
}

describe("organization()", () => {
  it("mails the invitation through sendInvitationEmail with the token as data.id", async () => {
    const mails: InvitationEmailData[] = [];
    const auth = betterAuth(
      base({
        plugins: [
          organization({
            invitationExpiresIn: 3 * 86400,
            sendInvitationEmail: async (d) => void mails.push(d),
          }),
        ],
      }),
    );
    const owner = await verifiedUser(auth, "owner@example.com");
    const created = await auth.tempo.handle(
      new Request(
        `${BASE}/api/auth/organizations/create`,
        json({ slug: "acme", name: "Acme" }, { authorization: `Bearer ${owner.token}` }),
      ),
    );
    expect(created.status).toBe(200);
    const orgId = ((await created.json()) as { organization: { id: string } }).organization.id;
    const inv = await auth.api.createInvitation({
      body: { email: "new@example.com", role: "member", organizationId: orgId },
      headers: owner.headers,
    });
    expect(inv).toMatchObject({
      organizationId: orgId,
      email: "new@example.com",
      role: "member",
      status: "pending",
    });
    expect(inv.expiresAt.getTime() - inv.createdAt.getTime()).toBe(3 * 86400 * 1000);
    expect(mails).toHaveLength(1);
    const mail = mails[0];
    expect(mail?.id).toBe(mail?.invitation.id);
    expect(mail?.id).not.toBe(inv.id);
    expect(mail).toMatchObject({
      email: "new@example.com",
      role: "member",
      organization: { slug: "acme", name: "Acme" },
      inviter: { user: { email: "owner@example.com" } },
    });
    const invitee = await verifiedUser(auth, "new@example.com");
    const accepted = await auth.tempo.handle(
      new Request(
        `${BASE}/api/auth/organizations/invitations/accept`,
        json({ token: mail?.id }, { authorization: `Bearer ${invitee.token}` }),
      ),
    );
    expect(accepted.status).toBe(200);
  });

  it("lists, activates, and cancels through api with Better Auth's shapes", async () => {
    const auth = betterAuth(
      base({ plugins: [organization({ sendInvitationEmail: async () => {} })] }),
    );
    const owner = await verifiedUser(auth, "owner@example.com");
    const r = await auth.tempo.handle(
      new Request(
        `${BASE}/api/auth/organizations/create`,
        json({ slug: "acme", name: "Acme" }, { authorization: `Bearer ${owner.token}` }),
      ),
    );
    const orgId = ((await r.json()) as { organization: { id: string } }).organization.id;
    expect(await auth.api.listOrganizations({ headers: owner.headers })).toEqual([
      {
        id: orgId,
        name: "Acme",
        slug: "acme",
        logo: null,
        metadata: null,
        createdAt: expect.any(Date),
      },
    ]);
    expect(
      (
        await auth.api.setActiveOrganization({
          body: { organizationId: orgId },
          headers: owner.headers,
        })
      )?.id,
    ).toBe(orgId);
    expect(
      (await auth.api.getSession({ headers: owner.headers }))?.session.activeOrganizationId,
    ).toBe(orgId);
    const inv = await auth.api.createInvitation({
      body: { email: "x@example.com", role: "member" },
      headers: owner.headers,
    });
    expect(inv.organizationId).toBe(orgId);
    expect(
      (await auth.api.cancelInvitation({ body: { invitationId: inv.id }, headers: owner.headers }))
        .status,
    ).toBe("canceled");
    await expect(
      auth.api.cancelInvitation({ body: { invitationId: inv.id }, headers: owner.headers }),
    ).rejects.toMatchObject({ statusCode: 404, body: { code: "INVITATION_NOT_FOUND" } });
    expect(
      await auth.api.setActiveOrganization({
        body: { organizationId: null },
        headers: owner.headers,
      }),
    ).toBeNull();
  });
});

describe("magicLink()", () => {
  it("mails the link through sendMagicLink with the plugin's lifetime", async () => {
    const sent: { email: string; url: string; token: string }[] = [];
    // appURL: the callbackURL is absolute on the app origin, which toNext keeps only for appURL.
    const options = base({
      plugins: [magicLink({ expiresIn: 600, sendMagicLink: async (d) => void sent.push(d) })],
      tempoAuth: { passwordHash: fast, appURL: APP },
    });
    expect(mapOptions(options).config.magicLink).toEqual({ ttlMinutes: 10 });
    const auth = betterAuth(options);
    expect(
      await auth.api.signInMagicLink({
        body: { email: "pat@example.com", callbackURL: `${APP}/dashboard?x=1` },
      }),
    ).toEqual({ status: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email).toBe("pat@example.com");
    expect(sent[0]?.url.startsWith(`${BASE}/api/auth/magic-link/verify?token=`)).toBe(true);
    expect(sent[0]?.url).toContain(encodeURIComponent(sent[0]?.token ?? "x"));
  });

  it("answers 404 on every magic link path without the plugin", async () => {
    const auth = betterAuth(base());
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/magic-link/request`, json({ email: "pat@example.com" })),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    // Core also mounts GET and POST /magic-link/verify (core http/routes/magic-link.ts).
    const getVerify = await auth.handler(new Request(`${BASE}/api/auth/magic-link/verify?token=x`));
    expect([getVerify.status, await getVerify.json()]).toEqual([404, { error: "not_found" }]);
    const postVerify = await auth.handler(
      new Request(`${BASE}/api/auth/magic-link/verify`, json({ token: "x" }, { origin: APP })),
    );
    expect([postVerify.status, await postVerify.json()]).toEqual([404, { error: "not_found" }]);
    await expect(
      auth.api.signInMagicLink({ body: { email: "pat@example.com" } }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("passkey()", () => {
  it("maps rpID, rpName, and origin, and core refuses an origin that is not trusted", () => {
    const m = mapOptions(
      base({ plugins: [passkey({ rpID: "example.com", rpName: "Ex", origin: APP })] }),
    );
    expect(m.config.passkey).toEqual({ rpID: "example.com", rpName: "Ex", origins: [APP] });
    expect(() =>
      betterAuth(
        base({
          plugins: [
            passkey({ rpID: "example.com", rpName: "Ex", origin: "https://other.example.com" }),
          ],
        }),
      ),
    ).toThrowError(/config: passkey\.origins has https:\/\/other\.example\.com/);
  });
});

describe("bearer()", () => {
  it("copies the session token into set-auth-token, as Better Auth's bearer plugin does", async () => {
    const withBearer = betterAuth(base({ plugins: [bearer()] }));
    const res = await withBearer.handler(
      new Request(
        `${BASE}/api/auth/password/sign-up`,
        json({ email: "pat@example.com", password: "correct horse battery" }, { origin: APP }),
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(res.headers.get("set-auth-token")).toBe(body.token);
    expect(res.headers.get("access-control-expose-headers")).toContain("set-auth-token");
    const without = betterAuth(base());
    const plain = await without.handler(
      new Request(
        `${BASE}/api/auth/password/sign-up`,
        json({ email: "pat@example.com", password: "correct horse battery" }, { origin: APP }),
      ),
    );
    expect(plain.status).toBe(200);
    expect(plain.headers.get("set-auth-token")).toBeNull();
  });
});

describe("expo()", () => {
  it("maps the app schemes of trustedOrigins to the handoff", () => {
    const withMagic = base({ plugins: [expo(), magicLink({ sendMagicLink: async () => {} })] });
    expect(mapOptions(withMagic).config.handoff).toEqual({ schemes: ["reception://"] });
    expect(mapOptions(base({ plugins: [expo()] })).config.handoff).toMatchObject({
      schemes: ["reception://"],
    });
    expect(checkOptions(base({ trustedOrigins: [APP], plugins: [expo()] })).refusals).toEqual([
      "plugins[expo]: needs the app scheme, for example myapp://, in trustedOrigins",
    ]);
  });

  it("puts expo-origin into origin before core's Origin check", async () => {
    const request = () =>
      new Request(
        `${BASE}/api/auth/password/sign-in`,
        json(
          { email: "pat@example.com", password: "correct horse battery" },
          { "expo-origin": "evil://" },
        ),
      );
    const withExpo = betterAuth(base({ plugins: [expo()] }));
    const refused = await withExpo.handler(request());
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "origin_not_trusted" });
    const without = betterAuth(base());
    expect((await without.handler(request())).status).toBe(401);
  });

  it("passes a trusted expo-origin to core's Origin check", async () => {
    const auth = betterAuth(base({ plugins: [expo()] }));
    const res = await auth.handler(
      new Request(
        `${BASE}/api/auth/password/sign-in`,
        json(
          { email: "pat@example.com", password: "correct horse battery" },
          { "expo-origin": "reception://" },
        ),
      ),
    );
    // Past the Origin check: the route runs and refuses the unknown address.
    expect([res.status, await res.json()]).toEqual([401, { error: "invalid_credentials" }]);
  });

  it("keeps a real Origin header over expo-origin", async () => {
    const auth = betterAuth(base({ plugins: [expo()] }));
    const res = await auth.handler(
      new Request(
        `${BASE}/api/auth/password/sign-in`,
        json(
          { email: "pat@example.com", password: "correct horse battery" },
          { origin: APP, "expo-origin": "evil://" },
        ),
      ),
    );
    expect([res.status, await res.json()]).toEqual([401, { error: "invalid_credentials" }]);
  });

  it("refuses expo() when the system-browser page would have no sign-in method", () => {
    const noMethod = base({ emailAndPassword: { enabled: false }, plugins: [expo()] });
    expect(checkOptions(noMethod).refusals).toEqual([
      "plugins[expo]: the system-browser page has no sign-in method; add magicLink, emailAndPassword, a social provider, or passkey",
    ]);
    const withPasskey = base({
      emailAndPassword: { enabled: false },
      plugins: [expo(), passkey({ rpID: "example.com", rpName: "Ex", origin: APP })],
    });
    expect(checkOptions(withPasskey).refusals).toEqual([]);
  });

  it("counts GitHub or LinkedIn as a method of the system-browser page (plan 9c)", () => {
    const pair = { clientId: "x", clientSecret: "y" };
    const off = { enabled: false };
    for (const only of [
      base({ emailAndPassword: off, socialProviders: { github: pair }, plugins: [expo()] }),
      base({ emailAndPassword: off, socialProviders: { linkedin: pair }, plugins: [expo()] }),
    ])
      expect(checkOptions(only).refusals).toEqual([]);
  });

  it("offers the magic link on the system-browser page only with the magicLink plugin", () => {
    const input = {
      basePath: "/api/auth",
      continuePath: "/api/auth/handoff/continue?h=hs_1",
      methods: {
        magicLink: true,
        google: false,
        apple: false,
        passkey: false,
        password: true,
        providers: [],
      },
      nonce: "n",
      appName: "App",
    };
    const page = mapOptions(base({ plugins: [expo()] })).config.handoff?.signInPage;
    expect(page).toBeTypeOf("function");
    const html = page?.(input) ?? "";
    expect(html).not.toContain(`id="magic-link"`);
    expect(html).toContain(`id="password"`);
    // With the plugin, core's default page with every method core serves.
    expect(
      mapOptions(base({ plugins: [expo(), magicLink({ sendMagicLink: async () => {} })] })).config
        .handoff?.signInPage,
    ).toBeUndefined();
  });
});

describe("a plugin given twice", () => {
  it("is refused by name in the one refusal list", () => {
    const twice = base({
      plugins: [
        magicLink({ sendMagicLink: async () => {} }),
        magicLink({ expiresIn: 3600, sendMagicLink: async () => {} }),
      ],
    });
    expect(checkOptions(twice).refusals).toEqual(["plugins[magic-link]: given twice; pass one"]);
    expect(() => betterAuth(twice)).toThrowError(
      /\n- plugins\[magic-link\]: given twice; pass one$/,
    );
  });
});

describe("a send callback the enabled plugin needs", () => {
  it("refuses magicLink() without sendMagicLink at construction", () => {
    const noCallback = {} as Parameters<typeof magicLink>[0];
    expect(() => betterAuth(base({ plugins: [magicLink(noCallback)] }))).toThrowError(
      /\n- plugins\[magic-link\]\.sendMagicLink: required$/,
    );
  });

  it("refuses organization() without sendInvitationEmail at construction", () => {
    expect(() => betterAuth(base({ plugins: [organization({})] }))).toThrowError(
      /\n- plugins\[organization\]\.sendInvitationEmail: required: core mails every invitation$/,
    );
  });
});
