import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { createAuth } from "../../src/create-auth.js";
import {
  addMember,
  createOrganization,
  deleteOrganization,
} from "../../src/engine/organizations.js";
import { passwordSignUp } from "../../src/engine/password.js";
import { createScimToken } from "../../src/engine/scim/tokens.js";
import { resolveSession } from "../../src/engine/sessions.js";
import { createApiToken } from "../../src/engine/tokens.js";
import type { ScimScope } from "../../src/schema.js";
import { createMemoryAdapter } from "../../src/storage/memory.js";
import { FAST, signUpAndVerify } from "../password-helpers.js";
import { acmeWithSso, type SsoWorld, ssoSignIn, ssoSignInWorld } from "../sso/sign-in-helpers.js";
import { SCIM_APP, scim } from "./helpers.js";

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const ENTERPRISE_URN = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR_URN = "urn:ietf:params:scim:api:messages:2.0:Error";
const ADA = "ada@acme.example";

beforeEach(() => {
  // A refused sign-in and a kept owner row each write one log line.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The SSO sign-in world of Task 5 with `scim` on: the organization `acme`,
 * its verified domain `acme.example`, and one OIDC connection. A password
 * sign-up may stay unverified, so a test can make a claimant.
 */
async function world(overrides: Partial<AuthConfig> = {}) {
  const w = ssoSignInWorld({
    password: { hash: FAST, uniformSignUp: false, requireVerified: false },
    scim: {},
    ...overrides,
  });
  const acme = await acmeWithSso(w);
  return { ...w, ...acme };
}
type World = Awaited<ReturnType<typeof world>>;

/** A SCIM token of the organization, through the call of `api.scim.tokens.create`. */
async function tokenOf(w: SsoWorld, organizationId: string, scopes?: ScimScope[]) {
  const made = await createScimToken(w.config, SCIM_APP, {
    organizationId,
    name: "directory",
    ...(scopes === undefined ? {} : { scopes }),
  });
  if (!made.ok) throw new Error(made.code);
  return made.value.token;
}

/** A User body of one work address. */
function userBody(email: string, extra: Record<string, unknown> = {}) {
  return {
    schemas: [USER_URN],
    userName: email,
    emails: [{ value: email, type: "work", primary: true }],
    ...extra,
  };
}

/** The status, the ETag, and the body of an answer. */
async function read(res: Response) {
  const text = await res.text();
  return {
    status: res.status,
    etag: res.headers.get("etag"),
    location: res.headers.get("location"),
    body: (text === "" ? null : JSON.parse(text)) as Record<string, unknown>,
  };
}

/** Creates a User through the route and answers its id. */
async function created(w: World, token: string, email: string, extra = {}) {
  const r = await read(await scim(w, token, "POST", "/Users", userBody(email, extra)));
  if (r.status !== 201) throw new Error(`create answered ${r.status} ${JSON.stringify(r.body)}`);
  return String(r.body.id);
}

/** A PatchOp body. */
const patch = (...ops: Record<string, unknown>[]) => ({ schemas: [PATCH_URN], Operations: ops });

async function userAt(w: World, email: string) {
  return w.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
}

async function membersOf(w: World, userId: string) {
  return w.storage.findMany("member", [{ field: "userId", op: "eq", value: userId }]);
}

/** A second organization `beta`, with its owner. */
async function beta(w: World) {
  const owner = await w.seedUser("owner@beta.example");
  const made = await createOrganization(w.config, { user: owner, slug: "beta", name: "Beta" });
  if (!made.ok) throw new Error(made.code);
  return made.value.organization.id;
}

describe("the SCIM Users (plan 12d Task 10)", () => {
  it("creates a user at an address of a verified domain", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const r = await read(
      await scim(w, token, "POST", "/Users", userBody(ADA, { name: { givenName: "Ada" } })),
    );
    expect(r.status).toBe(201);
    const id = String(r.body.id);
    expect(r.location).toBe(`https://api.example.com/auth/scim/v2/Users/${id}`);
    expect(r.etag).toBe('W/"1"');
    expect(r.body.meta).toMatchObject({ location: r.location, version: 'W/"1"' });
    const user = await userAt(w, ADA);
    expect(user?.emailVerified).toBe(true);
    // The name of the User fills the core user's name, which was null.
    expect(user?.name).toBe("Ada");
    expect(
      await w.storage.findMany("password", [{ field: "userId", op: "eq", value: user?.id ?? "" }]),
    ).toEqual([]);
    expect((await membersOf(w, user?.id ?? "")).map((m) => [m.organizationId, m.role])).toEqual([
      [w.organizationId, "member"],
    ]);
    const audit = await w.storage.findMany("operatorAudit", [
      { field: "action", op: "eq", value: "scim_user_create" },
    ]);
    expect(audit.map((a) => [a.actorKind, a.actorId, a.targetUserId, a.data])).toEqual([
      ["scim", "directory", user?.id, { organizationId: w.organizationId, scimUserId: id }],
    ]);
  });

  it("creates no user outside the verified domains", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const before = await Promise.all(
      (["user", "member", "scimUser", "operatorAudit"] as const).map(
        async (m) => (await w.storage.findMany(m, [])).length,
      ),
    );
    const r = await read(await scim(w, token, "POST", "/Users", userBody("x@other.example")));
    expect([r.status, r.body]).toEqual([
      400,
      {
        schemas: [ERROR_URN],
        status: "400",
        scimType: "invalidValue",
        detail: "the address is not in a verified domain of this organization",
      },
    ]);
    const after = await Promise.all(
      (["user", "member", "scimUser", "operatorAudit"] as const).map(
        async (m) => (await w.storage.findMany(m, [])).length,
      ),
    );
    expect(after).toEqual(before);
    expect(await userAt(w, "x@other.example")).toBeNull();
  });

  it("links a user that exists, and claims an unverified one", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const kept = await signUpAndVerify(w, ADA);
    await created(w, token, ADA);
    const ada = await userAt(w, ADA);
    expect((await membersOf(w, ada?.id ?? "")).length).toBe(1);
    expect(
      await w.storage.findOne("password", [{ field: "userId", op: "eq", value: ada?.id ?? "" }]),
    ).toEqual(kept);
    // A claimant signs up at an address of the domain, and the create claims it.
    const up = await passwordSignUp(w.config, {
      email: "uma@acme.example",
      password: "a claimant's password",
      ip: null,
      userAgent: null,
    });
    if (!up.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    const claimant = up.value.token;
    const uma = await userAt(w, "uma@acme.example");
    expect(uma?.emailVerified).toBe(false);
    await created(w, token, "uma@acme.example");
    expect(await resolveSession(w.config, claimant)).toBeNull();
    expect((await userAt(w, "uma@acme.example"))?.emailVerified).toBe(true);
    expect(
      await w.storage.findOne("password", [{ field: "userId", op: "eq", value: uma?.id ?? "" }]),
    ).toBeNull();
    expect((await membersOf(w, uma?.id ?? "")).length).toBe(1);
  });

  it("reads nothing of another organization", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const id = await created(w, token, ADA);
    const other = await tokenOf(w, await beta(w));
    expect((await scim(w, other, "GET", `/Users/${id}`)).status).toBe(404);
    expect((await read(await scim(w, other, "GET", "/Users"))).body).toMatchObject({
      totalResults: 0,
      Resources: [],
    });
    const q = encodeURIComponent(`userName eq "${ADA}"`);
    expect((await read(await scim(w, other, "GET", `/Users?filter=${q}`))).body).toMatchObject({
      totalResults: 0,
    });
    // The token of the organization reads its own User by each filter.
    for (const filter of [
      `userName eq "ADA@acme.example"`,
      `emails.value eq "${ADA}"`,
      `id eq "${id}"`,
    ])
      expect(
        (await read(await scim(w, token, "GET", `/Users?filter=${encodeURIComponent(filter)}`)))
          .body,
      ).toMatchObject({ totalResults: 1, itemsPerPage: 1 });
  });

  it("refuses a second userName in any case", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    await created(w, token, "a@acme.example");
    const r = await read(await scim(w, token, "POST", "/Users", userBody("A@acme.example")));
    expect([r.status, r.body.scimType]).toEqual([409, "uniqueness"]);
    expect((await w.storage.findMany("scimUser", [])).length).toBe(1);
  });

  it("honors If-Match and refuses a stale version", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const id = await created(w, token, ADA);
    const body = userBody(ADA, { displayName: "Ada L" });
    const first = await read(
      await scim(w, token, "PUT", `/Users/${id}`, body, { "if-match": 'W/"1"' }),
    );
    expect([first.status, first.etag, first.body.displayName]).toEqual([200, 'W/"2"', "Ada L"]);
    const stale = await read(
      await scim(w, token, "PUT", `/Users/${id}`, body, { "if-match": 'W/"1"' }),
    );
    expect([stale.status, stale.body.schemas]).toEqual([412, [ERROR_URN]]);
    expect((await read(await scim(w, token, "GET", `/Users/${id}`))).etag).toBe('W/"2"');
  });

  it("applies the operations of one PATCH atomically", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const id = await created(w, token, ADA, { displayName: "Ada" });
    const r = await read(
      await scim(
        w,
        token,
        "PATCH",
        `/Users/${id}`,
        patch(
          { op: "replace", path: "displayName", value: "Changed" },
          // A sub-attribute of a list with no filter names no one value.
          { op: "replace", path: "emails.value", value: "b@acme.example" },
        ),
      ),
    );
    expect([r.status, r.body.scimType]).toEqual([400, "invalidPath"]);
    const now = await read(await scim(w, token, "GET", `/Users/${id}`));
    expect([now.body.displayName, now.etag]).toEqual(["Ada", 'W/"1"']);
    expect(
      (
        await w.storage.findMany("operatorAudit", [
          { field: "action", op: "eq", value: "scim_user_update" },
        ])
      ).length,
    ).toBe(0);
  });

  it("deactivates a user and ends their access", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    await signUpAndVerify(w, ADA);
    const user = await userAt(w, ADA);
    if (!user) throw new Error("no user");
    const minted = await createApiToken(w.config, { user, name: "laptop" });
    if (!minted.ok) throw new Error(minted.code);
    const id = await created(w, token, ADA);
    expect(
      (await w.storage.findMany("session", [{ field: "userId", op: "eq", value: user.id }])).length,
    ).toBeGreaterThan(0);
    // The form of Entra ID: the op with a capital, and the boolean as a text.
    const off = await read(
      await scim(
        w,
        token,
        "PATCH",
        `/Users/${id}`,
        patch({ op: "Replace", path: "active", value: "False" }),
      ),
    );
    expect([off.status, off.body.active]).toEqual([200, false]);
    expect(await membersOf(w, user.id)).toEqual([]);
    for (const model of ["session", "apiToken"] as const)
      expect(
        await w.storage.findMany(model, [{ field: "userId", op: "eq", value: user.id }]),
        model,
      ).toEqual([]);
    const audit = await w.storage.findMany("operatorAudit", [
      { field: "action", op: "eq", value: "scim_user_deactivate" },
    ]);
    expect(audit.map((a) => a.data)).toEqual([
      { organizationId: w.organizationId, scimUserId: id, changed: ["active"] },
    ]);
    const signIn = await ssoSignIn(w, w.connectionId, "acme", { sub: "a-1", email: ADA });
    expect([signIn.error, signIn.token]).toEqual(["account_disabled", null]);
    const on = await read(
      await scim(
        w,
        token,
        "PATCH",
        `/Users/${id}`,
        patch({ op: "replace", value: { active: true } }),
      ),
    );
    expect([on.status, on.body.active]).toEqual([200, true]);
    expect((await membersOf(w, user.id)).map((m) => [m.organizationId, m.role])).toEqual([
      [w.organizationId, "member"],
    ]);
  });

  it("keeps the member row of an owner at a deactivate", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const owner = await userAt(w, "owner@acme.example");
    if (!owner) throw new Error("no owner");
    const id = await created(w, token, "owner@acme.example");
    const off = await scim(
      w,
      token,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "replace", path: "active", value: false }),
    );
    expect(off.status).toBe(200);
    expect((await membersOf(w, owner.id)).map((m) => m.role)).toEqual(["owner"]);
    expect(console.info).toHaveBeenCalledWith(
      "authtempo: scim kept the member row of an owner",
      id,
    );
  });

  it("deletes the SCIM user and keeps the account", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const id = await created(w, token, ADA);
    const ada = await userAt(w, ADA);
    const owner = await w.seedUser("owner@beta.example");
    const made = await createOrganization(w.config, { user: owner, slug: "beta", name: "Beta" });
    if (!made.ok || !ada) throw new Error("no beta");
    const joined = await addMember(w.config, {
      user: owner,
      organizationId: made.value.organization.id,
      userId: ada.id,
      role: "member",
    });
    if (!joined.ok) throw new Error(joined.code);
    const added = (await membersOf(w, ada.id)).find(
      (m) => m.organizationId === made.value.organization.id,
    );
    const r = await read(await scim(w, token, "DELETE", `/Users/${id}`));
    expect([r.status, r.body, r.etag]).toEqual([204, null, null]);
    expect((await userAt(w, ADA))?.id).toBe(ada.id);
    expect(await membersOf(w, ada.id)).toEqual([added]);
    expect((await scim(w, token, "GET", `/Users/${id}`)).status).toBe(404);
    expect(await w.storage.findMany("scimUser", [])).toEqual([]);
  });

  it("changes the address only for a user of this organization alone", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const ada = await created(w, token, ADA);
    const bob = await created(w, token, "bob@acme.example");
    const betaId = await beta(w);
    const adaUser = await userAt(w, ADA);
    if (!adaUser) throw new Error("no ada");
    const betaOwner = await userAt(w, "owner@beta.example");
    if (!betaOwner) throw new Error("no beta owner");
    const joined = await addMember(w.config, {
      user: betaOwner,
      organizationId: betaId,
      userId: adaUser.id,
      role: "member",
    });
    if (!joined.ok) throw new Error(joined.code);
    const move = (to: string) =>
      patch({ op: "replace", path: 'emails[type eq "work"].value', value: to });
    const refused = await read(
      await scim(w, token, "PATCH", `/Users/${ada}`, move("ada2@acme.example")),
    );
    expect([refused.status, refused.body.scimType]).toEqual([400, "mutability"]);
    expect((await userAt(w, ADA))?.id).toBe(adaUser.id);
    const moved = await read(
      await scim(w, token, "PATCH", `/Users/${bob}`, move("bob2@acme.example")),
    );
    expect(moved.status).toBe(200);
    expect(await userAt(w, "bob@acme.example")).toBeNull();
    expect((await userAt(w, "bob2@acme.example"))?.emailVerified).toBe(true);
    // The new address must pass the address rule too.
    const outside = await read(
      await scim(w, token, "PATCH", `/Users/${bob}`, move("bob@other.example")),
    );
    expect([outside.status, outside.body.scimType]).toEqual([400, "invalidValue"]);
  });

  it("deletes the scimUser rows with their organization (Task 10 question Q3)", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    await created(w, token, ADA);
    await created(w, token, "bob@acme.example");
    expect((await w.storage.findMany("scimUser", [])).length).toBe(2);
    const owner = await userAt(w, "owner@acme.example");
    if (!owner) throw new Error("no owner");
    const gone = await deleteOrganization(w.config, {
      user: owner,
      organizationId: w.organizationId,
    });
    expect(gone.ok).toBe(true);
    expect(await w.storage.findMany("scimUser", [])).toEqual([]);
    // The core users stay: only the person deletes an account.
    expect((await userAt(w, ADA))?.email).toBe(ADA);
  });

  it("refuses a password attribute", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const r = await read(
      await scim(w, token, "POST", "/Users", userBody(ADA, { password: "s3cret-value" })),
    );
    expect([r.status, r.body.scimType, r.body.detail]).toEqual([
      400,
      "invalidValue",
      "password is not supported",
    ]);
    expect(await userAt(w, ADA)).toBeNull();
  });

  it("refuses a read token, and a body of another type, too large, or not JSON, at POST /Users", async () => {
    const w = await world();
    const reader = await tokenOf(w, w.organizationId, ["scim.users.read"]);
    const token = await tokenOf(w, w.organizationId);
    const r = await read(await scim(w, reader, "POST", "/Users", userBody(ADA)));
    expect([r.status, r.body.scimType]).toEqual([403, undefined]);
    const text = await scim(w, token, "POST", "/Users", JSON.stringify(userBody(ADA)), {
      "content-type": "text/plain",
    });
    expect([text.status, ((await text.json()) as { scimType: string }).scimType]).toEqual([
      400,
      "invalidSyntax",
    ]);
    const large = await scim(w, token, "POST", "/Users", `"${"x".repeat(1_048_577)}"`);
    expect(large.status).toBe(413);
    const broken = await read(await scim(w, token, "POST", "/Users", "{"));
    expect([broken.status, broken.body.scimType]).toEqual([400, "invalidSyntax"]);
    expect(await userAt(w, ADA)).toBeNull();
  });

  it("returns the attributes of the notation of RFC 7644 section 3.10", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const id = await created(w, token, ADA, {
      schemas: [USER_URN, ENTERPRISE_URN],
      name: { givenName: "Ada", familyName: "Lovelace" },
      [ENTERPRISE_URN]: { department: "Math", manager: "m-1" },
    });
    const pick = async (query: string) =>
      (await read(await scim(w, token, "GET", `/Users/${id}?${query}`))).body;
    const given = await pick("attributes=name.givenName");
    expect(Object.keys(given)).toEqual(["schemas", "id", "name", "meta"]);
    expect(given.name).toEqual({ givenName: "Ada" });
    expect(await pick(`attributes=${USER_URN}:userName`)).toMatchObject({ userName: ADA });
    // Entra ID shows the manager as its id text; core keeps the complex form of section 4.3.
    expect((await pick(`attributes=${ENTERPRISE_URN}:manager`))[ENTERPRISE_URN]).toEqual({
      manager: { value: "m-1" },
    });
    const without = await pick("excludedAttributes=emails.value,name");
    expect([without.name, without.emails]).toEqual([undefined, [{ type: "work", primary: true }]]);
    // Entra ID sends excludedAttributes with a top-level name (Microsoft Learn, read 2026-10-22).
    expect(Object.keys(await pick("excludedAttributes=emails"))).not.toContain("emails");
    const bad = await read(await scim(w, token, "GET", `/Users/${id}?attributes=name.nickname`));
    expect([bad.status, bad.body.scimType]).toEqual([400, "invalidValue"]);
  });

  it("runs hooks.scim.afterChange once per write, and a throw keeps the write", async () => {
    const seen: string[] = [];
    const w = await world({
      hooks: {
        scim: {
          afterChange(e) {
            seen.push(`${e.resource} ${e.action} ${e.id === "" ? "" : "id"}`);
            throw new Error("an app fault");
          },
        },
      },
    });
    const token = await tokenOf(w, w.organizationId);
    const id = await created(w, token, ADA);
    for (const body of [
      patch({ op: "replace", path: "displayName", value: "A" }),
      patch({ op: "replace", path: "active", value: false }),
    ])
      expect((await scim(w, token, "PATCH", `/Users/${id}`, body)).status).toBe(200);
    expect((await scim(w, token, "DELETE", `/Users/${id}`)).status).toBe(204);
    expect(seen).toEqual([
      "User create id",
      "User update id",
      "User deactivate id",
      "User delete id",
    ]);
    expect(console.error).toHaveBeenCalledWith(
      "authtempo: after hook failed",
      "scim.afterChange",
      id,
      "Error",
    );
  });
});

