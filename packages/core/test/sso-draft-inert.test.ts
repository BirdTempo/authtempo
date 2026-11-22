import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createScimToken, type ScimTokenSummary } from "../src/engine/scim/tokens.js";
import {
  createConnection,
  type SsoConnectionSummary,
  updateConnection,
} from "../src/engine/sso/connections.js";
import { discoverSso } from "../src/engine/sso/discover.js";
import { updateDomain } from "../src/engine/sso/domains.js";
import { enforcedAnswer, ssoRequiredFor } from "../src/engine/sso/enforce.js";
import { startSso } from "../src/engine/sso/oidc.js";
import { setupConnectionBody, setupDomainAddBody } from "../src/http/contract/sso.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { newId } from "../src/primitives/ids.js";
import { createTestIdp } from "../src/testing/saml-idp.js";
import { BASE_URL, get, post } from "./helpers.js";
import { SCIM_APP, type ScimWorld, scim, scimAuth, scimToken } from "./scim/helpers.js";
import { SSO_APP } from "./sso/helpers.js";
import {
  postResponse,
  responseFor,
  rowCounts,
  samlConnection,
  samlStart,
} from "./sso/saml-helpers.js";

/**
 * Plan 13a Task 5 and pre-flight C7: a draft of a setup link signs in no
 * one. Task 4 writes a draft as `enabled: false` with `draft: true` and the
 * link id (pre-flight C6), and a pending SCIM token with `pending: true`.
 * Task 4 has no call yet, so these tests make the row through the call of
 * the app with `enabled: false` and then write the two setup columns. The
 * result is the row of Task 4.
 */

