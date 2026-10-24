import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { deleteAccount } from "../src/engine/account-delete.js";
import {
  acceptInvitation,
  declineInvitation,
  inviteMember,
  revokeInvitation,
} from "../src/engine/invitations.js";
import { mintSessionJwt, rotateKey, signToken } from "../src/engine/jwt.js";
import { createClient } from "../src/engine/oauth-client-store.js";
import { revokeGrant } from "../src/engine/oauth-grants.js";
import { banUser } from "../src/engine/operator/ban.js";
import { requireOperatorUser } from "../src/engine/operator/guards.js";
import { grantPlatformRole, revokePlatformRole } from "../src/engine/operator/platform-role.js";
import {
  createOrganizationToken,
  revokeOrganizationToken,
  updateOrganizationToken,
} from "../src/engine/organization-tokens.js";
import {
  addMember,
  createOrganization,
  deleteOrganization,
  removeMember,
  updateMemberRole,
  updateOrganization,
} from "../src/engine/organizations.js";
import { createRole, deleteRole, updateRole } from "../src/engine/roles.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { sweepExpired } from "../src/engine/sweep.js";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  removeTeamMember,
  updateTeam,
} from "../src/engine/teams.js";
import type { AuthEvent } from "../src/observe/port.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { newId } from "../src/primitives/ids.js";
import { decodeJws } from "../src/primitives/jwk.js";
import type { UserRow } from "../src/schema.js";
import { BASE_URL, makeAuth, post, seedPlatform } from "./helpers.js";
import {
  approvedDevice,
  authorized,
  basicHeader,
  codeFor,
  exchange,
  oauthHandle,
  pkce,
  RESOURCE,
  SCOPES,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";
import {
  OPERATOR_SECRETS,
  operatorAuth,
  operatorFixture,
  operatorHeader,
  secretActor,
} from "./operator-helpers.js";
import { FAST } from "./password-helpers.js";
import { totpAuth, verifiedSession } from "./totp-helpers.js";

/** A sink that keeps each batch. `all()` flushes the observer of `flush` and answers every event so far. */
function recorder() {
  const batches: AuthEvent[][] = [];
  return {
    sink: { write: (b: readonly AuthEvent[]) => void batches.push([...b]) },
    batches,
    events: async (flush: () => Promise<void>) => {
      await flush();
      return batches.flat();
    },
  };
}

const named = (events: AuthEvent[], name: string) => events.filter((e) => e.name === name);

/** The fields of an event that a flow chose: no stamp of the observer. */
function own(e: AuthEvent | undefined): Record<string, unknown> {
  if (!e) return {};
  const { at: _a, traceId: _t, spanId: _s, parentSpanId: _p, level: _l, ...rest } = e;
  return rest;
}

async function seed(auth: ReturnType<typeof makeAuth>, email: string): Promise<UserRow> {
  return auth.seedUser(email);
}

/** An organization of `owner`, created through the engine. */
async function orgOf(auth: ReturnType<typeof makeAuth>, owner: UserRow, slug = "acme") {
  const r = await createOrganization(auth.config, { user: owner, slug, name: "Acme" });
  if (!r.ok) throw new Error(r.code);
  return r.value.organization;
}

const invitationTokenOf = (text: string) => {
  const m = /invitation=(inv_[A-Za-z0-9_-]+)/.exec(text);
  if (!m?.[1]) throw new Error("no invitation token in the mail");
  return m[1];
};

/** The routes of tokens over one storage, with a recording sink (plan 12h Task 6). */
function tokenWorld() {
  const r = recorder();
  const base = makeAuth({ organizations: {} });
  const auth = createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: ["https://app.example.com"],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: base.config.limiter,
    organizations: {},
    observe: { sink: r.sink },
  });
  const events = () => r.events(() => auth.observe.flush());
  return { ...base, auth, events };
}

