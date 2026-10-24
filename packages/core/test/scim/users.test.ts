import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { createAuth } from "../../src/create-auth.js";
import { mintSessionJwt, sessionLive } from "../../src/engine/jwt.js";
import { createClient } from "../../src/engine/oauth-client-store.js";
import { markAllAccessEnd } from "../../src/engine/operator/access-end.js";
import { revokedFor } from "../../src/engine/operator/guards.js";
import { createOrganizationToken } from "../../src/engine/organization-tokens.js";
import {
  addMember,
  createOrganization,
  deleteOrganization,
  updateMemberRole,
} from "../../src/engine/organizations.js";
import { passwordSignUp } from "../../src/engine/password.js";
import { updateProfile } from "../../src/engine/profile.js";
import { createScimToken } from "../../src/engine/scim/tokens.js";
import { createSession, resolveSession } from "../../src/engine/sessions.js";
import { deleteDomain } from "../../src/engine/sso/domains.js";
import { sweepExpired } from "../../src/engine/sweep.js";
import { createApiToken } from "../../src/engine/tokens.js";
import type { AuthEvent } from "../../src/observe/port.js";
import { randomBase64Url, sha256Hex } from "../../src/primitives/crypto.js";
import type { ScimScope } from "../../src/schema.js";
import { createMemoryAdapter } from "../../src/storage/memory.js";
import { meterOf } from "../../src/storage/meter.js";
import { BASE_URL, LONG_TEST_MS } from "../helpers.js";
import {
  approvedDevice,
  authorized,
  basicHeader,
  exchange,
  type Handle,
  pkce,
  REDIRECT,
  RESOURCE,
  registered,
  SCOPES,
  tokenPost,
} from "../oauth-helpers.js";
import { FAST, signUpAndVerify } from "../password-helpers.js";
import { acmeWithSso, type SsoWorld, ssoSignIn, ssoSignInWorld } from "../sso/sign-in-helpers.js";
import { SCIM_APP, scim } from "./helpers.js";

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const ENTERPRISE_URN = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ERROR_URN = "urn:ietf:params:scim:api:messages:2.0:Error";
const ADA = "ada@acme.example";