beforeEach(() => {
  // Each refused step writes one log line; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const IP = "203.0.113.31";

/** The world of `scimAuth` with OIDC and SAML on. The domain `acme.example` is verified. */
function world() {
  return scimAuth({ sso: { oidc: true, saml: true } });
}

/** A setup link row of the organization, as the mint of Task 2 writes it. Its id. */
async function setupLink(w: ScimWorld): Promise<string> {
  const now = w.clock.now();
  const id = newId(now);
  await w.storage.create("ssoSetupLink", {
    id,
    createdAt: now,
    updatedAt: now,
    organizationId: w.org,
    tokenHash: await sha256Hex(`sl_${id}`),
    hint: "abcd",
    steps: ["domain", "connection", "directory"],
    kinds: ["oidc", "saml"],
    note: "IT contact",
    createdBy: SCIM_APP.name,
    expiresAt: new Date(now.getTime() + 72 * 3_600_000),
    revokedAt: null,
    endedAt: null,
    openedAt: now,
    readyAt: null,
  });
  return id;
}

/** Writes the setup columns of Task 4 on a row that is off: the row is then a draft of the link. */
async function markDraft(w: ScimWorld, connectionId: string, linkId: string): Promise<void> {
  const n = await w.storage.update(
    "ssoConnection",
    [
      { field: "id", op: "eq", value: connectionId },
      { field: "enabled", op: "eq", value: false },
    ],
    { draft: true, setupLinkId: linkId },
  );
  if (n !== 1) throw new Error("no draft written");
}

/** An OIDC connection with fixed endpoints, made by the app. `enabled` false for a draft. */
async function oidcConnection(w: ScimWorld, enabled: boolean, label = "Acme OIDC") {
  const host = "https://login.acme-idp.example";
  const r = await createConnection(w.config, SSO_APP, {
    organizationId: w.org,
    kind: "oidc",
    label,
    enabled,
    issuer: host,
    clientId: "acme-client",
    clientSecret: "acme-secret-0123456789",
    endpoints: {
      authorizeUrl: `${host}/authorize`,
      tokenUrl: `${host}/token`,
      jwksUrl: `${host}/keys`,
    },
  });
  if (!r.ok) throw new Error(r.code);
  return r.value.id;
}

/** An OIDC draft of a new setup link. */
async function oidcDraft(w: ScimWorld): Promise<{ id: string; linkId: string }> {
  const linkId = await setupLink(w);
  const id = await oidcConnection(w, false, "Acme draft");
  await markDraft(w, id, linkId);
  return { id, linkId };
}

/** Routes the verified domain of the world to the connection, through the call of the app. */
async function route(w: ScimWorld, connectionId: string): Promise<void> {
  const r = await updateDomain(w.config, SSO_APP, { id: w.domainId, connectionId });
  if (!r.ok) throw new Error(r.code);
}

/** The state rows of a start for the connection: OIDC and SAML. */
async function startRows(w: ScimWorld, connectionId: string) {
  const rows = await w.storage.findMany("verification", []);
  return rows.filter((r) => r.identifier === `sso:${connectionId}` || r.identifier === connectionId)
    .length;
}

/** One manager route call with the owner's session: the status and the body. */
async function send(
  w: ScimWorld,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<[number, Record<string, unknown>]> {
  const headers = {
    "cf-connecting-ip": IP,
    cookie: `__Host-tempo_session=${w.owner.token}`,
  };
  const res = await w.handle(
    method === "GET"
      ? get(`/auth${path}`, headers)
      : post(`/auth${path}`, body, { ...headers, origin: BASE_URL }),
  );
  return [res.status, (await res.json()) as Record<string, unknown>];
}

/** The `auth_error` of a redirect. */
function authError(res: Response): string | null {
  return new URL(res.headers.get("location") ?? "", "https://x.invalid").searchParams.get(
    "auth_error",
  );
}

describe("drafts stay inert (plan 13a Task 5)", () => {
  it("normal start of a draft: 404 sso_not_configured, and no state row", async () => {
    const w = await world();
    const oidc = await oidcDraft(w);
    const idp = await createTestIdp({ alg: "ec" });
    const saml = await samlConnection(w, w.org, idp, { enabled: false });
    await markDraft(w, saml, oidc.linkId);
    for (const id of [oidc.id, saml]) {
      expect(await startSso(w.config, { connectionId: id, ip: IP })).toEqual({
        ok: false,
        code: "sso_not_configured",
        status: 404,
      });
      // The route answers the failure as the redirect to the error page of the app.
      const res = await w.handle(get(`/auth/sso/${id}/start`, { "cf-connecting-ip": IP }));
      expect([res.status, authError(res), res.headers.getSetCookie()]).toEqual([
        302,
        "sso_not_configured",
        [],
      ]);
      expect(await startRows(w, id)).toBe(0);
    }
  });

  it("a domain cannot route to a draft: updateDomain answers not_found", async () => {
    const w = await world();
    const draft = await oidcDraft(w);
    const r = await updateDomain(w.config, SSO_APP, { id: w.domainId, connectionId: draft.id });
    expect(r.ok ? null : [r.code, r.status]).toEqual(["not_found", 404]);
    const row = await w.storage.findOne("ssoDomain", [
      { field: "id", op: "eq", value: w.domainId },
    ]);
    expect(row?.connectionId).toBeNull();
    // A connection that the manager made is no draft, so the same call routes to it.
    const own = await oidcConnection(w, false, "Acme own");
    const routed = await updateDomain(w.config, SSO_APP, { id: w.domainId, connectionId: own });
    expect(routed.ok ? routed.value.connectionId : routed.code).toBe(own);
  });

  it("discovery: a verified domain routed to a connection that is off finds no SSO route", async () => {
    // A domain cannot route to a draft, so the reachable row routes, then turns the connection off.
    const w = await world();
    const id = await oidcConnection(w, true);
    await route(w, id);
    const off = await updateConnection(w.config, SSO_APP, { id, enabled: false });
    expect(off.ok ? off.value.enabled : off.code).toBe(false);
    expect(await discoverSso(w.config, { email: "ada@acme.example", ip: IP })).toEqual({
      ok: true,
      value: { sso: false },
    });
    const res = await w.handle(
      post("/auth/sso/discover", { email: "ada@acme.example" }, { "cf-connecting-ip": IP }),
    );
    expect([res.status, await res.json()]).toEqual([200, { sso: false }]);
  });

  it("pending token: GET /scim/v2/Users answers 401 as for an unknown token", async () => {
    const w = await world();
    const linkId = await setupLink(w);
    const made = await scimToken(w);
    // The pending columns of Task 4 on the row of a mint.
    await w.storage.update("scimToken", [{ field: "id", op: "eq", value: made.id }], {
      pending: true,
      setupLinkId: linkId,
    });
    const unknown = await scim(w, `${made.token.slice(0, -4)}zzzz`, "GET", "/Users");
    const pending = await scim(w, made.token, "GET", "/Users");
    expect(pending.status).toBe(401);
    expect([pending.status, await pending.text()]).toEqual([unknown.status, await unknown.text()]);
    const row = await w.storage.findOne("scimToken", [{ field: "id", op: "eq", value: made.id }]);
    expect(row?.lastUsedAt).toBeNull();
  });

  it("ACS to a draft with the state of a live start: refused at the request check", async () => {
    const w = await world();
    const linkId = await setupLink(w);
    const liveIdp = await createTestIdp({ alg: "rsa" });
    const draftIdp = await createTestIdp({ alg: "rsa", entityId: "https://draft-idp.example" });
    const live = await samlConnection(w, w.org, liveIdp);
    const draft = await samlConnection(w, w.org, draftIdp, { enabled: false });
    await markDraft(w, draft, linkId);
    const before = await rowCounts(w);
    // The draft has no start, so a caller holds only the RelayState and the cookie of another start.
    const start = await samlStart(w, live);
    const xml = await draftIdp.response(responseFor(w, draft, start));
    const answer = await postResponse(w, draft, start, xml);
    expect([answer.res.status, answer.error, answer.token]).toEqual([302, "sso_failed", null]);
    expect(await rowCounts(w)).toEqual(before);
  });

  it("ACS to a connection that is off after its start: sso_not_configured, and no rows", async () => {
    const w = await world();
    const idp = await createTestIdp({ alg: "rsa" });
    const id = await samlConnection(w, w.org, idp);
    const start = await samlStart(w, id);
    const off = await updateConnection(w.config, SSO_APP, { id, enabled: false });
    expect(off.ok ? off.value.enabled : off.code).toBe(false);
    const before = await rowCounts(w);
    const xml = await idp.response(responseFor(w, id, start));
    const answer = await postResponse(w, id, start, xml);
    expect([answer.res.status, answer.error, answer.token]).toEqual([
      302,
      "sso_not_configured",
      null,
    ]);
    expect(await rowCounts(w)).toEqual(before);
  });

  it("enforce: a domain of a link stays off, and no setup route sets it", async () => {
    // A domain cannot route to a draft, so the reachable row routes, then turns the connection off.
    const w = await world();
    const linkId = await setupLink(w);
    await w.storage.update("ssoDomain", [{ field: "id", op: "eq", value: w.domainId }], {
      setupLinkId: linkId,
    });
    const id = await oidcConnection(w, true);
    await route(w, id);
    const off = await updateConnection(w.config, SSO_APP, { id, enabled: false });
    expect(off.ok ? off.value.enabled : off.code).toBe(false);
    const refused = await updateDomain(w.config, SSO_APP, { id: w.domainId, enforce: true });
    expect(refused.ok ? null : [refused.code, refused.status]).toEqual(["invalid_body", 400]);
    const row = await w.storage.findOne("ssoDomain", [
      { field: "id", op: "eq", value: w.domainId },
    ]);
    expect([row?.enforce, row?.setupLinkId]).toEqual([false, linkId]);
    expect(await ssoRequiredFor(w.config, "ada@acme.example")).toBeNull();
    expect(await enforcedAnswer(w.config, "ada@acme.example")).toBeNull();
    // The bodies of the setup routes have no key for `enforce` or `enabled`.
    expect(setupDomainAddBody.safeParse({ domain: "acme.example", enforce: true }).success).toBe(
      false,
    );
    expect(
      setupConnectionBody.safeParse({ kind: "oidc", label: "Acme", enabled: true }).success,
    ).toBe(false);
  });

  it("list shows drafts: the draft has draft true, and the flag is in the type", async () => {
    const w = await world();
    const live = await oidcConnection(w, true);
    w.clock.advance(1000);
    const draft = await oidcDraft(w);
    const [status, body] = await send(w, "GET", `/sso/connections?organizationId=${w.org}`);
    const listed = body.connections as SsoConnectionSummary[];
    expect([status, listed.map((c) => [c.id, c.enabled, c.draft])]).toEqual([
      200,
      [
        [live, true, false],
        [draft.id, false, true],
      ],
    ]);
    expectTypeOf<SsoConnectionSummary["draft"]>().toEqualTypeOf<boolean>();
  });

  it("manager enables a draft: 409 setup_not_tested, and the row stays a draft", async () => {
    const w = await world();
    const draft = await oidcDraft(w);
    const audits = async () =>
      (await w.storage.findMany("operatorAudit", [])).filter(
        (r) => r.action === "sso_connection_update",
      ).length;
    const [status, body] = await send(
      w,
      "POST",
      `/sso/connections/update?id=${encodeURIComponent(draft.id)}`,
      { enabled: true },
    );
    expect([status, body]).toEqual([409, { error: "setup_not_tested" }]);
    const app = await updateConnection(w.config, SSO_APP, { id: draft.id, enabled: true });
    expect(app.ok ? null : [app.code, app.status]).toEqual(["setup_not_tested", 409]);
    const row = await w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: draft.id },
    ]);
    expect([row?.enabled, row?.draft, row?.setupLinkId]).toEqual([false, true, draft.linkId]);
    expect(await audits()).toBe(0);
    // A connection that the manager made, off then on again, is no draft and still turns on.
    const own = await oidcConnection(w, false, "Acme own");
    const on = await updateConnection(w.config, SSO_APP, { id: own, enabled: true });
    expect(on.ok ? on.value.enabled : on.code).toBe(true);
  });

  it("manager changes a draft: version is 2, and a row that is no draft keeps version 1", async () => {
    const w = await world();
    const draft = await oidcDraft(w);
    const own = await oidcConnection(w, false, "Acme own");
    const version = async (id: string) =>
      (await w.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: id }]))?.version;
    expect([await version(draft.id), await version(own)]).toEqual([1, 1]);
    const [status] = await send(
      w,
      "POST",
      `/sso/connections/update?id=${encodeURIComponent(draft.id)}`,
      { label: "Acme draft 2" },
    );
    expect(status).toBe(200);
    const changed = await updateConnection(w.config, SSO_APP, { id: own, label: "Acme own 2" });
    expect(changed.ok ? changed.value.label : changed.code).toBe("Acme own 2");
    expect([await version(draft.id), await version(own)]).toEqual([2, 1]);
  });

  it("pending token: the list marks it, and it holds a live slot", async () => {
    const w = await world();
    const linkId = await setupLink(w);
    const made = await scimToken(w);
    await w.storage.update("scimToken", [{ field: "id", op: "eq", value: made.id }], {
      pending: true,
      setupLinkId: linkId,
    });
    // The list sorts by id, and two ids of one millisecond sort at random.
    w.clock.advance(1000);
    const live = await scimToken(w);
    const [status, body] = await send(w, "GET", `/scim/tokens?organizationId=${w.org}`);
    const tokens = body.tokens as ScimTokenSummary[];
    expect([status, tokens.map((t) => [t.id, t.pending])]).toEqual([
      200,
      [
        [made.id, true],
        [live.id, false],
      ],
    ]);
    expectTypeOf<ScimTokenSummary["pending"]>().toEqualTypeOf<boolean>();
    // SCIM_TOKENS_LIVE_MAX is 2: the pending token and the live token fill it.
    const third = await createScimToken(w.config, SCIM_APP, { organizationId: w.org, name: "c" });
    expect(third.ok ? null : [third.code, third.status]).toEqual(["token_limit", 409]);
  });
});