describe("the token events (plan 12h Task 6)", () => {
  it("emits api_token.create on a token create through its route", async () => {
    const w = tokenWorld();
    const user = await seed(w, "ada@example.com");
    const { token } = await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
    const res = await w.auth.handle(
      post("/auth/tokens", { name: "ci" }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const { apiToken } = (await res.json()) as { apiToken: { id: string } };
    const [made] = named(await w.events(), "api_token.create");
    expect(own(made)).toEqual({
      name: "api_token.create",
      route: "POST /tokens",
      kind: "tk",
      tokenId: apiToken.id,
      outcome: "success",
    });
    // The route passes the scope of its request: no field is rejected, so no `unscoped` mark.
    expect(made?.rejected).toBeUndefined();
  });

  it("emits api_token.update on a token update through its route", async () => {
    const w = tokenWorld();
    const user = await seed(w, "ada@example.com");
    const { token } = await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
    const auth = { authorization: `Bearer ${token}` };
    const made = (await (
      await w.auth.handle(post("/auth/tokens", { name: "ci" }, auth))
    ).json()) as {
      apiToken: { id: string };
    };
    const res = await w.auth.handle(
      post("/auth/tokens/update", { id: made.apiToken.id, name: "ci-2" }, auth),
    );
    expect(res.status).toBe(200);
    const updates = named(await w.events(), "api_token.update");
    expect(updates.map(own)).toEqual([
      {
        name: "api_token.update",
        route: "POST /tokens/update",
        kind: "tk",
        tokenId: made.apiToken.id,
        outcome: "success",
      },
    ]);
  });

  it("emits api_token.revoke on a token revoke through its route, and none for an unknown id", async () => {
    const w = tokenWorld();
    const user = await seed(w, "ada@example.com");
    const { token } = await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
    const auth = { authorization: `Bearer ${token}` };
    const made = (await (
      await w.auth.handle(post("/auth/tokens", { name: "ci" }, auth))
    ).json()) as {
      apiToken: { id: string };
    };
    expect(
      (await w.auth.handle(post("/auth/tokens/revoke", { id: made.apiToken.id }, auth))).status,
    ).toBe(200);
    expect(
      (await w.auth.handle(post("/auth/tokens/revoke", { id: made.apiToken.id }, auth))).status,
    ).toBe(404);
    const revokes = named(await w.events(), "api_token.revoke");
    expect(revokes.map(own)).toEqual([
      {
        name: "api_token.revoke",
        route: "POST /tokens/revoke",
        kind: "tk",
        tokenId: made.apiToken.id,
        outcome: "success",
      },
    ]);
  });

  it("names an organization token with the kind to and its organization", async () => {
    const r = recorder();
    const auth = makeAuth({ organizations: {}, observe: { sink: r.sink } });
    const owner = await seed(auth, "owner@example.com");
    const org = await orgOf(auth, owner);
    const made = await createOrganizationToken(auth.config, {
      user: owner,
      organizationId: org.id,
      name: "deploy",
      permissions: {},
    });
    if (!made.ok) throw new Error(made.code);
    const id = made.value.apiToken.id;
    const changed = await updateOrganizationToken(auth.config, {
      user: owner,
      organizationId: org.id,
      id,
      name: "deploy-2",
    });
    expect(changed.ok).toBe(true);
    expect(
      await revokeOrganizationToken(auth.config, { user: owner, organizationId: org.id, id }),
    ).toEqual({ ok: true, value: { ok: true } });
    const events = (await r.events(() => auth.config.observe.flush())).filter((e) =>
      e.name.startsWith("api_token."),
    );
    const body = { kind: "to", tokenId: id, organizationId: org.id, outcome: "success" };
    expect(events.map(own)).toEqual([
      { name: "api_token.create", ...body },
      { name: "api_token.update", ...body },
      { name: "api_token.revoke", ...body },
    ]);
  });
});

describe("the JWT events (plan 12h Task 6)", () => {
  it("emits jwt.mint on a session JWT mint, with the key that signed", async () => {
    const r = recorder();
    const auth = makeAuth({ observe: { sink: r.sink } });
    const user = await seed(auth, "ada@example.com");
    const { session } = await createSession(auth.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    const minted = await mintSessionJwt(auth.config, { userId: user.id, sessionId: session.id });
    if (!minted.ok) throw new Error(minted.code);
    const kid = decodeJws(minted.value.token)?.header.kid;
    const events = await r.events(() => auth.config.observe.flush());
    expect(named(events, "jwt.mint").map(own)).toEqual([
      { name: "jwt.mint", kid, userId: user.id, sessionId: session.id, outcome: "success" },
    ]);
    // A refused mint is the answer of its route or of the api call: no event (plan 12h Task 5 rule).
    expect((await mintSessionJwt(auth.config, { userId: user.id, sessionId: "nope" })).ok).toBe(
      false,
    );
    expect(named(await r.events(() => auth.config.observe.flush()), "jwt.mint")).toHaveLength(1);
  });

  it("emits jwt.key_retire on a rotate and on the rotateEvery timer, with the cause", async () => {
    const r = recorder();
    const auth = makeAuth({ jwtMint: { rotateEvery: 1 }, observe: { sink: r.sink } });
    const kidOf = (t: string) => decodeJws(t)?.header.kid;
    const first = kidOf(await signToken(auth.config, "JWT", { sub: "u" }));
    const { kid: second } = await rotateKey(auth.config);
    auth.clock.advance(86_400_000);
    const third = kidOf(await signToken(auth.config, "JWT", { sub: "u" }));
    expect(new Set([first, second, third]).size).toBe(3);
    const events = await r.events(() => auth.config.observe.flush());
    expect(named(events, "jwt.key_retire").map(own)).toEqual([
      { name: "jwt.key_retire", kid: first, why: "rotate" },
      { name: "jwt.key_retire", kid: second, why: "timer" },
    ]);
  });

  it("emits jwt.key_retire with the cause alg when the config moves to another alg", async () => {
    const auth = makeAuth();
    const first = decodeJws(await signToken(auth.config, "JWT", { sub: "u" }))?.header.kid;
    const r = recorder();
    const es = makeAuth({
      storage: auth.storage,
      clock: auth.clock,
      jwtMint: { alg: "ES256" },
      observe: { sink: r.sink },
    });
    const next = decodeJws(await signToken(es.config, "JWT", { sub: "u" }))?.header.kid;
    expect(next).not.toBe(first);
    const events = await r.events(() => es.config.observe.flush());
    expect(named(events, "jwt.key_retire").map(own)).toEqual([
      { name: "jwt.key_retire", kid: first, why: "alg" },
    ]);
  });

  it("emits jwt.key_retire with the cause unopened for a key of another app secret", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = makeAuth();
    const first = decodeJws(await signToken(auth.config, "JWT", { sub: "u" }))?.header.kid;
    const r = recorder();
    const other = makeAuth({
      storage: auth.storage,
      clock: auth.clock,
      secret: "another secret of 32 characters!",
      observe: { sink: r.sink },
    });
    const next = decodeJws(await signToken(other.config, "JWT", { sub: "u" }))?.header.kid;
    expect(next).not.toBe(first);
    const events = await r.events(() => other.config.observe.flush());
    expect(named(events, "jwt.key_retire").map(own)).toEqual([
      { name: "jwt.key_retire", kid: first, why: "unopened" },
    ]);
    log.mockRestore();
  });
});

/** The OAuth provider with a recording sink. */
function oauthWorld(extra: Partial<AuthConfig> = {}) {
  const r = recorder();
  const h = oauthHandle({ observe: { sink: r.sink }, ...extra });
  return { ...h, events: () => r.events(() => h.auth.observe.flush()) };
}

const CLIENT_ID_RE = /^cl_[A-Za-z0-9_-]+$/;

describe("the OAuth events (plan 12h Task 6)", () => {
  it("emits oauth.client_register on a dynamic registration", async () => {
    const h = oauthWorld();
    const res = await h.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: ["https://client.example.com/callback"],
        client_name: "Doc",
      }),
    );
    expect(res.status).toBe(201);
    const { client_id } = (await res.json()) as { client_id: string };
    expect(client_id).toMatch(CLIENT_ID_RE);
    expect(named(await h.events(), "oauth.client_register").map(own)).toEqual([
      {
        name: "oauth.client_register",
        route: "POST /oauth/register",
        clientRef: client_id,
        outcome: "success",
      },
    ]);
  });

  it("emits oauth.client_register for a client of the api, and its refusal with the code", async () => {
    const r = recorder();
    const auth = makeAuth({
      oauth: { resources: [RESOURCE], scopes: SCOPES, registration: { cimd: false } },
      observe: { sink: r.sink },
    });
    const made = await createClient(auth.config, {
      redirectUris: ["https://client.example.com/callback"],
      name: "Api client",
    });
    if (!made.ok) throw new Error(made.error);
    const refused = await createClient(auth.config, { redirectUris: ["not a url"], name: "Bad" });
    expect(refused).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    const events = await r.events(() => auth.config.observe.flush());
    expect(named(events, "oauth.client_register").map(own)).toEqual([
      { name: "oauth.client_register", clientRef: made.value.client.id, outcome: "success" },
      { name: "oauth.client_register", outcome: "failure", code: "invalid_redirect_uri" },
    ]);
  });

  it("emits oauth.authorize on a code issue", async () => {
    const h = oauthWorld();
    const c = await codeFor(h);
    const events = named(await h.events(), "oauth.authorize");
    expect(events.map(own)).toEqual([
      {
        name: "oauth.authorize",
        route: "POST /oauth/authorize",
        clientRef: c.clientId,
        outcome: "success",
      },
    ]);
  });

  it("emits oauth.token on a code exchange and a refresh, with the grant", async () => {
    const h = oauthWorld();
    const c = await codeFor(h);
    const res = await h.auth.handle(exchange(c.code, c.clientId, c.verifier));
    expect(res.status).toBe(200);
    const { refresh_token } = (await res.json()) as { refresh_token: string };
    const again = await h.auth.handle(
      tokenPost({ grant_type: "refresh_token", refresh_token, client_id: c.clientId }),
    );
    expect(again.status).toBe(200);
    // A spent code answers invalid_grant: the request event carries it, not oauth.token.
    expect((await h.auth.handle(exchange(c.code, c.clientId, c.verifier))).status).toBe(400);
    const body = { route: "POST /oauth/token", clientRef: c.clientId, outcome: "success" };
    expect(named(await h.events(), "oauth.token").map(own)).toEqual([
      { name: "oauth.token", grant: "authorization_code", ...body },
      { name: "oauth.token", grant: "refresh_token", ...body },
    ]);
  });

  it("emits oauth.token on a device code poll, with the grant", async () => {
    const h = oauthWorld({
      oauth: {
        resources: [RESOURCE],
        scopes: SCOPES,
        registration: { cimd: false, dynamic: true },
        device: {},
      },
    });
    const registered = await h.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: ["https://client.example.com/callback"],
        client_name: "Living room TV",
        grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
      }),
    );
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const s = await signedIn(h);
    const deviceCode = await approvedDevice(h, client_id, s.cookie);
    const res = await h.auth.handle(
      tokenPost({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id,
      }),
    );
    expect(res.status).toBe(200);
    expect(named(await h.events(), "oauth.token").map(own)).toEqual([
      {
        name: "oauth.token",
        grant: "urn:ietf:params:oauth:grant-type:device_code",
        route: "POST /oauth/token",
        clientRef: client_id,
        outcome: "success",
      },
    ]);
  });

  it("emits oauth.token on a client_credentials grant, with the grant", async () => {
    const h = oauthWorld();
    const clients = h.auth.api.oauth?.clients;
    if (!clients) throw new Error("oauth is off");
    const made = await clients.create({
      name: "Billing service",
      authMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      credentialsScopes: ["mcp:read"],
    });
    if (!made.ok) throw new Error(made.error);
    const clientId = made.value.client.id;
    const res = await h.auth.handle(
      tokenPost(
        { grant_type: "client_credentials", resource: RESOURCE },
        { authorization: basicHeader(clientId, made.value.clientSecret ?? "") },
      ),
    );
    expect(res.status).toBe(200);
    expect(named(await h.events(), "oauth.token").map(own)).toEqual([
      {
        name: "oauth.token",
        grant: "client_credentials",
        route: "POST /oauth/token",
        clientRef: clientId,
        outcome: "success",
      },
    ]);
  });

  it("emits oauth.revoke on a token revoke and on a grant revoke", async () => {
    const h = oauthWorld();
    const c = await codeFor(h);
    const { refresh_token } = (await (
      await h.auth.handle(exchange(c.code, c.clientId, c.verifier))
    ).json()) as { refresh_token: string };
    const res = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refresh_token, client_id: c.clientId }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    expect(named(await h.events(), "oauth.revoke").map(own)).toEqual([
      {
        name: "oauth.revoke",
        route: "POST /oauth/revoke",
        clientRef: c.clientId,
        outcome: "success",
      },
    ]);
    // The engine view of the same input has its own observer, and the same sink.
    expect(await revokeGrant(h.config, { userId: c.user.id, clientId: c.clientId })).toEqual({
      ok: true,
      value: { ok: true },
    });
    await h.config.observe.flush();
    expect(
      named(await h.events(), "oauth.revoke")
        .map(own)
        .slice(1),
    ).toEqual([{ name: "oauth.revoke", clientRef: c.clientId, outcome: "success" }]);
  });

  it("names a client by its ref, never by its metadata URL", async () => {
    const DOC_URL = "https://client.example.com/oauth/metadata.json";
    const doc = {
      client_id: DOC_URL,
      client_name: "Doc client",
      redirect_uris: ["https://client.example.com/cb"],
      token_endpoint_auth_method: "none",
    };
    const fetch = (async () =>
      new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    const h = oauthWorld({ oauth: { resources: [RESOURCE], scopes: SCOPES, fetch } });
    const s = await signedIn(h);
    const p = await pkce();
    const { code } = await authorized(h, s.cookie, {
      clientId: DOC_URL,
      challenge: p.challenge,
      redirectUri: "https://client.example.com/cb",
    });
    const res = await h.auth.handle(
      exchange(code, DOC_URL, p.verifier, { redirect_uri: "https://client.example.com/cb" }),
    );
    expect(res.status).toBe(200);
    const events = await h.events();
    const refs = events.filter((e) => e.name.startsWith("oauth.")).map((e) => e.clientRef);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) expect(ref).toMatch(/^cimd:[0-9a-f]{32}$/);
    expect(JSON.stringify(events)).not.toContain("client.example.com");
  });
});