beforeEach(() => {
  // A refused sign-in writes one log line.
  vi.spyOn(console, "error").mockImplementation(() => {});
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

  it("reads again once after a lost race with no If-Match, then answers 409", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const id = await created(w, token, ADA);
    const change = (name: string) => patch({ op: "replace", path: "displayName", value: name });
    // The read gate: each read of the row that the PATCH under test makes is
    // held until a rival PATCH commits, so the write of that read loses.
    const storage = w.config.storage;
    const findOne = storage.findOne.bind(storage);
    let rivals = 0;
    let rivalRuns = false;
    vi.spyOn(storage, "findOne").mockImplementation(async (model, where) => {
      const row = await findOne(model, where);
      if (model === "scimUser" && rivals > 0 && !rivalRuns) {
        rivals--;
        rivalRuns = true;
        const rival = await scim(w, token, "PATCH", `/Users/${id}`, change(`Rival ${rivals}`));
        rivalRuns = false;
        expect(rival.status).toBe(200);
      }
      return row;
    });
    const version = async () =>
      (await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: id }]))?.version;
    // One lost race: the second read sees the rival's version, and the write passes.
    rivals = 1;
    const once = await read(await scim(w, token, "PATCH", `/Users/${id}`, change("Ada")));
    expect([once.status, once.body.displayName, once.etag]).toEqual([200, "Ada", 'W/"3"']);
    expect(await version()).toBe(3);
    // Two lost races: the engine tries once more only, then answers 409 with no scimType.
    rivals = 2;
    const twice = await read(await scim(w, token, "PATCH", `/Users/${id}`, change("Lovelace")));
    expect([twice.status, twice.body.scimType, twice.body.detail]).toEqual([
      409,
      undefined,
      "the User changed twice during the write; send it again",
    ]);
    const row = await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: id }]);
    expect([row?.version, row?.displayName]).toEqual([5, "Rival 0"]);
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
    const batches: AuthEvent[][] = [];
    const w = await world({ observe: { sink: { write: (b) => void batches.push([...b]) } } });
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
    // The event of the kept row names the SCIM user (plan 12h).
    await w.config.observe.flush();
    expect(
      batches
        .flat()
        .filter((e) => e.name === "scim.owner_kept")
        .map((e) => e.scimUserId),
    ).toEqual([id]);
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

  it("ignores a password in a create and a replace, and refuses it in a PATCH (Task 12 P2)", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    // Okta sends a password in each create, also with password sync off (its
    // SCIM 2.0 protocol reference, read 2026-10-22T14:47:54Z).
    const r = await read(
      await scim(w, token, "POST", "/Users", userBody(ADA, { password: "1mz050nq" })),
    );
    expect([r.status, r.body.password]).toEqual([201, undefined]);
    const id = String(r.body.id);
    const user = await userAt(w, ADA);
    expect(
      await w.storage.findMany("password", [{ field: "userId", op: "eq", value: user?.id ?? "" }]),
    ).toEqual([]);
    const row = await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: id }]);
    expect(JSON.stringify(row?.data)).not.toContain("1mz050nq");
    const put = await read(
      await scim(w, token, "PUT", `/Users/${id}`, userBody(ADA, { password: "1mz050nq" })),
    );
    expect([put.status, put.body.password]).toEqual([200, undefined]);
    // A PATCH of the password is a password change: changePassword.supported is false.
    for (const op of [
      { op: "replace", path: "password", value: "1mz050nq" },
      { op: "replace", value: { password: "1mz050nq" } },
    ]) {
      const p = await read(await scim(w, token, "PATCH", `/Users/${id}`, patch(op)));
      expect([p.status, p.body.scimType, p.body.detail]).toEqual([
        400,
        "invalidValue",
        "operation 0: password is not supported",
      ]);
    }
    expect(
      await w.storage.findMany("password", [{ field: "userId", op: "eq", value: user?.id ?? "" }]),
    ).toEqual([]);
  });

  it("ignores the attributes that the schema does not know in an Okta body (ruling 45)", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const address = "test.user@acme.example";
    // The create of the Okta SCIM 2.0 protocol reference (developer.okta.com,
    // read 2026-10-22), at an address of the verified domain. Its password is
    // left out here; the test of Task 12 P2 sends it. An Okta custom
    // attribute goes to the namespace of its mapping: the core User at the
    // top, or the enterprise extension.
    const okta = {
      schemas: [USER_URN, ENTERPRISE_URN],
      userName: address,
      name: { givenName: "Test", familyName: "User" },
      emails: [{ primary: true, value: address, type: "work" }],
      displayName: "Test User",
      locale: "en-US",
      externalId: "00ujl29u0le5T6Aj10h7",
      groups: [],
      active: true,
      isContractor: true,
      [ENTERPRISE_URN]: { employeeNumber: "701984", department: "Tour Operations", badgeId: "B-7" },
    };
    const r = await read(await scim(w, token, "POST", "/Users", okta));
    expect(r.status).toBe(201);
    const id = String(r.body.id);
    // The unknown attributes are not stored, and the answer is the resource as stored.
    const row = await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: id }]);
    expect(row?.data).toEqual({
      name: { givenName: "Test", familyName: "User" },
      emails: [{ primary: true, value: address, type: "work" }],
      locale: "en-US",
      [ENTERPRISE_URN]: { employeeNumber: "701984", department: "Tour Operations" },
    });
    expect(r.body.isContractor).toBeUndefined();
    expect(r.body[ENTERPRISE_URN]).toEqual({
      employeeNumber: "701984",
      department: "Tour Operations",
    });
    const got = await read(await scim(w, token, "GET", `/Users/${id}`));
    expect(got.body).toEqual(r.body);
    // The replace of the same reference: id, meta, and groups are ignored, and
    // a custom attribute again stores nothing.
    const put = await read(
      await scim(w, token, "PUT", `/Users/${id}`, {
        schemas: [USER_URN],
        id,
        userName: address,
        name: { givenName: "Another", middleName: "Excited", familyName: "User" },
        emails: [{ primary: true, value: address, type: "work", display: address }],
        active: true,
        groups: [],
        meta: { resourceType: "User" },
        isContractor: false,
      }),
    );
    expect([put.status, put.body.isContractor, put.body.name]).toEqual([
      200,
      undefined,
      { givenName: "Another", middleName: "Excited", familyName: "User" },
    ]);
  });

  it("ignores an unknown sub-attribute, and stores the rest of its value", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const r = await read(
      await scim(
        w,
        token,
        "POST",
        "/Users",
        userBody(ADA, { name: { givenName: "Ada", pronunciation: "AY-da" } }),
      ),
    );
    expect([r.status, r.body.name]).toEqual([201, { givenName: "Ada" }]);
  });

  it("takes an Entra ID body, and refuses only a schema URN that it does not serve (ruling 45)", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const address = "test_user_11bb11bb@acme.example";
    // The Create User request of "Develop a SCIM endpoint" (Microsoft Learn,
    // read 2026-10-22), at an address of the verified domain, with the
    // enterprise manager of the schema sample of the same page.
    const entra = {
      schemas: [USER_URN, ENTERPRISE_URN],
      externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
      userName: "Test_User_00aa00aa-bb11-cc22-dd33-44ee44ee44ee",
      active: true,
      emails: [{ primary: true, type: "work", value: address }],
      meta: { resourceType: "User" },
      name: { formatted: "givenName familyName", familyName: "familyName", givenName: "givenName" },
      roles: [],
      [ENTERPRISE_URN]: { manager: "123456" },
    };
    const r = await read(await scim(w, token, "POST", "/Users", entra));
    expect([r.status, r.body[ENTERPRISE_URN]]).toEqual([201, { manager: { value: "123456" } }]);
    expect((await userAt(w, address))?.emailVerified).toBe(true);
    // The schema sample of the same page names a custom extension in schemas.
    // This server does not serve it, so the body answers invalidSyntax.
    const custom = "urn:ietf:params:scim:schemas:extension:CustomExtensionName:2.0:User";
    const other = "bjensen@acme.example";
    const refusedBody = await read(
      await scim(w, token, "POST", "/Users", {
        schemas: [USER_URN, ENTERPRISE_URN, custom],
        userName: other,
        externalId: "bjensen",
        name: { familyName: "Jensen", givenName: "Barbara" },
        [ENTERPRISE_URN]: { manager: "123456" },
        [custom]: { tag: "701984" },
      }),
    );
    expect([refusedBody.status, refusedBody.body.scimType]).toEqual([400, "invalidSyntax"]);
    expect(await userAt(w, other)).toBeNull();
    // A URN key that schemas does not name is an unknown attribute, and is ignored.
    const ignored = await read(
      await scim(w, token, "POST", "/Users", {
        schemas: [USER_URN],
        userName: other,
        [custom]: { tag: "701984" },
      }),
    );
    expect([ignored.status, ignored.body[custom]]).toEqual([201, undefined]);
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

describe("the event session.end of a SCIM write with no session.afterEnd hook (ruling 81 M1)", () => {
  /** The world with an observe sink and no afterEnd hook, and the session.end events of the sink. */
  async function sinkWorld() {
    const batches: AuthEvent[][] = [];
    const w = await world({ observe: { sink: { write: (b) => void batches.push([...b]) } } });
    const ends = async () => {
      await w.config.observe.flush();
      return batches
        .flat()
        .filter((e) => e.name === "session.end")
        .map((e) => [e.reason, e.count]);
    };
    return { w, ends, clear: () => void batches.splice(0) };
  }

  it("sends one session.end with the count at a deactivate", async () => {
    const { w, ends, clear } = await sinkWorld();
    const token = await tokenOf(w, w.organizationId);
    await signUpAndVerify(w, ADA);
    const user = await userAt(w, ADA);
    if (!user) throw new Error("no user");
    const id = await created(w, token, ADA);
    const live = await w.storage.findMany("session", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(live).toHaveLength(1);
    await ends();
    clear();
    const off = await scim(
      w,
      token,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "replace", path: "active", value: false }),
    );
    expect(off.status).toBe(200);
    expect(await ends()).toEqual([["revoked", 1]]);
  });

  it("sends one session.end with the count when a create claims an unverified user", async () => {
    const { w, ends, clear } = await sinkWorld();
    const token = await tokenOf(w, w.organizationId);
    const up = await passwordSignUp(w.config, {
      email: "uma@acme.example",
      password: "a claimant's password",
      ip: null,
      userAgent: null,
    });
    if (!up.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    await ends();
    clear();
    await created(w, token, "uma@acme.example");
    expect(await resolveSession(w.config, up.value.token)).toBeNull();
    expect(await ends()).toEqual([["claim", 1]]);
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

describe("the session door of a SCIM deactivate (ruling 50 of plan 12d)", () => {
  const MINUTE = 60_000;
  const UNAUTHORIZED = { ok: false, code: "unauthorized", status: 401 };

  /** The world with a session.afterEnd hook, the worst case of the page, and the JWT mint. */
  async function doorWorld() {
    const ended: string[] = [];
    const w = await world({
      hooks: {
        session: { afterEnd: ({ session, reason }) => void ended.push(`${session.id}:${reason}`) },
      },
      jwtMint: { audience: ["https://rs.example.com"] },
    });
    const token = await tokenOf(w, w.organizationId);
    await signUpAndVerify(w, ADA);
    const user = await userAt(w, ADA);
    if (!user) throw new Error("no user");
    const id = await created(w, token, ADA);
    return { w, token, user, id, ended };
  }

  /** `n` sessions of the user, through the session write of every sign-in. Each holds its token. */
  async function sessionsOf(w: World, userId: string, n: number) {
    const out: { token: string; id: string }[] = [];
    for (let i = 0; i < n; i++) {
      const s = await createSession(w.config, { userId, ip: null, userAgent: null });
      out.push({ token: s.token, id: s.session.id });
    }
    return out;
  }

  const live = (w: World, userId: string) =>
    w.storage.findMany("session", [{ field: "userId", op: "eq", value: userId }]);

  /** The reads of the pending-end rows and the records through the engine storage (ruling 56). */
  function pendingReads(w: World) {
    const spy = vi.spyOn(w.storage, "findMany");
    return () =>
      spy.mock.calls.filter(
        ([model, where]) =>
          model === "verification" &&
          (where as { field: string; value: unknown }[]).some(
            (c) =>
              c.field === "purpose" &&
              (c.value === "session-end" ||
                (Array.isArray(c.value) && c.value.includes("session-end"))),
          ),
      ).length;
  }

  it("refuses each of 40 sessions at once at each of the three doors, before any sweep", async () => {
    const { w, token, user, id, ended } = await doorWorld();
    // The sessions begin after the last write of the user.
    w.clock.advance(MINUTE);
    const before = await live(w, user.id);
    const made = await sessionsOf(w, user.id, 40 - before.length);
    const tokens = new Map(made.map((s) => [s.id, s.token]));
    expect(await live(w, user.id)).toHaveLength(40);
    w.clock.advance(MINUTE);
    const off = await read(
      await scim(
        w,
        token,
        "PATCH",
        `/Users/${id}`,
        patch({ op: "replace", path: "active", value: false }),
      ),
    );
    expect(off.status).toBe(200);
    // The page ended part of the sessions; a pending-end row of reason revoked holds the rest.
    const left = (await live(w, user.id)).filter((s) => tokens.has(s.id));
    expect(left.length).toBeGreaterThan(0);
    expect(left.length).toBeLessThan(40);
    const pending = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "session-end" },
      { field: "identifier", op: "eq", value: user.id },
    ]);
    expect(pending.map((r) => r.data?.reason)).toEqual(["revoked"]);
    ended.length = 0;
    for (const s of left) {
      const t = tokens.get(s.id) ?? "";
      expect(await sessionLive(w.config, { sid: s.id }), s.id).toBe(false);
      expect(await mintSessionJwt(w.config, { userId: user.id, sessionId: s.id })).toEqual(
        UNAUTHORIZED,
      );
      // Read-only mode answers null and writes nothing.
      expect(await resolveSession(w.config, t, "read-only")).toBeNull();
      expect(
        await w.storage.findOne("session", [{ field: "id", op: "eq", value: s.id }]),
      ).not.toBeNull();
      // Write mode ends the row by id, with the reason revoked.
      expect(await resolveSession(w.config, t)).toBeNull();
      expect(
        await w.storage.findOne("session", [{ field: "id", op: "eq", value: s.id }]),
      ).toBeNull();
    }
    expect(ended).toEqual(left.map((s) => `${s.id}:revoked`));
    expect(await live(w, user.id)).toEqual([]);
  });

  it("reads the pending-end rows once for a session from before a user write, and not after it", async () => {
    const { w, user } = await doorWorld();
    w.clock.advance(MINUTE);
    const [s] = await sessionsOf(w, user.id, 1);
    if (!s) throw new Error("no session");
    const reads = pendingReads(w);
    const first = await resolveSession(w.config, s.token);
    expect(first).not.toBeNull();
    // The session began after the last write of the user: +0 queries.
    expect(reads()).toBe(0);
    w.clock.advance(MINUTE);
    if (!first) throw new Error("no session");
    expect((await updateProfile(w.config, { session: first, name: "Ada L" })).ok).toBe(true);
    // A user write after the session began: one read, and no refusal.
    expect(await resolveSession(w.config, s.token)).toMatchObject({ session: { id: s.id } });
    expect(reads()).toBe(1);
    expect(await sessionLive(w.config, { sid: s.id })).toBe(true);
    expect(reads()).toBe(2);
    expect((await mintSessionJwt(w.config, { userId: user.id, sessionId: s.id })).ok).toBe(true);
    expect(reads()).toBe(3);
  });

  it("does not refuse a session made after the deactivate by the old row", async () => {
    const { w, token, user, id } = await doorWorld();
    w.clock.advance(MINUTE);
    const before = await live(w, user.id);
    await sessionsOf(w, user.id, 40 - before.length);
    w.clock.advance(MINUTE);
    const off = await scim(
      w,
      token,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "replace", path: "active", value: false }),
    );
    expect(off.status).toBe(200);
    const pending = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "session-end" },
      { field: "identifier", op: "eq", value: user.id },
    ]);
    expect(pending).toHaveLength(1);
    w.clock.advance(MINUTE);
    const on = await scim(
      w,
      token,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "replace", path: "active", value: true }),
    );
    expect(on.status).toBe(200);
    w.clock.advance(MINUTE);
    const [s] = await sessionsOf(w, user.id, 1);
    if (!s) throw new Error("no session");
    const first = await resolveSession(w.config, s.token);
    if (!first) throw new Error("the new session was refused");
    // A user write after the new session makes each door read the old row.
    w.clock.advance(MINUTE);
    expect((await updateProfile(w.config, { session: first, name: "Ada L" })).ok).toBe(true);
    const reads = pendingReads(w);
    expect(await resolveSession(w.config, s.token)).toMatchObject({ session: { id: s.id } });
    expect(await sessionLive(w.config, { sid: s.id })).toBe(true);
    expect((await mintSessionJwt(w.config, { userId: user.id, sessionId: s.id })).ok).toBe(true);
    expect(reads()).toBe(3);
    // The old row is still there: the sweep has not run.
    expect(
      await w.storage.findMany("verification", [
        { field: "id", op: "eq", value: pending[0]?.id ?? "" },
      ]),
    ).toHaveLength(1);
  });
});

