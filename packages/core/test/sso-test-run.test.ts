import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteOrganization } from "../src/engine/organizations.js";
import { createConnection } from "../src/engine/sso/connections.js";
import { saveDraftConnection } from "../src/engine/sso/setup-drafts.js";
import { createSetupLink, revokeSetupLink } from "../src/engine/sso/setup-links.js";
import { openSetupSession, requireSetupSession } from "../src/engine/sso/setup-session.js";
import { stepHelp } from "../src/engine/sso/step-help.js";
import { SSO_FAILED_STEPS } from "../src/engine/sso/steps.js";
import { lastPassedRun, testRunResult } from "../src/engine/sso/test-run.js";
import type { AuthEvent } from "../src/observe/port.js";
import { parseXml } from "../src/saml/xml.js";
import { schema } from "../src/schema.js";
import { attrOf, createTestIdp } from "../src/testing/saml-idp.js";
import { get, recordCredential } from "./helpers.js";
import { scimAuth } from "./scim/helpers.js";
import { type FakeIdToken, fakeFetch, fakeJwt } from "./social-helpers.js";
import { SSO_APP, seedOrganization } from "./sso/helpers.js";
import { inflateRequest, postResponse, responseFor, rowCounts } from "./sso/saml-helpers.js";
import { endpointsOf, issuerOf } from "./sso/sign-in-helpers.js";

const META = { ip: "198.51.100.9", userAgent: "test-run-test" };
const SECRET = "idp-client-secret-0123456789";
const ADA = "ada@acme.example";
const BIND = "__Secure-tempo_session_oauth";

beforeEach(() => {
  // A refused step writes one log line; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The world of `scimAuth` with SSO setup, OIDC with a fake IdP, SAML, and a sink of the events. */
async function world() {
  const tokens: Record<string, FakeIdToken> = {};
  const idp = fakeFetch((call) =>
    Response.json({ id_token: call.form.code, token_type: "Bearer" }),
  );
  const batches: AuthEvent[][] = [];
  const w = await scimAuth({
    sso: { oidc: true, saml: true, setup: {}, fetch: idp.fetchFn },
    jwt: fakeJwt(tokens),
    observe: { sink: { write: (b) => void batches.push([...b]) } },
  });
  const events = async () => {
    await w.config.observe.flush();
    return batches.flat();
  };
  return { ...w, tokens, events };
}
type W = Awaited<ReturnType<typeof world>>;

/** A setup session of an organization through the real link, open, and check of the cookie. */
async function setup(w: W, organizationId: string = w.org) {
  const made = await createSetupLink(w.config, SSO_APP, {
    organizationId,
    steps: ["domain", "connection", "directory"],
    kinds: ["oidc", "saml"],
    note: "Ada at Acme IT",
  });
  if (!made.ok) throw new Error(made.code);
  recordCredential(made.value.token);
  const opened = await openSetupSession(w.config, made.value.token, META);
  if (!opened.ok) throw new Error(opened.code);
  const cookie = opened.value.cookie.split(";")[0] ?? "";
  const checked = await requireSetupSession(
    w.config,
    new Request("https://auth.example/auth/sso/setup/status", { headers: { cookie } }),
  );
  if (!checked.ok) throw new Error(checked.code);
  return { ...checked.value, cookie, linkId: made.value.id };
}
type S = Awaited<ReturnType<typeof setup>>;

const OIDC = {
  kind: "oidc",
  label: "Acme Okta",
  issuer: issuerOf("acme"),
  clientId: "acme-client",
  clientSecret: SECRET,
  endpoints: endpointsOf("acme"),
} as const;

async function oidcDraft(w: W, s: S): Promise<string> {
  const r = await saveDraftConnection(w.config, s, OIDC);
  if (!r.ok) throw new Error(r.code);
  return r.value.id;
}

async function samlDraft(w: W, s: S, cert: string, entityId: string): Promise<string> {
  const r = await saveDraftConnection(w.config, s, {
    kind: "saml",
    label: "Acme SAML",
    idpEntityId: entityId,
    ssoUrl: "https://idp.example/sso",
    certificates: [cert],
  });
  if (!r.ok) throw new Error(r.code);
  return r.value.id;
}

const startTest = (w: W, id: string, headers: Record<string, string>) =>
  w.handle(get(`/auth/sso/${id}/start?test=1`, headers));

function bindOf(res: Response): string {
  const c = res.headers.getSetCookie().find((x) => x.startsWith(`${BIND}=`));
  return c?.split(";")[0]?.split("=")[1] ?? "";
}

let codes = 0;
/** The callback of an OIDC start. `claims` null: the IdP's token is not known to the jwt seam. */
async function oidcCallback(
  w: W,
  id: string,
  started: Response,
  claims: Record<string, unknown> | null,
  nonce?: string,
) {
  const url = new URL(started.headers.get("location") ?? "");
  const code = `tcode-${++codes}`;
  if (claims)
    w.tokens[code] = {
      audience: "acme-client",
      issuer: issuerOf("acme"),
      claims: { ...claims, nonce: nonce ?? url.searchParams.get("nonce") ?? "" },
    };
  const q = new URLSearchParams({ code, state: url.searchParams.get("state") ?? "" });
  return w.handle(get(`/auth/sso/${id}/callback?${q}`, { cookie: `${BIND}=${bindOf(started)}` }));
}

/** The start of a SAML test run through the route. */
async function samlTestStart(w: W, id: string, cookie: string) {
  const res = await startTest(w, id, { cookie });
  if (res.status !== 302) throw new Error(`the start answered ${res.status}`);
  const location = new URL(res.headers.get("location") ?? "");
  const request = await inflateRequest(location.searchParams.get("SAMLRequest") ?? "");
  const parsed = parseXml(request);
  if (!parsed.ok) throw new Error("the AuthnRequest does not parse");
  return {
    location,
    request,
    requestId: attrOf(parsed.root, "ID") ?? "",
    relayState: location.searchParams.get("RelayState") ?? "",
    bind: bindOf(res),
  };
}

const runs = (w: W) => w.storage.findMany("ssoTestRun", []);
const only = async (w: W) => {
  const all = await runs(w);
  if (all.length !== 1 || !all[0]) throw new Error(`${all.length} runs`);
  return all[0];
};

/** The count of rows of each model. */
async function tables(w: W): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(schema))
    out[name] = (await w.storage.findMany(name as keyof typeof schema, [])).length;
  return out;
}
const changed = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).filter((k) => a[k] !== b[k]);