/** The engine view with organizations, teams, and dynamic roles, and a recording sink. */
function orgWorld() {
  const r = recorder();
  const auth = makeAuth({
    organizations: { teams: {}, dynamicRoles: {} },
    observe: { sink: r.sink },
  });
  return { auth, events: () => r.events(() => auth.config.observe.flush()) };
}

describe("the organization events (plan 12h Task 6)", () => {
  it("emits organization.change on each organization act, with the action of its after point", async () => {
    const { auth, events } = orgWorld();
    const owner = await seed(auth, "owner@example.com");
    const bob = await seed(auth, "bob@example.com");
    const carol = await seed(auth, "carol@example.com");
    const org = await orgOf(auth, owner);
    const must = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
      if (!r.ok) throw new Error(r.code);
      return r.value;
    };
    const o = { user: owner, organizationId: org.id };
    must(await updateOrganization(auth.config, { ...o, name: "Acme 2" }));
    must(await addMember(auth.config, { ...o, userId: bob.id, role: "member" }));
    must(await updateMemberRole(auth.config, { ...o, userId: bob.id, role: "admin" }));
    const team = must(await createTeam(auth.config, { ...o, name: "Core" }));
    must(await updateTeam(auth.config, { user: owner, teamId: team.id, name: "Core 2" }));
    must(await addTeamMember(auth.config, { user: owner, teamId: team.id, userId: bob.id }));
    must(await removeTeamMember(auth.config, { user: owner, teamId: team.id, userId: bob.id }));
    must(await deleteTeam(auth.config, { user: owner, teamId: team.id }));
    must(await removeMember(auth.config, { ...o, userId: bob.id }));
    const revoked = must(
      await inviteMember(auth.config, { ...o, email: "dan@example.com", role: "member" }),
    );
    must(await revokeInvitation(auth.config, { ...o, invitationId: revoked.id }));
    must(await inviteMember(auth.config, { ...o, email: "carol@example.com", role: "member" }));
    must(
      await acceptInvitation(auth.config, {
        user: carol,
        token: invitationTokenOf(auth.mail.at(-1)?.text ?? ""),
        ip: null,
      }),
    );
    must(await inviteMember(auth.config, { ...o, email: "erin@example.com", role: "member" }));
    must(
      await declineInvitation(auth.config, {
        token: invitationTokenOf(auth.mail.at(-1)?.text ?? ""),
      }),
    );
    must(await deleteOrganization(auth.config, o));
    const changes = named(await events(), "organization.change");
    for (const c of changes) expect(c.organizationId).toBe(org.id);
    expect(changes.map((c) => c.action)).toEqual([
      "addMember",
      "create",
      "update",
      "addMember",
      "updateMemberRole",
      "createTeam",
      "updateTeam",
      "addTeamMember",
      "removeTeamMember",
      "deleteTeam",
      "removeMember",
      "invite",
      "revokeInvitation",
      "invite",
      "addMember",
      "acceptInvitation",
      "invite",
      "declineInvitation",
      "delete",
    ]);
    expect(changes.every((c) => c.rejected === undefined)).toBe(true);
  });

  it("emits organization.change with updateMemberRole when an accept raises the role of a member", async () => {
    const { auth, events } = orgWorld();
    const owner = await seed(auth, "owner@example.com");
    const bob = await seed(auth, "bob@example.com");
    const org = await orgOf(auth, owner);
    const o = { user: owner, organizationId: org.id };
    expect((await addMember(auth.config, { ...o, userId: bob.id, role: "member" })).ok).toBe(true);
    expect(
      (await inviteMember(auth.config, { ...o, email: "bob@example.com", role: "admin" })).ok,
    ).toBe(true);
    const accepted = await acceptInvitation(auth.config, {
      user: bob,
      token: invitationTokenOf(auth.mail.at(-1)?.text ?? ""),
      ip: null,
    });
    expect(accepted.ok && accepted.value.member.role).toBe("admin");
    const changes = named(await events(), "organization.change");
    // The create gives addMember and create; then addMember and invite. The accept adds no member row.
    expect(changes.map(own).slice(4)).toEqual([
      { name: "organization.change", action: "updateMemberRole", organizationId: org.id },
      { name: "organization.change", action: "acceptInvitation", organizationId: org.id },
    ]);
  });

  it("emits organization.change for each organization that an account delete takes", async () => {
    const r = recorder();
    const auth = totpAuth({ organizations: {}, observe: { sink: r.sink } });
    const me = await verifiedSession(auth, "ada@example.com");
    const solo = await orgOf(auth, me.user, "solo");
    expect(await deleteAccount(auth.config, { session: me, ip: null, userAgent: null })).toEqual({
      ok: true,
      value: { ok: true },
    });
    const changes = named(await r.events(() => auth.config.observe.flush()), "organization.change");
    // The create gives addMember and create; the delete gives delete.
    expect(changes.map(own).slice(2)).toEqual([
      { name: "organization.change", action: "delete", organizationId: solo.id },
    ]);
  });

  it("emits organization.change on a grant and a revoke of the platform role", async () => {
    const r = recorder();
    const auth = await operatorAuth({ observe: { sink: r.sink } });
    const { platformOrg } = await seedPlatform(auth);
    const target = await verifiedSession(auth, "target@example.com");
    const actor = await secretActor(auth, OPERATOR_SECRETS.support);
    const act = {
      actor,
      userId: target.user.id,
      reason: "Support case 9",
      ip: null,
      userAgent: null,
    };
    expect((await grantPlatformRole(auth.config, act)).ok).toBe(true);
    expect((await revokePlatformRole(auth.config, act)).ok).toBe(true);
    const changes = named(await r.events(() => auth.config.observe.flush()), "organization.change");
    expect(changes.map(own)).toEqual([
      { name: "organization.change", action: "addMember", organizationId: platformOrg.id },
      { name: "organization.change", action: "removeMember", organizationId: platformOrg.id },
    ]);
  });

  it("emits organization.change with updateMemberRole when the platform role is a part of a member row", async () => {
    const r = recorder();
    const auth = await operatorAuth({ observe: { sink: r.sink } });
    const { root, platformOrg } = await seedPlatform(auth);
    const target = await verifiedSession(auth, "target@example.com");
    // A member of the platform organization with another role: the grant adds a part to the row.
    const added = await addMember(auth.config, {
      user: root,
      organizationId: platformOrg.id,
      userId: target.user.id,
      role: "member",
    });
    expect(added.ok).toBe(true);
    const actor = await secretActor(auth, OPERATOR_SECRETS.support);
    const act = {
      actor,
      userId: target.user.id,
      reason: "Support case 9",
      ip: null,
      userAgent: null,
    };
    expect((await grantPlatformRole(auth.config, act)).ok).toBe(true);
    expect((await revokePlatformRole(auth.config, act)).ok).toBe(true);
    const changes = named(await r.events(() => auth.config.observe.flush()), "organization.change");
    const body = { name: "organization.change", organizationId: platformOrg.id };
    expect(changes.map(own)).toEqual([
      { ...body, action: "addMember" },
      { ...body, action: "updateMemberRole" },
      { ...body, action: "updateMemberRole" },
    ]);
  });

  it("emits organization.role_change on a role create, update, and delete", async () => {
    const { auth, events } = orgWorld();
    const owner = await seed(auth, "owner@example.com");
    const org = await orgOf(auth, owner);
    const o = { user: owner, organizationId: org.id };
    const made = await createRole(auth.config, {
      ...o,
      name: "editor",
      rank: 1,
      permissions: { member: ["read"] },
    });
    if (!made.ok) throw new Error(made.code);
    expect((await updateRole(auth.config, { ...o, name: "editor", rank: 2 })).ok).toBe(true);
    // A delete that the transaction refuses emits nothing: a member holds the role.
    const bob = await seed(auth, "bob@example.com");
    expect((await addMember(auth.config, { ...o, userId: bob.id, role: "editor" })).ok).toBe(true);
    expect(await deleteRole(auth.config, { ...o, name: "editor" })).toMatchObject({
      ok: false,
      code: "role_in_use",
    });
    expect((await removeMember(auth.config, { ...o, userId: bob.id })).ok).toBe(true);
    expect((await deleteRole(auth.config, { ...o, name: "editor" })).ok).toBe(true);
    const body = { organizationId: org.id, roleId: made.value.id };
    expect(named(await events(), "organization.role_change").map(own)).toEqual([
      { name: "organization.role_change", action: "create", ...body },
      { name: "organization.role_change", action: "update", ...body },
      { name: "organization.role_change", action: "delete", ...body },
    ]);
  });
});