describe("the OAuth families and the clock of a SCIM deactivate (ruling 55 of plan 12d)", () => {
  const MINUTE = 60_000;
  const OFF = patch({ op: "replace", path: "active", value: false });

  /** The world with OAuth, a session.afterEnd hook (the worst page), and Ada as a SCIM User. */
  async function oauthWorld() {
    const w = await world({
      oauth: {
        resources: [RESOURCE],
        scopes: SCOPES,
        registration: { cimd: false, dynamic: true },
      },
      hooks: { session: { afterEnd: () => {} } },
    });
    const token = await tokenOf(w, w.organizationId);
    await signUpAndVerify(w, ADA);
    const user = await userAt(w, ADA);
    if (!user) throw new Error("no user");
    const id = await created(w, token, ADA);
    const h = { auth: { handle: w.handle }, config: w.config, storage: w.storage, clock: w.clock };
    return { w, h: h as unknown as Handle, token, user, id };
  }

  /**
   * `n` OAuth families of the user through the code flow: each refresh token
   * and the client. With `ahead`, an instance whose clock runs `ahead` ms
   * ahead makes the families.
   */
  async function families(h: Handle, userId: string, n: number, ahead = 0) {
    const s = await createSession(h.config, { userId, ip: null, userAgent: null });
    const cookie = `__Host-tempo_session=${s.token}`;
    const clientId = await registered(h);
    h.clock.advance(ahead);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const p = await pkce();
      const { code } = await authorized(h, cookie, {
        clientId,
        challenge: p.challenge,
        scope: "mcp:read offline_access",
      });
      const res = await h.auth.handle(exchange(code, clientId, p.verifier));
      if (res.status !== 200) throw new Error(`token answered ${res.status}`);
      out.push(((await res.json()) as { refresh_token: string }).refresh_token);
    }
    h.clock.advance(-ahead);
    return { clientId, tokens: out };
  }

  const refresh = async (h: Handle, refreshToken: string, clientId: string) =>
    (
      await h.auth.handle(
        tokenPost({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        }),
      )
    ).status;

  const pendingOf = (w: World, userId: string) =>
    w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "session-end" },
      { field: "identifier", op: "eq", value: userId },
    ]);

  const marks = async (w: World, familyIds: readonly string[]) => {
    let n = 0;
    for (const id of familyIds)
      if (
        await w.storage.findOne("verification", [
          { field: "valueHash", op: "eq", value: await sha256Hex(`oauth-family-end:${id}`) },
        ])
      )
        n++;
    return n;
  };

  it("ends the families that fit, names the rest on the pending-end row, and the sweep ends them", async () => {
    const { w, h, token, user, id } = await oauthWorld();
    w.clock.advance(MINUTE);
    const { clientId, tokens } = await families(h, user.id, 20);
    const rows = await w.storage.findMany("oauthToken", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    const all = [...new Set(rows.map((r) => r.familyId))];
    expect(all).toHaveLength(20);
    w.clock.advance(MINUTE);
    const off = await scim(w, token, "PATCH", `/Users/${id}`, OFF);
    expect(off.status).toBe(200);
    const [row, ...more] = await pendingOf(w, user.id);
    expect(more).toEqual([]);
    const named = (row?.data?.families ?? []) as string[];
    // The act ends the families that fit its budget; the row names the rest.
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(20);
    expect(await marks(w, all)).toBe(20 - named.length);
    // Each family is refused at once, before any sweep.
    for (const t of tokens) expect(await refresh(h, t, clientId)).toBe(400);
    for (let i = 0; i < 5 && (await pendingOf(w, user.id)).length > 0; i++)
      await sweepExpired(w.config);
    expect(await pendingOf(w, user.id)).toEqual([]);
    expect(await marks(w, all)).toBe(20);
  });

  it("refuses a race row of a family that waits on the pending-end row, at the refresh grant", async () => {
    const { w, h, token, user, id } = await oauthWorld();
    w.clock.advance(MINUTE);
    // An instance whose clock runs 2 s ahead makes the families.
    const { clientId } = await families(h, user.id, 20, 2000);
    const rows = await w.storage.findMany(
      "oauthToken",
      [{ field: "userId", op: "eq", value: user.id }],
      { sort: { field: "id", dir: "asc" } },
    );
    const last = rows.at(-1);
    if (!last) throw new Error("no refresh row");
    // A refresh in flight on Postgres: its new row commits after the delete of the act
    // began, so the delete does not see it (oauth-family.ts). The fixture writes that row
    // with the form of writeRefresh while the transaction is open, after its delete. The
    // refresh runs on an instance whose clock runs 3 s ahead, so the row is newer than the act.
    const race = `or_${randomBase64Url(32)}`;
    const storage = w.storage;
    const transaction = storage.transaction.bind(storage);
    storage.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          delete: async (model, where) => {
            const n = await tx.delete(model, where);
            if (model === "oauthToken")
              await storage.create("oauthToken", {
                ...last,
                id: `${last.id.slice(0, 10)}${"Z".repeat(16)}`,
                tokenHash: await sha256Hex(race),
                usedAt: null,
                parentId: last.id,
                createdAt: new Date(w.clock.now().getTime() + 3000),
                updatedAt: new Date(w.clock.now().getTime() + 3000),
              });
            return n;
          },
        }),
      );
    const off = await scim(w, token, "PATCH", `/Users/${id}`, OFF);
    storage.transaction = transaction;
    expect(off.status).toBe(200);
    const [row] = await pendingOf(w, user.id);
    // The family of the race row is one that the act did not end.
    expect(row?.data?.families).toContain(last.familyId);
    expect(await refresh(h, race, clientId)).toBe(400);
    // The refusal ends the family with its mark, as a reuse does.
    expect(await marks(w, [last.familyId])).toBe(1);
  });

  it("covers a session from a clock 2 s ahead at the door and in the sweep", async () => {
    const { w, token, user, id } = await oauthWorld();
    w.clock.advance(MINUTE);
    for (let i = 0; i < 40; i++)
      await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
    // An instance whose clock runs 2 s ahead writes one more session.
    w.clock.advance(2000);
    const ahead = await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
    w.clock.advance(-2000);
    const off = await scim(w, token, "PATCH", `/Users/${id}`, OFF);
    expect(off.status).toBe(200);
    expect(
      await w.storage.findOne("session", [{ field: "id", op: "eq", value: ahead.session.id }]),
    ).not.toBeNull();
    expect(await resolveSession(w.config, ahead.token, "read-only")).toBeNull();
    expect(await sessionLive(w.config, { sid: ahead.session.id })).toBe(false);
    for (let i = 0; i < 5 && (await pendingOf(w, user.id)).length > 0; i++)
      await sweepExpired(w.config);
    expect(await pendingOf(w, user.id)).toEqual([]);
    expect(
      await w.storage.findMany("session", [{ field: "userId", op: "eq", value: user.id }]),
    ).toEqual([]);
  });
});

