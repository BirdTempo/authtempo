import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { banUser } from "../src/engine/operator/ban.js";
import { addMember } from "../src/engine/organizations.js";
import { createScimToken, revokeScimToken } from "../src/engine/scim/tokens.js";
import { resolveSession } from "../src/engine/sessions.js";
import {
  createConnection,
  deleteConnection,
  updateConnection,
} from "../src/engine/sso/connections.js";
import {
  addDomain,
  deleteDomain,
  enforceOff,
  updateDomain,
  verifyDomain,
} from "../src/engine/sso/domains.js";
import { requireSsoManager, type SsoActor } from "../src/engine/sso/guard.js";
import { activateSetup } from "../src/engine/sso/setup-activate.js";
import { saveDraftConnection } from "../src/engine/sso/setup-drafts.js";
import { createSetupLink, handBack, revokeSetupLink } from "../src/engine/sso/setup-links.js";
import { openSetupSession, requireSetupSession } from "../src/engine/sso/setup-session.js";
import { sweepExpired } from "../src/engine/sweep.js";
import { ok } from "../src/result.js";
import { get, recordAddress, recordCredential, seedPlatform } from "./helpers.js";
import { OPERATOR_EMAIL } from "./operator-helpers.js";
import { signUpAndVerify } from "./password-helpers.js";
import { SCIM_APP, scim, scimAuth } from "./scim/helpers.js";
import { type FakeIdToken, fakeFetch, fakeJwt } from "./social-helpers.js";
import { SSO_APP } from "./sso/helpers.js";
import { endpointsOf, issuerOf } from "./sso/sign-in-helpers.js";
import { enrolled, PASSWORD, verifiedSession } from "./totp-helpers.js";

// Plan 13b Task 3: each SSO and SCIM writer puts the organization in the column of its audit row.

const META = { ip: recordAddress("198.51.100.9"), userAgent: "organization-audit-column-test" };
const SECRET = "idp-client-secret-0123456789";
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const BIND = "__Secure-tempo_session_oauth";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const OIDC = {
  kind: "oidc",
  label: "Acme Okta",
  issuer: issuerOf("acme"),
  clientId: "acme-client",
  clientSecret: SECRET,
  endpoints: endpointsOf("acme"),
} as const;

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The world of `scimAuth` (organization `o1`, its owner, a verified domain) with setup, OIDC on a fake IdP, and the operator tools. */
async function world() {
  const tokens: Record<string, FakeIdToken> = {};
  const idp = fakeFetch((call) =>
    Response.json({ id_token: call.form.code, token_type: "Bearer" }),
  );
  const w = await scimAuth({
    // Groups as roles, so the SCIM group writes run (review M1).
    scim: { groups: "roles" },
    sso: { oidc: true, setup: {}, fetch: idp.fetchFn },
    jwt: fakeJwt(tokens),
    operator: { users: true },
  });
  return { ...w, tokens, o1: w.org };
}
type W = Awaited<ReturnType<typeof world>>;