describe("the operator events (plan 12h Task 6)", () => {
  it("emits operator.action after the audit row commits, and none when the act fails", async () => {
    const r = recorder();
    let refuse = false;
    const auth = await operatorAuth({
      observe: { sink: r.sink },
      hooks: {
        operator: {
          beforeAction: () => {
            if (refuse) throw Object.assign(new Error("no"), { name: "HookRefusal" });
          },
        },
      },
    });
    const target = await verifiedSession(auth, "target@example.com");
    const actor = await secretActor(auth, OPERATOR_SECRETS.support);
    const ban = await banUser(auth.config, {
      actor,
      userId: target.user.id,
      reason: "abuse report 7",
      ip: null,
      userAgent: null,
    });
    if (!ban.ok) throw new Error(ban.code);
    const [row] = await auth.storage.findMany("operatorAudit", []);
    expect(row?.id).toBe(ban.value.auditId);
    refuse = true;
    const other = await verifiedSession(auth, "other@example.com");
    expect(
      await banUser(auth.config, {
        actor,
        userId: other.user.id,
        reason: "abuse report 8",
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "hook_refused" });
    const events = await r.events(() => auth.config.observe.flush());
    expect(named(events, "operator.action").map(own)).toEqual([
      { name: "operator.action", action: "ban", actorKind: "secret", auditId: ban.value.auditId },
    ]);
    expect(named(events, "operator.refused").map(own)).toEqual([
      { name: "operator.refused", action: "ban", actorKind: "secret", code: "hook_refused" },
    ]);
    expect(await auth.storage.findMany("operatorAudit", [])).toHaveLength(1);
  });

  it("gives the operator events of a route the trace of its request", async () => {
    const batches: AuthEvent[][] = [];
    let refuse = false;
    const base = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: ["https://app.example.com"],
      storage: base.storage,
      mail: { send: async () => {} },
      clock: base.clock,
      limiter: base.config.limiter,
      operator: {
        secrets: [
          {
            name: "support",
            secretHash: await sha256Hex(OPERATOR_SECRETS.support),
            scopes: ["users"],
          },
        ],
        users: true,
      },
      hooks: {
        operator: {
          beforeAction: () => {
            if (refuse) throw Object.assign(new Error("no"), { name: "HookRefusal" });
          },
        },
      },
      observe: { sink: { write: (b) => void batches.push([...b]) } },
    });
    const ban = async (userId: string) => {
      const res = await auth.handle(
        post(
          "/auth/operator/users/ban",
          { userId, reason: "Support case 4711" },
          operatorHeader(OPERATOR_SECRETS.support),
        ),
      );
      return { status: res.status, trace: res.headers.get("x-authtempo-trace") };
    };
    const ada = await seed(base, "ada@example.com");
    const bob = await seed(base, "bob@example.com");
    const done = await ban(ada.id);
    refuse = true;
    const refused = await ban(bob.id);
    expect([done.status, refused.status]).toEqual([200, 403]);
    await auth.observe.flush();
    const events = batches.flat();
    const [action] = named(events, "operator.action");
    const [refusal] = named(events, "operator.refused");
    expect(action?.traceId).toBe(done.trace);
    expect(action?.route).toBe("POST /operator/users/ban");
    expect(refusal?.traceId).toBe(refused.trace);
    expect(refusal?.route).toBe("POST /operator/users/ban");
    expect(done.trace).not.toBe(refused.trace);
    for (const e of [action, refusal]) expect(e?.rejected).toBeUndefined();
  });

  it("gives operator.read of a read route the trace and route of its answer", async () => {
    const batches: AuthEvent[][] = [];
    const base = makeAuth({ password: { hash: FAST, uniformSignUp: false } });
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: ["https://app.example.com"],
      storage: base.storage,
      mail: { send: async () => {} },
      clock: base.clock,
      limiter: base.config.limiter,
      operator: {
        secrets: [
          {
            name: "support",
            secretHash: await sha256Hex(OPERATOR_SECRETS.support),
            scopes: ["users"],
          },
        ],
        users: true,
      },
      observe: { sink: { write: (b) => void batches.push([...b]) } },
    });
    await seed(base, "ada@example.com");
    const res = await auth.handle(
      new Request(`${BASE_URL}/auth/operator/users`, {
        headers: operatorHeader(OPERATOR_SECRETS.support),
      }),
    );
    expect(res.status).toBe(200);
    const trace = res.headers.get("x-authtempo-trace");
    expect(trace).toBeTruthy();
    await auth.observe.flush();
    const reads = named(batches.flat(), "operator.read");
    expect(reads.map(own)).toEqual([
      {
        name: "operator.read",
        route: "GET /operator/users",
        actor: "secret",
        actorId: "support",
        fn: "listUsers",
      },
    ]);
    expect(reads[0]?.traceId).toBe(trace);
    expect(reads[0]?.rejected).toBeUndefined();
  });

  it("emits operator.refused with rate_limited when an operator user passes the limit", async () => {
    const r = recorder();
    const f = await operatorFixture({ config: { observe: { sink: r.sink } } });
    for (let i = 0; i < 600; i++) {
      const passed = await requireOperatorUser(f.auth.config, f.operator);
      if (!passed.ok) throw new Error(`call ${i + 1}: ${passed.code}`);
    }
    expect(await requireOperatorUser(f.auth.config, f.operator)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    const events = await r.events(() => f.auth.config.observe.flush());
    expect(named(events, "operator.refused").map(own)).toEqual([
      { name: "operator.refused", actorKind: "user", code: "rate_limited" },
    ]);
  });

  it("emits operator.refused when the operator guard refuses a user", async () => {
    const r = recorder();
    const auth = await operatorAuth({ observe: { sink: r.sink } });
    const plain = await verifiedSession(auth, "plain@example.com");
    const resolved = await resolveSession(auth.config, plain.token);
    if (!resolved) throw new Error("no session");
    expect(await requireOperatorUser(auth.config, resolved)).toMatchObject({
      ok: false,
      code: "operator_required",
    });
    const events = await r.events(() => auth.config.observe.flush());
    expect(named(events, "operator.refused").map(own)).toEqual([
      { name: "operator.refused", actorKind: "user", code: "operator_required" },
    ]);
    // The fault line of the guard stays beside it (plan 12h Task 3).
    expect(named(events, "operator.guard_refused")).toHaveLength(1);
  });
});