describe("the record of a SCIM deactivate and the door of each family (ruling 56 of plan 12d)", () => {
  const MINUTE = 60_000;
  const DAY = 86_400_000;
  const OFF = patch({ op: "replace", path: "active", value: false });
  const SCOPE = "mcp:read offline_access";

  /** The world with OAuth, a session.afterEnd hook (the worst page), and Ada as a SCIM User. */
  async function oauthWorld(refreshTtlDays?: number, extra: Partial<AuthConfig> = {}) {
    const w = await world({
      ...extra,
      oauth: {
        resources: [RESOURCE],
        scopes: SCOPES,
        registration: { cimd: false, dynamic: true },
        ...(refreshTtlDays === undefined ? {} : { refreshTtlDays }),
      },
      hooks: { session: { afterEnd: () => {} } },
    });
    const token = await tokenOf(w, w.organizationId);
    await signUpAndVerify(w, ADA);
    const user = await userAt(w, ADA);
    if (!user) throw new Error("no user");
    const id = await created(w, token, ADA);
    const h = { auth: { handle: w.handle }, config: w.config, storage: w.storage, clock: w.clock };
    const s = await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
    const cookie = `__Host-tempo_session=${s.token}`;
    return { w, h: h as unknown as Handle, token, user, id, cookie };
  }

  /** `n` OAuth families of the user through the code flow of a public client: each refresh token. */
  async function families(h: Handle, cookie: string, clientId: string, n: number) {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const p = await pkce();
      const { code } = await authorized(h, cookie, {
        clientId,
        challenge: p.challenge,
        scope: SCOPE,
      });
      const res = await h.auth.handle(exchange(code, clientId, p.verifier));
      if (res.status !== 200) throw new Error(`token answered ${res.status}`);
      out.push(((await res.json()) as { refresh_token: string }).refresh_token);
    }
    return out;
  }

  const refresh = async (h: Handle, refreshToken: string, clientId: string) =>
    (
      await h.auth.handle(
        tokenPost({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
        }),
      )
    ).status;

  const rowsOf = (w: World, purpose: string, userId: string) =>
    w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: purpose },
      { field: "identifier", op: "eq", value: userId },
    ]);

  /** Every sweep until no pending-end row of the user stays. */
  async function sweepAll(w: World, userId: string) {
    for (let i = 0; i < 10 && (await rowsOf(w, "session-end", userId)).length > 0; i++)
      await sweepExpired(w.config);
    expect(await rowsOf(w, "session-end", userId)).toEqual([]);
  }

  /** The refresh row of a refresh token. */
  const rowOf = async (w: World, refreshToken: string) =>
    w.storage.findOne("oauthToken", [
      { field: "tokenHash", op: "eq", value: await sha256Hex(refreshToken) },
    ]);

  /**
   * The deactivate of Ada with 20 families, while an exchange of one more
   * code commits its refresh row after the token delete of the act. With
   * `ahead`, an instance whose clock runs `ahead` ms ahead runs the
   * authorize and the exchange. The answer is the refresh token of the
   * exchange and the pending-end row.
   */
  async function racedDeactivate(
    t: Awaited<ReturnType<typeof oauthWorld>>,
    ahead = 0,
    ttl: number | null = null,
  ) {
    const { w, h, token, user, id, cookie } = t;
    w.clock.advance(MINUTE);
    const clientId = await registered(h);
    await families(h, cookie, clientId, 20);
    w.clock.advance(MINUTE);
    // The code of one more grant, made before the act.
    const p = await pkce();
    w.clock.advance(ahead);
    const { code } = await authorized(h, cookie, {
      clientId,
      challenge: p.challenge,
      scope: SCOPE,
    });
    w.clock.advance(-ahead);
    // On Postgres an exchange can commit its refresh row after the token delete of the
    // act began. Then the delete does not see the row (rereview of ruling 55). The fixture
    // runs that exchange while the transaction is open, right after its token delete.
    let answer: Response | null = null;
    const storage = w.storage;
    const transaction = storage.transaction.bind(storage);
    storage.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          delete: async (model, where) => {
            const n = await tx.delete(model, where);
            if (model === "oauthToken" && answer === null) {
              // With `ttl`, another instance with that refreshTtlDays runs the exchange.
              const oauth = w.config.oauth as { refreshTtlDays: number };
              const own = oauth.refreshTtlDays;
              if (ttl !== null) oauth.refreshTtlDays = ttl;
              w.clock.advance(ahead);
              answer = await h.auth.handle(exchange(code, clientId, p.verifier));
              w.clock.advance(-ahead);
              oauth.refreshTtlDays = own;
            }
            return n;
          },
        }),
      );
    const off = await scim(w, token, "PATCH", `/Users/${id}`, OFF);
    storage.transaction = transaction;
    expect(off.status).toBe(200);
    const exchanged = answer as Response | null;
    if (!exchanged) throw new Error("the exchange did not run");
    expect(exchanged.status).toBe(200);
    const raced = ((await exchanged.json()) as { refresh_token: string }).refresh_token;
    const [row] = await rowsOf(w, "session-end", user.id);
    if (!row) throw new Error("no pending-end row");
    return { clientId, raced, row };
  }

  it("refuses after every sweep a family that an exchange committed after the token delete", async () => {
    const t = await oauthWorld();
    const { w, h, user } = t;
    const { clientId, raced, row } = await racedDeactivate(t);
    const family = (await rowOf(w, raced))?.familyId;
    // The row names the families that the act read and did not end, not this one.
    expect(row.data?.families).not.toContain(family);
    await sweepAll(w, user.id);
    const records = await rowsOf(w, "session-end-record", user.id);
    expect(records.map((r) => r.data)).toEqual([{ reason: "revoked", before: row.data?.before }]);
    // The record refuses the family, and the refusal ends it.
    expect(await refresh(h, raced, clientId)).toBe(400);
    expect(await rowOf(w, raced)).toBeNull();
  });

  it("keeps the record until before plus the longest life, and the sweep deletes it then", async () => {
    const { w, token, user, id } = await oauthWorld();
    w.clock.advance(MINUTE);
    for (let i = 0; i < 40; i++)
      await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
    w.clock.advance(MINUTE);
    expect((await scim(w, token, "PATCH", `/Users/${id}`, OFF)).status).toBe(200);
    await sweepAll(w, user.id);
    const [record, ...more] = await rowsOf(w, "session-end-record", user.id);
    expect(more).toEqual([]);
    const before = new Date(String(record?.data?.before)).getTime();
    // The longest life of a family on any instance (ruling 74 item 7): a refresh token of
    // 365 days from a device code of 30 minutes, then one day.
    expect((record?.expiresAt.getTime() ?? 0) - before).toBe(366 * DAY + 30 * MINUTE);
    w.clock.advance(before + 366 * DAY + 29 * MINUTE - w.clock.now().getTime());
    await sweepExpired(w.config);
    expect(await rowsOf(w, "session-end-record", user.id)).toHaveLength(1);
    w.clock.advance(2 * MINUTE);
    await sweepExpired(w.config);
    expect(await rowsOf(w, "session-end-record", user.id)).toEqual([]);
  });

  it("keeps the record life of the act config across many sweeps when a deploy lowers it (ruling 74 item 9)", async () => {
    // Sessions of 400 days outlive every family, so the session life of the act config holds.
    const t = await oauthWorld(undefined, { session: { ttlDays: 400 } });
    const { w, h, user } = t;
    const { clientId, raced, row } = await racedDeactivate(t);
    const before = new Date(String(row.data?.before)).getTime();
    // The pending-end row stores the life of the act config: 400 days, then one day.
    expect(row.data?.recordLife).toBe(401 * DAY);
    // A deploy lowers session.ttlDays to 30. Then a sweep runs each 10 days for 300 days.
    (w.config.session as { ttlDays: number }).ttlDays = 30;
    const expiries = new Set<number>();
    for (let day = 1; day <= 300; day += 10) {
      w.clock.advance(before + day * DAY - w.clock.now().getTime());
      await sweepExpired(w.config);
      const records = await rowsOf(w, "session-end-record", user.id);
      expect(records, `day ${day}`).toHaveLength(1);
      for (const r of records) expiries.add(r.expiresAt.getTime());
    }
    // Each sweep kept the one expiry from before: the life of the act config.
    expect([...expiries]).toEqual([before + 401 * DAY]);
    expect(await refresh(h, raced, clientId)).toBe(400);
  });

  it("covers a family of an instance with a longer refreshTtlDays (ruling 74 item 7)", async () => {
    const t = await oauthWorld();
    const { w, h, user } = t;
    // The act runs with 30 days; another instance with 90 days runs the raced exchange.
    const { clientId, raced, row } = await racedDeactivate(t, 0, 90);
    const before = new Date(String(row.data?.before)).getTime();
    const token = await rowOf(w, raced);
    expect((token?.expiresAt.getTime() ?? 0) - before).toBeGreaterThan(89 * DAY);
    await sweepAll(w, user.id);
    // On day 60 the family still lives, so the record still refuses it.
    w.clock.advance(before + 60 * DAY - w.clock.now().getTime());
    await sweepExpired(w.config);
    expect(await rowsOf(w, "session-end-record", user.id)).toHaveLength(1);
    expect(await refresh(h, raced, clientId)).toBe(400);
  });

  it("refuses after every sweep a family that an instance 2 s ahead authorized and exchanged after the act", async () => {
    const t = await oauthWorld();
    const { w, h, user } = t;
    // The act reads no row of that instance: the family starts after the act on its clock.
    const { clientId, raced, row } = await racedDeactivate(t, 2000);
    const family = await rowOf(w, raced);
    expect(new Date(String(row.data?.before)).getTime()).toBeGreaterThanOrEqual(
      family?.createdAt.getTime() ?? Number.POSITIVE_INFINITY,
    );
    await sweepAll(w, user.id);
    expect(await rowsOf(w, "session-end-record", user.id)).toHaveLength(1);
    expect(await refresh(h, raced, clientId)).toBe(400);
  });

  it(
    "covers the newest session of a user with 521 sessions and one from a clock 2 s ahead",
    async () => {
      const { w, token, user, id } = await oauthWorld();
      w.clock.advance(MINUTE);
      for (let i = 0; i < 520; i++)
        await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
      // An instance whose clock runs 2 s ahead writes one more session.
      w.clock.advance(2000);
      const ahead = await createSession(w.config, { userId: user.id, ip: null, userAgent: null });
      w.clock.advance(-2000);
      expect((await scim(w, token, "PATCH", `/Users/${id}`, OFF)).status).toBe(200);
      // The page did not end it: it waits for the sweep.
      expect(
        await w.storage.findOne("session", [{ field: "id", op: "eq", value: ahead.session.id }]),
      ).not.toBeNull();
      expect(await resolveSession(w.config, ahead.token, "read-only")).toBeNull();
      expect(await sessionLive(w.config, { sid: ahead.session.id })).toBe(false);
    },
    LONG_TEST_MS,
  );

  it("answers inactive at introspection for a race row of a family on the pending-end row", async () => {
    const { w, h, token, user, id, cookie } = await oauthWorld();
    w.clock.advance(MINUTE);
    await families(h, cookie, await registered(h), 20);
    // A confidential client that introspects its own refresh tokens makes the last family.
    // A later clock gives its rows the last ids, so the act reads its family last.
    w.clock.advance(1000);
    const made = await createClient(w.config, {
      name: "Notes server",
      authMethod: "client_secret_basic",
      redirectUris: [REDIRECT],
      introspect: true,
    });
    if (!made.ok || !made.value.clientSecret) throw new Error("the create failed");
    const auth = basicHeader(made.value.client.id, made.value.clientSecret);
    const p = await pkce();
    const { code } = await authorized(h, cookie, {
      clientId: made.value.client.id,
      challenge: p.challenge,
      scope: SCOPE,
    });
    const res = await h.auth.handle(
      tokenPost(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: p.verifier,
          redirect_uri: REDIRECT,
          resource: RESOURCE,
        },
        { authorization: auth },
      ),
    );
    expect(res.status).toBe(200);
    const last = await rowOf(w, ((await res.json()) as { refresh_token: string }).refresh_token);
    if (!last) throw new Error("no refresh row");
    w.clock.advance(MINUTE);
    // A refresh in flight on Postgres writes its new row after the token delete of the act.
    const race = `or_${randomBase64Url(32)}`;
    const storage = w.storage;
    const transaction = storage.transaction.bind(storage);
    storage.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          delete: async (model, where) => {
            const n = await tx.delete(model, where);
            if (model === "oauthToken")
              await storage.create("oauthToken", {
                ...last,
                id: `${last.id.slice(0, 10)}${"Z".repeat(16)}`,
                tokenHash: await sha256Hex(race),
                usedAt: null,
                parentId: last.id,
                createdAt: w.clock.now(),
                updatedAt: w.clock.now(),
              });
            return n;
          },
        }),
      );
    const off = await scim(w, token, "PATCH", `/Users/${id}`, OFF);
    storage.transaction = transaction;
    expect(off.status).toBe(200);
    const [row] = await rowsOf(w, "session-end", user.id);
    expect(row?.data?.families).toContain(last.familyId);
    const introspected = await h.auth.handle(
      new Request(`${new URL(RESOURCE).origin}/auth/oauth/introspect`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: auth },
        body: new URLSearchParams({ token: race }).toString(),
      }),
    );
    expect([introspected.status, await introspected.json()]).toEqual([200, { active: false }]);
  });
});

