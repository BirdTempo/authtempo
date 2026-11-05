import { env, SELF } from "cloudflare:test";
import {
  createAuthClient,
  expoClient,
  organizationClient,
} from "@authtempo/compat-better-auth/client";
import { expect, it } from "vitest";

const BASE = "https://example.test";
const customFetchImpl: typeof fetch = (input, init) => SELF.fetch(input, init);
const PASSWORD = "correct horse battery";

/** A run-unique suffix. Each test seeds its own addresses and ids, so no test reads another test's rows. */
function unique(): string {
  return crypto.randomUUID().slice(0, 8);
}
async function lastLink(to: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/__test/compat-last-link?to=${encodeURIComponent(to)}`);
  return ((await res.json()) as { link: string | null }).link ?? "";
}
async function me(headers: Record<string, string>) {
  const res = await SELF.fetch(`${BASE}/compat/me`, { headers });
  return {
    status: res.status,
    body: (await res.json()) as {
      id?: string;
      email?: string;
      name?: string;
      activeOrganizationId?: string | null;
      error?: string;
    },
  };
}
const UNAUTHENTICATED = { status: 401, body: { error: "unauthorized" } };
/** Confirms an address by its mailed link, as a person does. Answers the session cookie the verify route sets. */
async function confirmByLink(link: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth/password/verify`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ token: new URL(link).searchParams.get("token") ?? "" }).toString(),
  });
  expect(res.status).toBe(302);
  return /__Host-tempo_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0] ?? "";
}
async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

it("runs consumere's surface: sign-up, sign-in, the server session, social start, sign-out", async () => {
  const email = `pat-${unique()}@example.com`;
  const web = createAuthClient({ baseURL: BASE, fetchOptions: { customFetchImpl } });
  const up = await web.signUp.email({ name: "Pat", email, password: PASSWORD });
  expect(up.error).toBeNull();
  expect(up.data?.user).toMatchObject({ email, name: "Pat", emailVerified: false });
  expect((await lastLink(email)).startsWith(`${BASE}/api/auth/password/verify?token=pv_`)).toBe(
    true,
  );
  // The session table holds the token hash, never the token (spec 16.2).
  const upToken = up.data?.token ?? "";
  const byHash = await env.BA_DB.prepare(`SELECT "userId" FROM "session" WHERE "token" = ?`)
    .bind(await sha256Hex(upToken))
    .all<{ userId: string }>();
  expect(byHash.results).toEqual([{ userId: up.data?.user.id }]);
  const byRaw = await env.BA_DB.prepare(`SELECT count(*) AS n FROM "session" WHERE "token" = ?`)
    .bind(upToken)
    .first<{ n: number }>();
  expect(byRaw?.n).toBe(0);

  const signedIn = await web.signIn.email({ email, password: PASSWORD });
  expect(signedIn.error).toBeNull();
  expect(signedIn.data).toMatchObject({ redirect: false, user: { email, name: "Pat" } });
  const token = signedIn.data?.token ?? "";
  expect(token).toMatch(/^ts_/);
  expect(await me({ cookie: `__Host-tempo_session=${token}` })).toMatchObject({
    status: 200,
    body: { email, name: "Pat" },
  });

  const social = await web.signIn.social({
    provider: "google",
    callbackURL: "/dashboard",
    disableRedirect: true,
  });
  expect(social.error).toBeNull();
  const start = await SELF.fetch(social.data?.url ?? "", { redirect: "manual" });
  expect(start.status).toBe(302);
  const google = new URL(start.headers.get("location") ?? "");
  expect(google.origin).toBe("https://accounts.google.com");
  expect(google.searchParams.get("client_id")).toBe("example-client");
  expect(google.searchParams.get("redirect_uri")?.startsWith(`${BASE}/api/auth/`)).toBe(true);
  expect(google.searchParams.get("state")).toMatch(/.{16,}/);
  expect(start.headers.get("set-cookie")).toBeTruthy();

  const resend = await web.sendVerificationEmail({ email, callbackURL: "/dashboard" });
  expect(resend.data).toBeNull();
  expect(resend.error).toMatchObject({ code: "NOT_SUPPORTED", status: 501 });

  const signedInClient = createAuthClient({
    baseURL: BASE,
    fetchOptions: { customFetchImpl, headers: { cookie: `__Host-tempo_session=${token}` } },
  });
  const out = await signedInClient.signOut();
  expect(out.error).toBeNull();
  expect(out.data).toEqual({ success: true });
  expect(await me({ cookie: `__Host-tempo_session=${token}` })).toEqual(UNAUTHENTICATED);
});

