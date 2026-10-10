import { env, SELF } from "cloudflare:test";
import {
  createAuthClient,
  expoClient,
  organizationClient,
} from "@tempo-auth/compat-better-auth/client";
import { expect, it } from "vitest";

const BASE = "https://example.test";
const customFetchImpl: typeof fetch = (input, init) => SELF.fetch(input, init);
const PASSWORD = "correct horse battery";

async function lastLink(): Promise<string> {
  return ((await (await SELF.fetch(`${BASE}/__test/compat-last-link`)).json()) as { link: string })
    .link;
}
async function me(headers: Record<string, string>) {
  const res = await SELF.fetch(`${BASE}/compat/me`, { headers });
  return {
    status: res.status,
    body:
      res.status === 200
        ? ((await res.json()) as {
            id: string;
            email: string;
            name: string;
            activeOrganizationId: string | null;
          })
        : null,
  };
}
async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

it("runs consumere's surface: sign-up, sign-in, the server session, social start, sign-out", async () => {
  const web = createAuthClient({ baseURL: BASE, fetchOptions: { customFetchImpl } });
  const up = await web.signUp.email({ name: "Pat", email: "pat@example.com", password: PASSWORD });
  expect(up.error).toBeNull();
  expect(up.data?.user).toMatchObject({
    email: "pat@example.com",
    name: "Pat",
    emailVerified: false,
  });
  expect((await lastLink()).startsWith(`${BASE}/api/auth/password/verify?token=pv_`)).toBe(true);
  // The session table holds the token hash, never the token (spec 16.2).
  const tokens = await env.BA_DB.prepare(`SELECT "token" FROM "session"`).all<{ token: string }>();
  expect(tokens.results.map((r) => r.token)).toEqual([await sha256Hex(up.data?.token ?? "")]);

  const signedIn = await web.signIn.email({ email: "pat@example.com", password: PASSWORD });
  const token = signedIn.data?.token ?? "";
  expect(token).toMatch(/^ts_/);
  expect(await me({ cookie: `tempo_session=${token}` })).toMatchObject({
    status: 200,
    body: { email: "pat@example.com", name: "Pat" },
  });

  const social = await web.signIn.social({
    provider: "google",
    callbackURL: "/dashboard",
    disableRedirect: true,
  });
  const start = await SELF.fetch(social.data?.url ?? "", { redirect: "manual" });
  expect(start.status).toBe(302);
  expect(start.headers.get("location")?.startsWith("https://accounts.google.com/")).toBe(true);

  expect(
    (await web.sendVerificationEmail({ email: "pat@example.com", callbackURL: "/dashboard" }))
      .error,
  ).toMatchObject({ code: "NOT_SUPPORTED", status: 501 });

  const signedInClient = createAuthClient({
    baseURL: BASE,
    fetchOptions: { customFetchImpl, headers: { cookie: `tempo_session=${token}` } },
  });
  expect((await signedInClient.signOut()).data).toEqual({ success: true });
  expect((await me({ cookie: `tempo_session=${token}` })).status).toBe(401);
});

it("runs consumer-i's dashboard and mobile surfaces: organizations, the bearer header, Expo getCookie", async () => {
  const seen: string[] = [];
  const mobile = createAuthClient({
    baseURL: BASE,
    basePath: "/api/auth",
    fetchOptions: {
      customFetchImpl,
      onSuccess: (ctx) => {
        const t = ctx.response.headers.get("set-auth-token");
        if (t) seen.push(t);
      },
    },
    plugins: [
      expoClient({ scheme: "reception", storagePrefix: "reception", storage: memoryStorage() }),
      organizationClient(),
    ],
  });
  const up = await mobile.signUp.email({
    name: "Robin",
    email: "robin@example.com",
    password: PASSWORD,
  });
  expect(up.error).toBeNull();
  expect(seen).toEqual([up.data?.token]);
  expect(mobile.getCookie()).toBe(`tempo_session=${up.data?.token}`);
  expect((await me({ cookie: mobile.getCookie() })).body?.email).toBe("robin@example.com");

  // Confirm the address by the mailed link, as a person does, so organization writes are allowed.
  const verify = new URL(await lastLink());
  const confirmed = await SELF.fetch(`${BASE}/api/auth/password/verify`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ token: verify.searchParams.get("token") ?? "" }).toString(),
  });
  expect(confirmed.status).toBe(302);
  const cookie = /tempo_session=[^;]+/.exec(confirmed.headers.get("set-cookie") ?? "")?.[0] ?? "";
  expect(cookie).toMatch(/^tempo_session=ts_/);

  const dashboard = createAuthClient({
    baseURL: BASE,
    basePath: "/api/auth",
    plugins: [organizationClient()],
    fetchOptions: { customFetchImpl, headers: { cookie } },
  });
  const created = await dashboard.organization.create({ name: "Front Desk", slug: "front-desk" });
  expect(created.error).toBeNull();
  const orgId = created.data?.id ?? "";
  expect((await dashboard.organization.setActive({ organizationId: orgId })).data?.id).toBe(orgId);
  expect((await me({ cookie })).body?.activeOrganizationId).toBe(orgId);
  const invited = await dashboard.organization.inviteMember({
    email: "new@example.com",
    role: "member",
  });
  expect(invited.data).toMatchObject({
    organizationId: orgId,
    email: "new@example.com",
    role: "member",
    status: "pending",
  });
  expect((await lastLink()).startsWith("invitation:inv_")).toBe(true);
  const rows = await env.BA_DB.prepare(
    `SELECT "id", "status", "taTokenHash" FROM "invitation"`,
  ).all<{ id: string; status: string; taTokenHash: string }>();
  // The app sees the row id; the mail callback alone holds the token, and the row holds its hash.
  expect(rows.results).toEqual([
    {
      id: invited.data?.id,
      status: "pending",
      taTokenHash: await sha256Hex((await lastLink()).slice("invitation:".length)),
    },
  ]);

  await mobile.signOut();
  expect(mobile.getCookie()).toBe("");
});

it("signs in a Better Auth-era user with the scrypt hash and rehashes it to PBKDF2 in workerd", async () => {
  // As Better Auth 1.7.2 writes them: the recorded vector of Task 2, ISO dates, the credential row keyed by the user id.
  await env.BA_DB.batch([
    env.BA_DB.prepare(
      `INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES ('ba-u','Bea','bea@example.com',1,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
    ),
    env.BA_DB.prepare(
      `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt","taLinkedAt") VALUES ('ba-cred','local:credential','ba-u','credential','ba-u','8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
    ),
  ]);
  const web = createAuthClient({ baseURL: BASE, fetchOptions: { customFetchImpl } });
  const r = await web.signIn.email({ email: "bea@example.com", password: PASSWORD });
  expect(r.error).toBeNull();
  expect(r.data?.user).toMatchObject({ id: "ba-u", name: "Bea", emailVerified: true });
  const stored = await env.BA_DB.prepare(
    `SELECT "password" FROM "account" WHERE "id" = 'ba-cred'`,
  ).first<{ password: string }>();
  expect(stored?.password).toMatch(/^pbkdf2-sha256\$1000\$/);
  expect(
    (await web.signIn.email({ email: "bea@example.com", password: PASSWORD })).error,
  ).toBeNull();
});

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}