describe("the Entra ID manager PATCH (ruling 55 of plan 12d)", () => {
  const SAMPLE_ID = "00aa00aa-bb11-cc22-dd33-44ee44ee44ee";
  const ref = `https://example.com/scim/Users/${SAMPLE_ID}`;

  for (const path of ["manager", `${ENTERPRISE_URN}:manager`])
    it(`takes the list of one manager object at the path ${path}`, async () => {
      const w = await world();
      const token = await tokenOf(w, w.organizationId);
      const id = await created(w, token, ADA);
      const r = await read(
        await scim(
          w,
          token,
          "PATCH",
          `/Users/${id}`,
          patch({ op: "Add", path, value: [{ $ref: ref, value: SAMPLE_ID }] }),
        ),
      );
      expect([r.status, r.body[ENTERPRISE_URN], r.body.schemas]).toEqual([
        200,
        { manager: { value: SAMPLE_ID, $ref: ref } },
        [USER_URN, ENTERPRISE_URN],
      ]);
      expect(r.body.manager).toBeUndefined();
    });

  it("refuses a list of two manager objects with invalidValue (ruling 56)", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const id = await created(w, token, ADA);
    const two = [
      { $ref: ref, value: SAMPLE_ID },
      { $ref: ref, value: SAMPLE_ID },
    ];
    for (const path of ["manager", `${ENTERPRISE_URN}:manager`]) {
      const r = await read(
        await scim(w, token, "PATCH", `/Users/${id}`, patch({ op: "Add", path, value: two })),
      );
      expect([r.status, r.body.scimType]).toEqual([400, "invalidValue"]);
    }
  });
});