/** A whole OIDC test run of Ada: the start and the callback. */
async function oidcPass(w: W, s: S, claims: Record<string, unknown> = {}) {
  const id = await oidcDraft(w, s);
  const started = await startTest(w, id, { cookie: s.cookie });
  const res = await oidcCallback(w, id, started, {
    sub: "a-1",
    email: ADA,
    name: "Ada",
    ...claims,
  });
  return { id, started, res };
}

describe("the start of a test run", () => {
  it("redirects a setup session to the IdP and writes one pending run", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const res = await startTest(w, id, { cookie: s.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/login\.acme-idp\.example\/authorize\?/);
    expect(bindOf(res)).not.toBe("");
    const run = await only(w);
    expect(run).toMatchObject({
      outcome: "pending",
      step: null,
      linkId: s.linkId,
      organizationId: w.org,
      connectionId: id,
      draftVersion: 1,
      attributeNames: [],
      domainClaimed: false,
    });
    const audit = await w.storage.findMany("operatorAudit", [
      { field: "action", op: "eq", value: "sso_test_run" },
    ]);
    expect(audit).toHaveLength(1);
  });

  it("answers 404 for no cookie and no manager, and writes nothing", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const before = await tables(w);
    const res = await startTest(w, id, {});
    expect(res.status).toBe(404);
    expect(await tables(w)).toEqual(before);
  });

  it("refuses a cross-site or same-site GET with the cookie, and writes nothing (hand-off b)", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const before = await tables(w);
    for (const site of ["cross-site", "same-site"]) {
      const res = await startTest(w, id, { cookie: s.cookie, "sec-fetch-site": site });
      expect(res.status).toBe(404);
    }
    expect(await tables(w)).toEqual(before);
    const ok = await startTest(w, id, { cookie: s.cookie, "sec-fetch-site": "same-origin" });
    expect(ok.status).toBe(302);
  });

  it("refuses the session of another organization and a connection that is no draft of the link", async () => {
    const w = await world();
    const other = await seedOrganization(w, "beta");
    const mine = await setup(w);
    const theirs = await setup(w, other);
    const id = await oidcDraft(w, mine);
    const live = await createConnection(w.config, SSO_APP, {
      organizationId: w.org,
      ...OIDC,
      label: "Live",
    });
    if (!live.ok) throw new Error(live.code);
    const before = await tables(w);
    expect((await startTest(w, id, { cookie: theirs.cookie })).status).toBe(404);
    expect((await startTest(w, live.value.id, { cookie: mine.cookie })).status).toBe(404);
    expect(await tables(w)).toEqual(before);
  });

  it("refuses a revoked link and an expired link", async () => {
    const w = await world();
    const a = await setup(w);
    const b = await setup(w);
    const id = await oidcDraft(w, a);
    const revoked = await revokeSetupLink(w.config, SSO_APP, a.linkId);
    expect(revoked.ok).toBe(true);
    const before = await tables(w);
    expect((await startTest(w, id, { cookie: a.cookie })).status).toBe(404);
    w.clock.advance(9 * 3_600_000);
    expect((await startTest(w, id, { cookie: b.cookie })).status).toBe(404);
    expect(await tables(w)).toEqual(before);
  });

  it("lets a manager start a test of a connection of the organization", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const res = await startTest(w, id, { cookie: `__Host-tempo_session=${w.owner.token}` });
    expect(res.status).toBe(302);
    expect((await only(w)).linkId).toBeNull();
  });

  it("ends the pending run of the connection when another starts", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    await startTest(w, id, { cookie: s.cookie });
    await startTest(w, id, { cookie: s.cookie });
    const all = await runs(w);
    expect(all.map((r) => r.outcome).sort()).toEqual(["failed", "pending"]);
    const ended = all.find((r) => r.outcome === "failed");
    expect(SSO_FAILED_STEPS).toContain(ended?.step);
  });
});