describe("the sweep event (plan 12h Task 6)", () => {
  it("emits one sweep event with every count, and flushes", async () => {
    const batches: AuthEvent[][] = [];
    const base = makeAuth();
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: ["https://app.example.com"],
      storage: base.storage,
      mail: { send: async () => {} },
      clock: base.clock,
      observe: { sink: { write: (b) => void batches.push([...b]) } },
    });
    // One expired verification row, so one count is not 0.
    const now = base.clock.now();
    const past = new Date(now.getTime() - 1000);
    await base.storage.create("verification", {
      id: newId(now),
      purpose: "magic-link",
      identifier: "ada@example.com",
      valueHash: "h",
      expiresAt: past,
      consumedAt: null,
      data: null,
      createdAt: past,
      updatedAt: past,
      secretVersion: 1,
    });
    const result = await auth.api.sweepExpired();
    // No flush call: sweepExpired flushes at its end (spec 31 item 4).
    const sweeps = batches.flat().filter((e) => e.name === "sweep");
    expect(sweeps).toHaveLength(1);
    const [sweep] = sweeps;
    const counts = Object.fromEntries(
      Object.keys(result).map((k) => [k, (sweep as Record<string, unknown>)[k]]),
    );
    expect(counts).toEqual(result);
    expect(result.verificationExpired).toBe(1);
    // 17 counts of plan 12h, and ssoDomains, ssoPendingDomains, scimTokens, and organizationRows of plan 12d.
    // Plan 12i Task 6 adds anonymousUsers.
    expect(Object.keys(result)).toHaveLength(22);
    expect(sweep?.durationMs).toBe(0);
    expect(sweep?.rejected).toBeUndefined();
    const fields = Object.keys(own(sweep)).filter((k) => k !== "name");
    expect(fields.sort()).toEqual([...Object.keys(result), "durationMs"].sort());
  });

  it("emits the sweep event of the engine call through the config observer", async () => {
    const r = recorder();
    const auth = makeAuth({ observe: { sink: r.sink } });
    const result = await sweepExpired(auth.config);
    const [sweep] = named(await r.events(() => auth.config.observe.flush()), "sweep");
    expect(own(sweep)).toEqual({ name: "sweep", ...result, durationMs: 0 });
  });
});