describe("api.scim.users (plan 12d Task 10)", () => {
  it("serves the same rules with the app as the actor", async () => {
    const txt: Record<string, string[]> = {};
    const mail: string[] = [];
    const storage = createMemoryAdapter();
    const auth = createAuth({
      baseURL: "https://api.example.com",
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage,
      mail: { send: async (m) => void mail.push(m.text) },
      organizations: {},
      sso: { dns: [{ name: "a", txt: async (name) => txt[name] ?? [] }] },
      scim: {},
    });
    await auth.api.requestMagicLink({ email: "owner@acme.example", ip: null });
    const link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "");
    const signed = await auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
    if (!signed.ok || !("token" in signed.value)) throw new Error("no session");
    const org = await auth.api.createOrganization({
      user: signed.value.user,
      slug: "acme",
      name: "Acme",
    });
    if (!org.ok) throw new Error(org.code);
    const organizationId = org.value.organization.id;
    const sso = auth.api.sso;
    const users = auth.api.scim?.users;
    if (!sso || !users) throw new Error("no sso or scim api");
    const domain = await sso.domains.add({
      actor: SCIM_APP,
      organizationId,
      domain: "acme.example",
    });
    if (!domain.ok || domain.value.record === null) throw new Error("no domain");
    txt[domain.value.record.name] = [domain.value.record.value];
    expect((await sso.domains.verify({ actor: SCIM_APP, id: domain.value.id })).ok).toBe(true);
    const outside = await users.create({
      actor: SCIM_APP,
      organizationId,
      body: userBody("x@other.example"),
    });
    expect([outside.status, (outside.body as { scimType: string }).scimType]).toEqual([
      400,
      "invalidValue",
    ]);
    const made = await users.create({ actor: SCIM_APP, organizationId, body: userBody(ADA) });
    expect([made.status, made.headers?.etag]).toEqual([201, 'W/"1"']);
    const id = String((made.body as { id: string }).id);
    expect((await users.get({ actor: SCIM_APP, organizationId, id })).status).toBe(200);
    expect(
      (await users.list({ actor: SCIM_APP, organizationId })).body as { totalResults: number },
    ).toMatchObject({ totalResults: 1 });
    const patched = await users.patch({
      actor: SCIM_APP,
      organizationId,
      id,
      body: patch({ op: "replace", path: "displayName", value: "Ada" }),
      ifMatch: 'W/"1"',
    });
    expect([patched.status, patched.headers?.etag]).toEqual([200, 'W/"2"']);
    // An app name outside the rule of the actor writes nothing.
    const named = await users.replace({
      actor: { kind: "app", name: "Not A Name" },
      organizationId,
      id,
      body: userBody(ADA),
    });
    expect(named.status).toBe(400);
    const rows = await storage.findMany("operatorAudit", [], { sort: { field: "id", dir: "asc" } });
    expect(rows.map((r) => [r.action, r.actorKind, r.actorId]).slice(-2)).toEqual([
      ["scim_user_create", "app", "scim-test"],
      ["scim_user_update", "app", "scim-test"],
    ]);
    expect((await users.delete({ actor: SCIM_APP, organizationId, id })).status).toBe(204);
  });
});