describe("the result of a test run", () => {
  it("passes with the attribute names, no values, and no user (cases pass, user count)", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const started = await startTest(w, id, { cookie: s.cookie });
    const before = await tables(w);
    const mailBefore = w.mail.length;
    const eventsBefore = (await w.events()).length;
    const res = await oidcCallback(w, id, started, { sub: "a-1", email: ADA, name: "Ada" });
    const run = await only(w);
    // Hand-off (c): the cross-site return answers 303 to the status route by run id.
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.pathname).toBe("/auth/sso/setup/status");
    expect(loc.searchParams.get("run")).toBe(run.id);
    expect(res.headers.getSetCookie().join("\n")).not.toContain("__Host-tempo_session=");
    expect(run).toMatchObject({ outcome: "passed", step: null, domainClaimed: true });
    expect(run.attributeNames).toEqual(expect.arrayContaining(["sub", "email", "name"]));
    // No value of the IdP in any column of the run row.
    expect(JSON.stringify(run)).not.toContain(ADA);
    expect(JSON.stringify(run)).not.toContain("Ada");
    // Hand-off (d): the run stops before the sign-in resolution. Only these models change.
    const after = await tables(w);
    // The callback adds one result row to `verification` and changes no other count.
    expect(changed(before, after)).toEqual(["verification"]);
    expect(after.user).toBe(before.user);
    expect(after.identity).toBe(before.identity);
    expect(after.session).toBe(before.session);
    expect(after.member).toBe(before.member);
    expect(after.scimUser).toBe(before.scimUser);
    const sign = (await w.events())
      .slice(eventsBefore)
      .filter((e) => e.name === "sign_in");
    expect(sign).toEqual([]);
    // Hand-off (e): the run is no user notice.
    expect(w.mail.length).toBe(mailBefore);
  });

  it("gives domainClaimed false for an address in no verified domain", async () => {
    const w = await world();
    const s = await setup(w);
    const { res } = await oidcPass(w, s, { email: "ada@elsewhere.example" });
    expect(res.status).toBe(303);
    expect(await only(w)).toMatchObject({ outcome: "passed", domainClaimed: false });
  });

  it("fails with a closed step and shows the help line of the step", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const started = await startTest(w, id, { cookie: s.cookie });
    const res = await oidcCallback(w, id, started, null);
    expect(res.status).toBe(303);
    const run = await only(w);
    expect(run.outcome).toBe("failed");
    expect(run.step).toBe("id_token");
    expect(SSO_FAILED_STEPS).toContain(run.step);
    const shown = await testRunResult(w.config, s, run.id);
    if (!shown.ok) throw new Error(shown.code);
    expect(shown.value.help).toBe(stepHelp("id_token"));
    expect(shown.value.help.length).toBeGreaterThan(10);
    expect(await w.storage.findMany("user", [{ field: "email", op: "eq", value: ADA }])).toEqual(
      [],
    );
  });

  it("fails a SAML Response with a bad signature at a named step", async () => {
    const w = await world();
    const s = await setup(w);
    const idp = await createTestIdp({ alg: "rsa" });
    const rogue = await createTestIdp({ alg: "rsa" });
    const id = await samlDraft(w, s, idp.certificatePem, idp.entityId);
    const start = await samlTestStart(w, id, s.cookie);
    const xml = await rogue.response(responseFor(w, id, start));
    const answer = await postResponse(w, id, start, xml);
    expect(answer.res.status).toBe(303);
    const run = await only(w);
    expect(run.outcome).toBe("failed");
    expect(SSO_FAILED_STEPS).toContain(run.step);
    expect(run.step).not.toBe("request");
  });

  it("passes a SAML Response with attribute names and no user", async () => {
    const w = await world();
    const s = await setup(w);
    const idp = await createTestIdp({ alg: "rsa" });
    const id = await samlDraft(w, s, idp.certificatePem, idp.entityId);
    const start = await samlTestStart(w, id, s.cookie);
    const before = await rowCounts(w);
    const xml = await idp.response(responseFor(w, id, start));
    const answer = await postResponse(w, id, start, xml);
    expect(answer.res.status).toBe(303);
    expect(new URL(answer.res.headers.get("location") ?? "").pathname).toBe(
      "/auth/sso/setup/status",
    );
    expect(await rowCounts(w)).toEqual(before);
    const run = await only(w);
    expect(run).toMatchObject({ outcome: "passed", step: null, domainClaimed: true });
    expect(run.attributeNames).toContain("email");
    expect(JSON.stringify(run)).not.toContain(ADA);
  });

  it("shows the address and name to the run's own session only", async () => {
    const w = await world();
    const s = await setup(w);
    const { res } = await oidcPass(w, s);
    const run = await only(w);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("run")).toBe(run.id);
    const shown = await testRunResult(w.config, s, run.id);
    if (!shown.ok) throw new Error(shown.code);
    expect(shown.value).toMatchObject({ address: ADA, name: "Ada" });
    expect(shown.value.run.id).toBe(run.id);
    const second = await setup(w);
    expect(await testRunResult(w.config, second, run.id)).toMatchObject({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });

  it("keeps a wrong state and a replayed callback from changing the run", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const started = await startTest(w, id, { cookie: s.cookie });
    const bogus = `os_${"A".repeat(43)}`;
    const bad = await w.handle(
      get(`/auth/sso/${id}/callback?code=x&state=${bogus}`, {
        cookie: `${BIND}=${bindOf(started)}`,
      }),
    );
    expect(bad.status).toBe(302);
    expect((await only(w)).outcome).toBe("pending");
    await oidcCallback(w, id, started, { sub: "a-1", email: ADA });
    expect((await only(w)).outcome).toBe("passed");
    const again = await oidcCallback(w, id, started, { sub: "a-1", email: ADA });
    expect(again.status).toBe(302);
    expect(new URL(again.headers.get("location") ?? "").searchParams.get("auth_error")).toBe(
      "sso_failed",
    );
    expect(await only(w)).toMatchObject({ outcome: "passed", step: null });
  });

  it("does not fail the run of a person who holds no binding cookie", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const started = await startTest(w, id, { cookie: s.cookie });
    const url = new URL(started.headers.get("location") ?? "");
    const q = new URLSearchParams({ code: "x", state: url.searchParams.get("state") ?? "" });
    await w.handle(get(`/auth/sso/${id}/callback?${q}`));
    expect((await only(w)).outcome).toBe("pending");
  });
});