it("runs consumer-i's dashboard and mobile surfaces: organizations, the bearer header, Expo getCookie", async () => {
  const run = unique();
  const ownerEmail = `robin-${run}@example.com`;
  const inviteeEmail = `sam-${run}@example.com`;
  const slug = `front-desk-${run}`;
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
  const up = await mobile.signUp.email({ name: "Robin", email: ownerEmail, password: PASSWORD });
  expect(up.error).toBeNull();
  const mobileToken = up.data?.token ?? "";
  expect(seen).toEqual([mobileToken]);
  expect(mobile.getCookie()).toBe(`__Host-tempo_session=${mobileToken}`);
  expect((await me({ cookie: mobile.getCookie() })).body.email).toBe(ownerEmail);

  // The bearer header, both ways: the token from set-auth-token grants the session; a wrong or absent one does not.
  expect(await me({ authorization: `Bearer ${mobileToken}` })).toMatchObject({
    status: 200,
    body: { email: ownerEmail, name: "Robin" },
  });
  expect(await me({ authorization: `Bearer ${mobileToken}x` })).toEqual(UNAUTHENTICATED);
  expect(await me({ authorization: "Bearer ts_not-a-session" })).toEqual(UNAUTHENTICATED);
  expect(await me({})).toEqual(UNAUTHENTICATED);
  const bearerClient = createAuthClient({
    baseURL: BASE,
    basePath: "/api/auth",
    fetchOptions: { customFetchImpl, headers: { authorization: `Bearer ${mobileToken}` } },
  });
  const viaBearer = await bearerClient.getSession();
  expect(viaBearer.error).toBeNull();
  expect(viaBearer.data?.user).toMatchObject({ email: ownerEmail });
  const wrongBearer = createAuthClient({
    baseURL: BASE,
    basePath: "/api/auth",
    fetchOptions: { customFetchImpl, headers: { authorization: `Bearer ${mobileToken}x` } },
  });
  expect(await wrongBearer.getSession()).toEqual({ data: null, error: null });

  // Confirm the address by the mailed link, as a person does, so organization writes are allowed.
  const cookie = await confirmByLink(await lastLink(ownerEmail));
  expect(cookie).toMatch(/^__Host-tempo_session=ts_/);
  // The link opened outside the app, with no sign-up proof, so the claim took
  // the password (ruling 11 of plan 12q). The owner sets a first password on
  // the proved and fresh session of the confirm, with no current password.
  const first = await SELF.fetch(`${BASE}/api/auth/password/change`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, cookie },
    body: JSON.stringify({ newPassword: PASSWORD }),
  });
  expect(first.status).toBe(200);

  const dashboard = createAuthClient({
    baseURL: BASE,
    basePath: "/api/auth",
    plugins: [organizationClient()],
    fetchOptions: { customFetchImpl, headers: { cookie } },
  });
  const created = await dashboard.organization.create({ name: "Front Desk", slug });
  expect(created.error).toBeNull();
  const orgId = created.data?.id ?? "";
  // The Better Auth shape consumer-i reads: name, slug, and the creator as the one owner.
  expect(created.data).toMatchObject({
    name: "Front Desk",
    slug,
    logo: null,
    members: [{ organizationId: orgId, userId: up.data?.user.id, role: "owner" }],
  });
  expect(created.data?.members).toHaveLength(1);
  const active = await dashboard.organization.setActive({ organizationId: orgId });
  expect(active.error).toBeNull();
  expect(active.data).toMatchObject({ id: orgId, name: "Front Desk", slug });
  expect((await me({ cookie })).body.activeOrganizationId).toBe(orgId);
  const invited = await dashboard.organization.inviteMember({
    email: inviteeEmail,
    role: "member",
  });
  expect(invited.error).toBeNull();
  expect(invited.data).toMatchObject({
    organizationId: orgId,
    email: inviteeEmail,
    role: "member",
    status: "pending",
  });
  // The mail callback's data.id is the token, the accept capability. inviteMember answers the row id.
  const mailed = await lastLink(inviteeEmail);
  expect(mailed.startsWith("invitation:inv_")).toBe(true);
  const invitationToken = mailed.slice("invitation:".length);
  expect(invitationToken).not.toBe(invited.data?.id);
  const rows = await env.BA_DB.prepare(
    `SELECT "id", "status", "taTokenHash" FROM "invitation" WHERE "organizationId" = ?`,
  )
    .bind(orgId)
    .all<{ id: string; status: string; taTokenHash: string }>();
  // The row holds the token hash, never the token.
  expect(rows.results).toEqual([
    { id: invited.data?.id, status: "pending", taTokenHash: await sha256Hex(invitationToken) },
  ]);

  // The invited person signs up, confirms the address, and accepts with the id from the mail.
  const invitee = createAuthClient({
    baseURL: BASE,
    basePath: "/api/auth",
    fetchOptions: { customFetchImpl },
  });
  const inviteeUp = await invitee.signUp.email({
    name: "Sam",
    email: inviteeEmail,
    password: PASSWORD,
  });
  expect(inviteeUp.error).toBeNull();
  const inviteeCookie = await confirmByLink(await lastLink(inviteeEmail));
  const inviteeDashboard = createAuthClient({
    baseURL: BASE,
    basePath: "/api/auth",
    plugins: [organizationClient()],
    fetchOptions: { customFetchImpl, headers: { cookie: inviteeCookie } },
  });
  const accepted = await inviteeDashboard.organization.acceptInvitation({
    invitationId: invitationToken,
  });
  expect(accepted.error).toBeNull();
  expect(accepted.data).toMatchObject({
    member: { organizationId: orgId, userId: inviteeUp.data?.user.id, role: "member" },
    organization: { id: orgId, name: "Front Desk", slug },
  });
  const after = await env.BA_DB.prepare(`SELECT "status" FROM "invitation" WHERE "id" = ?`)
    .bind(invited.data?.id ?? "")
    .first<{ status: string }>();
  expect(after?.status).toBe("accepted");
  const members = await env.BA_DB.prepare(
    `SELECT "userId", "role" FROM "member" WHERE "organizationId" = ? ORDER BY "role"`,
  )
    .bind(orgId)
    .all<{ userId: string; role: string }>();
  expect(members.results).toEqual([
    { userId: inviteeUp.data?.user.id, role: "member" },
    { userId: up.data?.user.id, role: "owner" },
  ]);

  // The confirm above ended the sign-up session, so sign in again: the sign-out
  // check below must read a session that is live right before the sign-out.
  const again = await mobile.signIn.email({ email: ownerEmail, password: PASSWORD });
  expect(again.error).toBeNull();
  const liveToken = again.data?.token ?? "";
  expect(liveToken).not.toBe(mobileToken);
  expect(mobile.getCookie()).toBe(`__Host-tempo_session=${liveToken}`);
  expect(await me({ authorization: `Bearer ${liveToken}` })).toMatchObject({
    status: 200,
    body: { email: ownerEmail },
  });
  const out = await mobile.signOut();
  expect(out.error).toBeNull();
  expect(out.data).toEqual({ success: true });
  expect(mobile.getCookie()).toBe("");
  // The server session ended too, not only the local store.
  expect(await me({ authorization: `Bearer ${liveToken}` })).toEqual(UNAUTHENTICATED);
});

