import { createClient } from "@authtempo/client";
import { createAuth, createMemoryAdapter, createPbkdf2PasswordHash } from "@authtempo/core";
import { base32Decode, TEST_SECRET, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";

const BASE = "https://api.example.com";
const PASSWORD = "correct horse battery staple";

/** The fields of a new OIDC connection, but its organization. */
const OIDC = {
  kind: "oidc",
  label: "Acme staff",
  issuer: "https://login.idp.example/acme",
  clientId: "acme",
  clientSecret: "acme-secret-0123456789",
} as const;

/** The token of the link in the last mail. */
function linkToken(sent: readonly string[]): string {
  return decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(sent.at(-1) ?? "")?.[1] ?? "");
}

/**
 * Core in process with organizations and OIDC connections on (plan 12l). The
 * client's fetch calls `auth.handle`, as in oauth-register.test.ts. Each user
 * comes through the product: no test writes a row to the storage.
 */
function world() {
  const sent: string[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: TEST_SECRET,
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async (m) => void sent.push(m.text) },
    // A fast hash: the test signs in one user, and the hash is not under test.
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    organizations: {},
    // No domain is added here, so the resolver answers no record.
    sso: { oidc: true, dns: [{ name: "none", txt: async () => [] }] },
  });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    auth.handle(new Request(input, init))) as typeof globalThis.fetch;
  /** The client of one session: the token travels as a bearer token. */
  const clientOf = (token: string) =>
    createClient({ baseURL: BASE, fetch, token: () => token, broadcast: false });
  /** One JSON POST to a route of core with the session token. */
  const post = async (path: string, body: unknown, token: string) => {
    const res = await auth.handle(
      new Request(`${BASE}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { auth, sent, clientOf, post };
}

/**
 * The owner of a new organization who may manage its SSO setup. A password
 * sign-up that the mailed link verifies, then a sign-in, so the session is
 * fresh. Then `createOrganization`, and TOTP through `POST /totp/setup` and
 * `POST /totp/enable`. The setup takes the password, so the manager has one.
 */
async function manager(w: ReturnType<typeof world>) {
  const { password } = w.auth.api;
  if (!password) throw new Error("password must be on");
  const email = "owner@example.com";
  const up = await password.signUp({ email, password: PASSWORD, ip: null, userAgent: null });
  if (!up.ok) throw new Error(up.code);
  const token0 = linkToken(w.sent);
  const verified = await password.verifyEmail({ token: token0, ip: null, userAgent: null });
  if (!verified.ok) throw new Error(verified.code);
  const signedIn = await password.signIn({ email, password: PASSWORD, ip: null, userAgent: null });
  if (!signedIn.ok || !("token" in signedIn.value)) throw new Error("no session");
  const token = signedIn.value.token;
  const session = await w.auth.api.getSession(token);
  if (!session) throw new Error("no session");
  const made = await w.auth.api.createOrganization({
    user: session.user,
    slug: "acme",
    name: "Acme",
  });
  if (!made.ok) throw new Error(made.code);
  const setup = await w.post("/totp/setup", { password: PASSWORD }, token);
  const secret = setup.body.secret;
  if (setup.status !== 200 || typeof secret !== "string") throw new Error("no TOTP setup");
  const code = await totpCode(base32Decode(secret), new Date());
  expect(await w.post("/totp/enable", { code }, token)).toMatchObject({
    status: 200,
    body: { enabled: true, methods: ["totp"] },
  });
  return { client: w.clientOf(token), organizationId: made.value.organization.id };
}

/** A verified user who manages no organization: a magic-link sign-in. */
async function plainUser(w: ReturnType<typeof world>) {
  const asked = await w.auth.api.requestMagicLink({ email: "member@example.com", ip: null });
  if (!asked.ok) throw new Error(asked.code);
  const token0 = linkToken(w.sent);
  const signedIn = await w.auth.api.verifyMagicLink({ token: token0, ip: null, userAgent: null });
  if (!signedIn.ok || !("token" in signedIn.value)) throw new Error("no session");
  expect(signedIn.value.user.emailVerified).toBe(true);
  return w.clientOf(signedIn.value.token);
}

/**
 * The client's two SSO connection writes against core in process (plan 12l,
 * ruling 11). Core runs the manager guard before it reads the body, so the
 * client sends the id in the query. Only these tests send the two writes of
 * the client to core: the client's own tests answer them from a mock.
 */
describe("the client's SSO connection writes against core (plan 12l)", () => {
  it("creates a connection of the manager's organization, then updates its label", async () => {
    const w = world();
    const m = await manager(w);
    const created = await m.client.sso.connections.create({
      organizationId: m.organizationId,
      ...OIDC,
    });
    // toEqual, not toMatchObject: a refusal then shows its code and status.
    expect(created).toEqual({
      ok: true,
      value: expect.objectContaining({
        organizationId: m.organizationId,
        kind: "oidc",
        label: "Acme staff",
      }),
    });
    if (!created.ok) throw new Error(created.code);
    const updated = await m.client.sso.connections.update({
      id: created.value.id,
      label: "Acme people",
    });
    expect(updated).toEqual({
      ok: true,
      value: expect.objectContaining({
        id: created.value.id,
        organizationId: m.organizationId,
        label: "Acme people",
      }),
    });
    // The list reads the row back: the update reached the storage.
    const listed = await m.client.sso.connections.list({ organizationId: m.organizationId });
    expect(listed).toEqual({
      ok: true,
      value: [expect.objectContaining({ id: created.value.id, label: "Acme people" })],
    });
  });

  it("answers forbidden_rank to the create of a verified user who manages no organization", async () => {
    const w = world();
    const m = await manager(w);
    const plain = await plainUser(w);
    expect(
      await plain.sso.connections.create({ organizationId: m.organizationId, ...OIDC }),
    ).toEqual({ ok: false, code: "forbidden_rank", status: 403 });
    // No row: the manager's list is empty.
    expect(await m.client.sso.connections.list({ organizationId: m.organizationId })).toEqual({
      ok: true,
      value: [],
    });
  });
});