describe("the PATCH forms of an unknown attribute (ruling 50 of plan 12d)", () => {
  it("ignores an unknown key of a no-path value, and refuses a path to it", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const id = await created(w, token, ADA);
    // The no-path form of Entra ID, with an attribute of its own map.
    const noPath = await read(
      await scim(
        w,
        token,
        "PATCH",
        `/Users/${id}`,
        patch({ op: "Replace", value: { displayName: "Ada", shoeSize: 42 } }),
      ),
    );
    expect([noPath.status, noPath.body.displayName, noPath.body.shoeSize]).toEqual([
      200,
      "Ada",
      undefined,
    ]);
    const row = await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: id }]);
    expect(row?.displayName).toBe("Ada");
    expect(JSON.stringify(row?.data)).not.toContain("shoeSize");
    // Plan Behavior 8: an explicit path to an unknown attribute.
    const path = await read(
      await scim(
        w,
        token,
        "PATCH",
        `/Users/${id}`,
        patch({ op: "replace", path: "shoeSize", value: 42 }),
      ),
    );
    expect([path.status, path.body.schemas, path.body.scimType]).toEqual([
      400,
      [ERROR_URN],
      "invalidPath",
    ]);
    const after = await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: id }]);
    expect(after?.version).toBe(row?.version);
  });
});