it("signs in a Better Auth-era user with the scrypt hash and rehashes it to PBKDF2 in workerd", async () => {
  const run = unique();
  const userId = `ba-u-${run}`;
  const credId = `ba-cred-${run}`;
  const email = `bea-${run}@example.com`;
  const scrypt =
    "8b963491c29137940a209e5a26de719e:b4ce8a3b919a25198f84eebbede27d1cd0fda32747c6489f0997b993a16de0a2381351c5595013552488269e72aa6507da171fac50e68ce5ff7173ff58b554d3";
  // As Better Auth 1.7.2 writes them after migration 0001: Better Auth's columns only, no ta column.
  // The recorded vector of Task 2, ISO dates, the credential row keyed by the user id.
  // taLinkedAt stays NULL, so the read must fill it from createdAt.
  await env.BA_DB.batch([
    env.BA_DB.prepare(
      `INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt") VALUES (?,'Bea',?,1,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
    ).bind(userId, email),
    env.BA_DB.prepare(
      `INSERT INTO "account" ("id","issuer","accountId","providerId","userId","password","createdAt","updatedAt") VALUES (?,'local:credential',?,'credential',?,?,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
    ).bind(credId, userId, userId, scrypt),
  ]);
  const storedHash = async () =>
    (
      await env.BA_DB.prepare(`SELECT "password" FROM "account" WHERE "id" = ?`)
        .bind(credId)
        .first<{ password: string }>()
    )?.password;
  const web = createAuthClient({ baseURL: BASE, fetchOptions: { customFetchImpl } });

  // A wrong password on the scrypt row answers Better Auth's invalid-credentials shape and changes nothing.
  const wrong = await web.signIn.email({ email, password: "wrong horse battery" });
  expect(wrong.data).toBeNull();
  expect(wrong.error).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 });
  expect(await storedHash()).toBe(scrypt);

  const r = await web.signIn.email({ email, password: PASSWORD });
  expect(r.error).toBeNull();
  expect(r.data?.user).toMatchObject({ id: userId, name: "Bea", email, emailVerified: true });
  expect(await storedHash()).toMatch(/^pbkdf2-sha256\$1000\$/);

  const again = await web.signIn.email({ email, password: PASSWORD });
  expect(again.error).toBeNull();
  expect(again.data?.user).toMatchObject({ id: userId });
  // After the rehash, a wrong password still fails.
  const wrongAfter = await web.signIn.email({ email, password: "wrong horse battery" });
  expect(wrongAfter.data).toBeNull();
  expect(wrongAfter.error).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 });
});

it("signs in a user whose rows predate migration 0001: the migration filled the ta columns", async () => {
  // test/setup.ts seeds this account before migration 0001, with Better Auth's columns only.
  const linkedAt = async () =>
    (
      await env.BA_DB.prepare(
        `SELECT "taLinkedAt" FROM "account" WHERE "id" = 'ba-pre-cred'`,
      ).first<{
        taLinkedAt: string | null;
      }>()
    )?.taLinkedAt;
  expect(await linkedAt()).toBe("2026-08-01T00:00:00.000Z");
  const web = createAuthClient({ baseURL: BASE, fetchOptions: { customFetchImpl } });
  const r = await web.signIn.email({ email: "pre-0001@example.com", password: PASSWORD });
  expect(r.error).toBeNull();
  expect(r.data?.user).toMatchObject({ id: "ba-pre-u", email: "pre-0001@example.com" });
  expect(await linkedAt()).toBe("2026-08-01T00:00:00.000Z");
});

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}