/** The actor that the manager guard gives for a session token, as a route gets it. */
async function guarded(w: W, token: string): Promise<SsoActor> {
  const resolved = await resolveSession(w.config, token);
  if (!resolved) throw new Error("the session ended");
  const r = await requireSsoManager(w.config, resolved, w.o1);
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/**
 * A platform operator who owns no organization, through the flows of the product: the app seeds
 * the platform organization and root (`seedPlatform`), root adds the operator, and the operator
 * signs in after the grant and turns TOTP on.
 */
async function platformActor(w: W): Promise<SsoActor> {
  const { root, platformOrg } = await seedPlatform(w);
  await signUpAndVerify(w, OPERATOR_EMAIL, PASSWORD);
  const user = await w.storage.findOne("user", [
    { field: "email", op: "eq", value: OPERATOR_EMAIL },
  ]);
  if (!user) throw new Error("no operator user");
  const added = await addMember(w.config, {
    user: root,
    organizationId: platformOrg.id,
    userId: user.id,
    role: "operator",
  });
  if (!added.ok) throw new Error(added.code);
  const actor = await guarded(w, (await enrolled(w, OPERATOR_EMAIL)).session.token);
  if (actor.kind !== "platform") throw new Error(`the guard gave ${actor.kind}`);
  return actor;
}

/** A setup session of `o1` through the real link, open, and check of the cookie. */
async function setupSession(w: W, actor: SsoActor) {
  const made = await createSetupLink(
    w.config,
    actor,
    { organizationId: w.o1, steps: ["connection"], kinds: ["oidc"], note: "Ada at Acme IT" },
    META,
  );
  if (!made.ok) throw new Error(made.code);
  recordCredential(made.value.token);
  const opened = await openSetupSession(w.config, made.value.token, META);
  if (!opened.ok) throw new Error(opened.code);
  const cookie = opened.value.cookie.split(";")[0] ?? "";
  recordCredential(cookie.split("=")[1] ?? "");
  const checked = await requireSetupSession(
    w.config,
    new Request("https://auth.example/auth/sso/setup/status", { headers: { cookie } }),
  );
  if (!checked.ok) throw new Error(checked.code);
  return { ...checked.value, cookie, linkId: made.value.id };
}

/** A whole OIDC test run of the draft of a setup session: the start and the callback, which passes. */
async function passedTest(w: W, s: Awaited<ReturnType<typeof setupSession>>) {
  const saved = await saveDraftConnection(w.config, s, OIDC);
  if (!saved.ok) throw new Error(saved.code);
  const id = saved.value.id;
  const started = await w.handle(get(`/auth/sso/${id}/start?test=1`, { cookie: s.cookie }));
  const url = new URL(started.headers.get("location") ?? "");
  const code = "column-code-1";
  w.tokens[code] = {
    audience: "acme-client",
    issuer: issuerOf("acme"),
    claims: {
      sub: "a-1",
      email: "ada@acme.example",
      name: "Ada",
      nonce: url.searchParams.get("nonce") ?? "",
    },
  };
  const bind = started.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${BIND}=`))
    ?.split(";")[0];
  const q = new URLSearchParams({ code, state: url.searchParams.get("state") ?? "" });
  await w.handle(get(`/auth/sso/${id}/callback?${q}`, { cookie: bind ?? "" }));
  const run = await w.storage.findOne("ssoTestRun", [
    { field: "connectionId", op: "eq", value: id },
  ]);
  if (run?.outcome !== "passed") throw new Error(`the test run is ${run?.outcome}`);
  return id;
}

const auditOf = (w: W, action: string) =>
  w.storage.findMany("operatorAudit", [{ field: "action", op: "eq", value: action }]);

describe("the organization column on the existing writers (plan 13b Task 3)", () => {
  it("SSO act: an owner creates a connection in o1", async () => {
    const w = await world();
    const owner = await guarded(w, w.owner.token);
    expect(owner.kind).toBe("owner");
    const made = await createConnection(w.config, owner, { ...OIDC, organizationId: w.o1 }, META);
    expect(made.ok).toBe(true);
    const [row] = await auditOf(w, "sso_connection_create");
    expect(row?.organizationId).toBe(w.o1);
    expect(row?.data?.organizationId).toBe(w.o1);
    // A member act is no platform act: the flag is absent.
    expect(row?.data).not.toHaveProperty("platform");
  });

  it("platform act: a platform operator deletes a domain of o1", async () => {
    const w = await world();
    const operator = await platformActor(w);
    expect(await deleteDomain(w.config, operator, { id: w.domainId, ...META })).toEqual(
      ok({ ok: true }),
    );
    const [row] = await auditOf(w, "sso_domain_delete");
    expect(row?.actorKind).toBe("user");
    expect(row?.data?.platform).toBe(true);
    expect(row?.organizationId).toBe(w.o1);
  });

  it("SCIM act: a token dir-1 creates a user in o1", async () => {
    const w = await world();
    const made = await createScimToken(w.config, SCIM_APP, { organizationId: w.o1, name: "dir-1" });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const res = await scim(w, made.value.token, "POST", "/Users", {
      schemas: [USER_URN],
      userName: "ada@acme.example",
    });
    expect(res.status).toBe(201);
    const [row] = await auditOf(w, "scim_user_create");
    expect(row?.actorKind).toBe("scim");
    expect(row?.actorId).toBe("dir-1");
    expect(row?.organizationId).toBe(w.o1);
  });

  it("domain lost: the recheck loses a domain of o1", async () => {
    const w = await world();
    w.clock.advance(31 * DAY_MS);
    for (const answers of [w.answers.a, w.answers.b])
      for (const name of Object.keys(answers)) answers[name] = [];
    // Three failures at 0, 36, and 72 hours lose the domain.
    for (const hours of [0, 36, 36]) {
      w.clock.advance(hours * HOUR_MS);
      await sweepExpired(w.config);
    }
    const rows = await auditOf(w, "sso_domain_lost");
    expect(rows.map((r) => r.organizationId)).toEqual([w.o1]);
  });

  it("setup acts: create, open, revoke, activate a link; one test run", async () => {
    const w = await world();
    const owner = await guarded(w, w.owner.token);
    const s = await setupSession(w, owner);
    const draftId = await passedTest(w, s);
    const draft = await w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: draftId },
    ]);
    const activated = await activateSetup(
      w.config,
      owner,
      s.linkId,
      draft?.version ?? 0,
      async () => ok(undefined),
      META,
    );
    expect(activated.ok).toBe(true);
    const other = await createSetupLink(w.config, owner, {
      organizationId: w.o1,
      steps: ["domain"],
      kinds: ["oidc"],
      note: "Bo at Acme IT",
    });
    if (!other.ok) throw new Error(other.code);
    recordCredential(other.value.token);
    expect(await revokeSetupLink(w.config, owner, other.value.id, META)).toEqual(ok(undefined));
    const actions = [
      "sso_setup_link_create",
      "sso_setup_link_open",
      "sso_setup_link_revoke",
      "sso_setup_link_activate",
      "sso_test_run",
    ];
    const rows = await w.storage.findMany("operatorAudit", [
      { field: "action", op: "in", value: actions },
    ]);
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(actions));
    for (const row of rows) expect([row.action, row.organizationId]).toEqual([row.action, w.o1]);
  });

  it("hand back: a first and a second hand back write one sso_setup_link_ready row", async () => {
    const w = await world();
    const s = await setupSession(w, SSO_APP);
    expect(await handBack(w.config, s)).toEqual(ok(undefined));
    w.clock.advance(HOUR_MS);
    expect(await handBack(w.config, s)).toEqual(ok(undefined));
    const rows = await auditOf(w, "sso_setup_link_ready");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: "app",
      actorId: `setup.${s.linkId.toLowerCase()}`,
      organizationId: w.o1,
      data: { organizationId: w.o1, linkId: s.linkId },
    });
  });

  // Review M1: each other writer of `ssoDraft` and `draftOf` names the organization of its data.
  it("each other writer: the column equals data.organizationId", async () => {
    const w = await world();
    const added = await addDomain(w.config, SSO_APP, {
      organizationId: w.o1,
      domain: "beta.example",
    });
    if (!added.ok || added.value.record === null) throw new Error("no beta record");
    const { name, value } = added.value.record;
    w.answers.a[name] = [value];
    w.answers.b[name] = [value];
    expect((await verifyDomain(w.config, SSO_APP, { id: added.value.id })).ok).toBe(true);
    const routed = await updateDomain(w.config, SSO_APP, {
      id: added.value.id,
      includeSubdomains: true,
    });
    expect(routed.ok).toBe(true);
    const made = await createConnection(w.config, SSO_APP, { ...OIDC, organizationId: w.o1 });
    if (!made.ok) throw new Error(made.code);
    const id = made.value.id;
    expect((await updateConnection(w.config, SSO_APP, { id, enabled: false })).ok).toBe(true);
    expect((await deleteConnection(w.config, SSO_APP, { id })).ok).toBe(true);
    const token = await createScimToken(w.config, SCIM_APP, {
      organizationId: w.o1,
      name: "dir-1",
    });
    if (!token.ok) throw new Error(token.code);
    recordCredential(token.value.token);
    const group = await scim(w, token.value.token, "POST", "/Groups", {
      schemas: [GROUP_URN],
      displayName: "Staff",
    });
    expect(group.status).toBe(201);
    const groupId = ((await group.json()) as { id: string }).id;
    const put = await scim(w, token.value.token, "PUT", `/Groups/${groupId}`, {
      schemas: [GROUP_URN],
      displayName: "Staff 2",
    });
    expect(put.status).toBe(200);
    expect((await scim(w, token.value.token, "DELETE", `/Groups/${groupId}`)).status).toBe(204);
    const revoked = await revokeScimToken(w.config, SCIM_APP, { id: token.value.id });
    expect(revoked.ok).toBe(true);
    // The second row of an activation: the draft connection goes live.
    const s = await setupSession(w, SSO_APP);
    const draftId = await passedTest(w, s);
    const draft = await w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: draftId },
    ]);
    const activated = await activateSetup(
      w.config,
      SSO_APP,
      s.linkId,
      draft?.version ?? 0,
      async () => ok(undefined),
      META,
    );
    expect(activated.ok).toBe(true);
    const actions = [
      "sso_domain_add",
      "sso_domain_verify",
      "sso_domain_update",
      "sso_connection_update",
      "sso_connection_delete",
      "scim_token_create",
      "scim_token_revoke",
      "scim_group_create",
      "scim_group_update",
      "scim_group_delete",
    ];
    const rows = await w.storage.findMany("operatorAudit", [
      { field: "action", op: "in", value: actions },
    ]);
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(actions));
    // Two connection updates: the disable, and the activation of the draft.
    expect(rows.filter((r) => r.action === "sso_connection_update")).toHaveLength(2);
    for (const row of rows)
      expect([row.action, row.organizationId]).toEqual([row.action, row.data?.organizationId]);
    for (const row of rows) expect([row.action, row.organizationId]).toEqual([row.action, w.o1]);
  });

  it("operator act: ban a member of o1", async () => {
    const w = await world();
    const member = await verifiedSession(w, "member@acme.example");
    const added = await addMember(w.config, {
      user: w.owner.user,
      organizationId: w.o1,
      userId: member.user.id,
      role: "member",
    });
    if (!added.ok) throw new Error(added.code);
    const banned = await banUser(w.config, {
      actor: SSO_APP,
      userId: member.user.id,
      reason: "the member broke the rules",
      ip: null,
      userAgent: null,
    });
    expect(banned.ok).toBe(true);
    // Review M3: a platform operator user is the actor of decision 4. The member is banned, so
    // the operator bans the owner of o1.
    const operator = await platformActor(w);
    if (operator.kind !== "platform") throw new Error("no platform actor");
    const second = await banUser(w.config, {
      actor: { kind: "user", user: operator.user, session: operator.session },
      userId: w.owner.user.id,
      reason: "the owner broke the rules",
      ip: null,
      userAgent: null,
    });
    expect(second.ok).toBe(true);
    const rows = await auditOf(w, "ban");
    expect(rows.map((r) => [r.actorKind, r.targetUserId, r.organizationId])).toEqual([
      ["app", member.user.id, null],
      ["user", w.owner.user.id, null],
    ]);
  });

  // Owner decision 4: an operator act on an organization shows as `platform` in its audit.
  it("enforce off: a platform operator turns enforce off on a domain of o1", async () => {
    const w = await world();
    const operator = await platformActor(w);
    if (operator.kind !== "platform") throw new Error("no platform actor");
    const off = await enforceOff(
      w.config,
      { kind: "user", user: operator.user, session: operator.session },
      { domainId: w.domainId, reason: "the IdP is down", ...META },
    );
    expect(off.ok).toBe(true);
    const [row] = await auditOf(w, "sso_enforce_off");
    expect(row?.organizationId).toBe(w.o1);
    expect(row?.data?.platform).toBe(true);
    expect(row?.reason).toBe("the IdP is down");
  });
});