describe("the checks are the checks of the real sign-in", () => {
  it("refuses a wrong nonce in the test run and in the real flow (OIDC)", async () => {
    const w = await world();
    const s = await setup(w);
    const draft = await oidcDraft(w, s);
    const started = await startTest(w, draft, { cookie: s.cookie });
    await oidcCallback(w, draft, started, { sub: "a-1", email: ADA }, "wrong-nonce");
    expect(await only(w)).toMatchObject({ outcome: "failed", step: "nonce" });
    const live = await createConnection(w.config, SSO_APP, {
      organizationId: w.org,
      ...OIDC,
      label: "Live",
    });
    if (!live.ok) throw new Error(live.code);
    const users = (await w.storage.findMany("user", [])).length;
    const real = await w.handle(get(`/auth/sso/${live.value.id}/start?next=/home`));
    const res = await oidcCallback(
      w,
      live.value.id,
      real,
      { sub: "a-1", email: ADA },
      "wrong-nonce",
    );
    expect(
      new URL(res.headers.get("location") ?? "", "https://x.invalid").searchParams.get(
        "auth_error",
      ),
    ).toBe("sso_failed");
    expect((await w.storage.findMany("user", [])).length).toBe(users);
  });

  it("refuses a wrong signature in the test run and in the real flow (SAML)", async () => {
    const w = await world();
    const s = await setup(w);
    const idp = await createTestIdp({ alg: "rsa" });
    const rogue = await createTestIdp({ alg: "rsa" });
    const draft = await samlDraft(w, s, idp.certificatePem, idp.entityId);
    const start = await samlTestStart(w, draft, s.cookie);
    await postResponse(w, draft, start, await rogue.response(responseFor(w, draft, start)));
    const run = await only(w);
    expect(run.outcome).toBe("failed");
    const live = await createConnection(w.config, SSO_APP, {
      organizationId: w.org,
      kind: "saml",
      label: "Live SAML",
      idpEntityId: idp.entityId,
      ssoUrl: "https://idp.example/sso",
      certificates: [idp.certificatePem],
    });
    if (!live.ok) throw new Error(live.code);
    const res = await w.handle(get(`/auth/sso/${live.value.id}/start?next=/home`));
    const loc = new URL(res.headers.get("location") ?? "");
    const request = await inflateRequest(loc.searchParams.get("SAMLRequest") ?? "");
    const parsed = parseXml(request);
    if (!parsed.ok) throw new Error("parse");
    const real = {
      requestId: attrOf(parsed.root, "ID") ?? "",
      relayState: loc.searchParams.get("RelayState") ?? "",
      bind: bindOf(res),
    };
    const before = await rowCounts(w);
    const answer = await postResponse(
      w,
      live.value.id,
      real,
      await rogue.response(responseFor(w, live.value.id, real)),
    );
    expect(answer.error).toBe("sso_failed");
    expect(await rowCounts(w)).toEqual(before);
  });

  it("refuses an ACS to a connection that is off, with no user (hand-off a, saml-sp line 285)", async () => {
    const w = await world();
    const idp = await createTestIdp({ alg: "rsa" });
    const live = await createConnection(w.config, SSO_APP, {
      organizationId: w.org,
      kind: "saml",
      label: "Live SAML",
      idpEntityId: idp.entityId,
      ssoUrl: "https://idp.example/sso",
      certificates: [idp.certificatePem],
    });
    if (!live.ok) throw new Error(live.code);
    const res = await w.handle(get(`/auth/sso/${live.value.id}/start?next=/home`));
    const loc = new URL(res.headers.get("location") ?? "");
    const request = await inflateRequest(loc.searchParams.get("SAMLRequest") ?? "");
    const parsed = parseXml(request);
    if (!parsed.ok) throw new Error("parse");
    const start = {
      requestId: attrOf(parsed.root, "ID") ?? "",
      relayState: loc.searchParams.get("RelayState") ?? "",
      bind: bindOf(res),
    };
    const xml = await idp.response(responseFor(w, live.value.id, start));
    await w.storage.update("ssoConnection", [{ field: "id", op: "eq", value: live.value.id }], {
      enabled: false,
    });
    const before = await rowCounts(w);
    const answer = await postResponse(w, live.value.id, start, xml);
    expect(answer.error).toBe("sso_not_configured");
    expect(answer.token).toBeNull();
    expect(await rowCounts(w)).toEqual(before);
  });
});

describe("the draft version and the organization delete", () => {
  it("binds a pass to the version of the draft (hand-off f)", async () => {
    const w = await world();
    const s = await setup(w);
    const { id } = await oidcPass(w, s);
    const first = await lastPassedRun(w.config, id, 1);
    expect(first).toMatchObject({ outcome: "passed", draftVersion: 1 });
    const changedDraft = await saveDraftConnection(w.config, s, { ...OIDC, label: "Acme Okta 2" });
    if (!changedDraft.ok) throw new Error(changedDraft.code);
    expect(await lastPassedRun(w.config, id, 2)).toBeNull();
    expect(await lastPassedRun(w.config, id, 1)).not.toBeNull();
  });

  it("removes the runs with the organization (ruling R6)", async () => {
    const w = await world();
    const s = await setup(w);
    await oidcPass(w, s);
    expect(await runs(w)).toHaveLength(1);
    const gone = await deleteOrganization(w.config, { user: w.owner.user, organizationId: w.org });
    expect(gone).toEqual({ ok: true, value: { ok: true } });
    expect(await runs(w)).toEqual([]);
  });
});