describe("the credentials and the small round of a SCIM deprovision (ruling 69 of plan 12d)", () => {
  const OFF = patch({ op: "replace", path: "active", value: false });

  /** Ada as an admin of acme, and a token that she made there: the token id. */
  async function adaWithToken(w: World, token: string) {
    await signUpAndVerify(w, ADA);
    const ada = await userAt(w, ADA);
    const owner = await userAt(w, "owner@acme.example");
    if (!ada || !owner) throw new Error("no user");
    const id = await created(w, token, ADA);
    const role = await updateMemberRole(w.config, {
      user: owner,
      organizationId: w.organizationId,
      userId: ada.id,
      role: "admin",
    });
    if (!role.ok) throw new Error(role.code);
    const made = await createOrganizationToken(w.config, {
      user: ada,
      organizationId: w.organizationId,
      name: "ci",
      permissions: {},
      expiresInDays: null,
    });
    if (!made.ok) throw new Error(made.code);
    const kept = await createOrganizationToken(w.config, {
      user: owner,
      organizationId: w.organizationId,
      name: "deploy",
      permissions: {},
      expiresInDays: null,
    });
    if (!kept.ok) throw new Error(kept.code);
    return { ada, id, mine: made.value.apiToken.id, kept: kept.value.apiToken.id };
  }

  const tokenIds = async (w: World) =>
    (
      await w.storage.findMany("organizationToken", [
        { field: "organizationId", op: "eq", value: w.organizationId },
      ])
    ).map((t) => t.id);

  it("deletes the organization tokens that a claimed person made, at a deactivate", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const { id, mine, kept } = await adaWithToken(w, token);
    expect((await tokenIds(w)).sort()).toEqual([mine, kept].sort());
    const off = await scim(w, token, "PATCH", `/Users/${id}`, OFF);
    expect(off.status).toBe(200);
    // The token of the owner stays: only the rows that the person made go.
    expect(await tokenIds(w)).toEqual([kept]);
  });

  it("deletes the organization tokens that a person made, when no domain of the organization claims the address", async () => {
    const w = await world();
    const token = await tokenOf(w, w.organizationId);
    const { id, mine, kept } = await adaWithToken(w, token);
    // With no claim, the deactivate removes the member row only, with its tokens.
    const gone = await deleteDomain(w.config, SCIM_APP, { id: w.domainId });
    if (!gone.ok) throw new Error(gone.code);
    expect((await tokenIds(w)).sort()).toEqual([mine, kept].sort());
    const off = await scim(w, token, "PATCH", `/Users/${id}`, OFF);
    expect(off.status).toBe(200);
    expect(await tokenIds(w)).toEqual([kept]);
  });

  it("covers the newest session in the before of a small round, also from a clock 30 s ahead", async () => {
    const w = await world();
    await signUpAndVerify(w, ADA);
    const ada = await userAt(w, ADA);
    if (!ada) throw new Error("no user");
    // An instance whose clock runs 30 s ahead writes a session: past the 5 s bound of the act.
    w.clock.advance(30_000);
    const ahead = await createSession(w.config, { userId: ada.id, ip: null, userAgent: null });
    w.clock.advance(-30_000);
    const before = await w.storage.transaction((tx) =>
      markAllAccessEnd(tx, w.config, ada.id, meterOf(w.storage, 0), "revoked"),
    );
    expect(before.getTime()).toBeGreaterThanOrEqual(ahead.session.createdAt.getTime());
    // The door reads the row for a session from before the user mark of the act.
    const marked = { id: ada.id, updatedAt: before };
    expect(await revokedFor(w.config, marked, ahead.session)).toBe(true);
  });
  const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

  /**
   * Ada with a code of the code flow and an approved device row, each not
   * yet spent. With `ahead`, an instance whose clock runs `ahead` ms ahead
   * writes both. Then the small round of a deprovision runs: its pending-end
   * row, and the user write after it, as `writeChange` writes them.
   */
  async function smallRoundWithGrants(ahead: number) {
    const w = await world({
      oauth: {
        resources: [RESOURCE],
        scopes: SCOPES,
        registration: { cimd: false, dynamic: true },
        device: {},
      },
    });
    await signUpAndVerify(w, ADA);
    const ada = await userAt(w, ADA);
    if (!ada) throw new Error("no user");
    const h = { auth: { handle: w.handle }, config: w.config, storage: w.storage, clock: w.clock };
    const handle = h as unknown as Handle;
    const s = await createSession(w.config, { userId: ada.id, ip: null, userAgent: null });
    const cookie = `__Host-tempo_session=${s.token}`;
    const registeredRes = await w.handle(
      new Request(`${BASE_URL}/auth/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [REDIRECT],
          client_name: "Living room TV",
          grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
        }),
      }),
    );
    const clientId = ((await registeredRes.json()) as { client_id: string }).client_id;
    w.clock.advance(ahead);
    const p = await pkce();
    const { code } = await authorized(handle, cookie, {
      clientId,
      challenge: p.challenge,
      scope: "mcp:read",
    });
    const deviceCode = await approvedDevice(handle, clientId, cookie);
    w.clock.advance(-ahead);
    const before = await w.storage.transaction(async (tx) => {
      const at = await markAllAccessEnd(tx, w.config, ada.id, meterOf(w.storage, 0), "revoked");
      const now = Math.max(w.clock.now().getTime(), at.getTime());
      await tx.update("user", [{ field: "id", op: "eq", value: ada.id }], {
        updatedAt: new Date(now),
      });
      return at;
    });
    // The poll waits for the interval of the device grant.
    w.clock.advance(6_000);
    const exchanged = await w.handle(exchange(code, clientId, p.verifier));
    const polled = await w.handle(
      tokenPost({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId }),
    );
    const codes = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "oauth-code" },
    ]);
    const devices = await w.storage.findMany("oauthDevice", []);
    return {
      before,
      exchanged: [exchanged.status, ((await exchanged.json()) as { error?: string }).error],
      polled: [polled.status, ((await polled.json()) as { error?: string }).error],
      starts: [...codes, ...devices].map((r) => r.createdAt.getTime()),
    };
  }

  it("refuses the code exchange and the device poll of grants from before a small round (ruling 74 item 17)", async () => {
    const r = await smallRoundWithGrants(0);
    expect(r.exchanged).toEqual([400, "invalid_grant"]);
    expect(r.polled).toEqual([400, "invalid_grant"]);
  });

  it("covers the newest OAuth code and device row in the before of a small round, from a clock 30 s ahead (ruling 74 item 16)", async () => {
    const r = await smallRoundWithGrants(30_000);
    // Both rows start past the 5 s bound of the act, and before still covers them.
    for (const start of r.starts) expect(r.before.getTime()).toBeGreaterThanOrEqual(start);
    expect(r.exchanged).toEqual([400, "invalid_grant"]);
    expect(r.polled).toEqual([400, "invalid_grant"]);
  });
});
