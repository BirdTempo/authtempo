import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoConfig } from "../src/config.js";
import { addMember, createOrganization } from "../src/engine/organizations.js";
import { createSession } from "../src/engine/sessions.js";
import { createSetupLink } from "../src/engine/sso/setup-links.js";
import { SSO_FAILED_STEPS } from "../src/engine/sso/steps.js";
import { ROUTES, type RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { SETUP_SESSION_ROUTES } from "../src/http/routes/sso-setup.js";
import type { AuthEvent } from "../src/observe/port.js";
import { SETUP_SESSION_COOKIE } from "../src/primitives/credentials.js";
import { newId } from "../src/primitives/ids.js";
import { parseXml } from "../src/saml/xml.js";
import { schema } from "../src/schema.js";
import { attrOf, createTestIdp } from "../src/testing/saml-idp.js";
import { BASE, everyFeature } from "./every-feature.js";
import { recordCredential } from "./helpers.js";
import { scimAuth } from "./scim/helpers.js";
import { fakeFetch, fakeJwt } from "./social-helpers.js";
import { SSO_APP } from "./sso/helpers.js";
import { managerSession } from "./sso/manager-helpers.js";
import {
  inflateRequest,
  postAcs,
  postResponse,
  responseFor,
  samlConnection,
} from "./sso/saml-helpers.js";
import { verifiedSession } from "./totp-helpers.js";

/**
 * The adversarial proofs of plan 13a Task 14. A thief holds a live setup link. The proofs run
 * through the routes: what the thief can do, what the owner sees, and what leaks.
 */

const CLIENT = { "cf-connecting-ip": "198.51.100.7", "user-agent": "adversarial/1" };
const THIEF_IP = "203.0.113.66";
const BIND = "__Secure-tempo_session_oauth";
const ADA = "ada@acme.example";
const NONE = { status: 401, error: "unauthorized" };

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** One answer of a route: status, parsed body, and the text of the body and of the Location. */
interface Seen {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headerText: string;
  headers: Headers;
}

/** The world of the scene: SCIM auth, SAML, setup on, a sink of the events, and a second owner. */
async function scene() {
  const idp = fakeFetch(() => Response.json({}));
  const batches: AuthEvent[][] = [];
  const w = await scimAuth({
    sso: { oidc: true, saml: true, setup: {}, fetch: idp.fetchFn } as SsoConfig,
    jwt: fakeJwt({}),
    observe: { sink: { write: (b) => void batches.push([...b]) } },
  });
  const second = await verifiedSession(w, "second@acme.example");
  const added = await addMember(w.config, {
    user: w.owner.user,
    organizationId: w.org,
    userId: second.user.id,
    role: "owner",
  });
  if (!added.ok) throw new Error(added.code);
  const answers: Seen[] = [];
  /** One call through the routes. `cookie` and `bearer` are the credential forms. */
  async function call(
    method: "GET" | "POST",
    path: string,
    opts: { cookie?: string; bearer?: string; body?: unknown; ip?: string; headers?: Headers } = {},
  ): Promise<Seen> {
    const headers: Record<string, string> = {
      ...CLIENT,
      ...(opts.ip ? { "cf-connecting-ip": opts.ip } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    };
    const request =
      method === "GET"
        ? new Request(`${BASE}/auth${path}`, { headers })
        : new Request(`${BASE}/auth${path}`, {
            method,
            headers: { ...headers, "content-type": "application/json", origin: BASE },
            body: JSON.stringify(opts.body ?? {}),
          });
    const res = await w.handle(request);
    const text = await res.text();
    const seen: Seen = {
      status: res.status,
      body: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : {},
      text: `${text}\n${res.headers.get("location") ?? ""}`,
      // Every header but Set-Cookie, which carries the session of the open on purpose.
      headerText: [...res.headers].filter(([k]) => k !== "set-cookie").join("\n"),
      headers: res.headers,
    };
    answers.push(seen);
    return seen;
  }
  const events = async () => {
    await w.config.observe.flush();
    return batches.flat();
  };
  const manager = `__Host-tempo_session=${w.owner.token}`;
  return { w, call, answers, events, manager, second, org: w.org };
}
type Scene = Awaited<ReturnType<typeof scene>>;

/** The count of rows of each model. */
async function tables(w: Scene["w"]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(schema))
    out[name] = (await w.storage.findMany(name as keyof typeof schema, [])).length;
  return out;
}

/** The SHA-256 of the DER of a PEM, in lower case hex, by a path of its own. */
async function printOf(pem: string): Promise<string> {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The stolen link of the owner, opened by the thief from another address. */
async function stolen(x: Scene, steps: string[] = ["domain", "connection"]) {
  const minted = await x.call("POST", `/sso/setup-links/create?organizationId=${x.org}`, {
    cookie: x.manager,
    body: { steps, kinds: ["saml"], note: "Ada at Acme IT" },
  });
  expect(minted.status).toBe(200);
  const token = String(minted.body.token);
  const linkId = String(minted.body.id);
  recordCredential(token);
  const opened = await x.call("POST", "/sso/setup/open", { body: { token }, ip: THIEF_IP });
  expect(opened.status).toBe(200);
  const pair = (opened.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  recordCredential(pair.split("=")[1] ?? "");
  return { token, linkId, cookie: pair, session: pair.split("=")[1] ?? "" };
}

/** The thief's draft with its own IdP, and a passed test run for Ada. */
async function thiefDraft(x: Scene, cookie: string) {
  const idp = await createTestIdp({ alg: "rsa" });
  const saved = await x.call("POST", "/sso/setup/connection", {
    cookie,
    ip: THIEF_IP,
    body: {
      kind: "saml",
      label: "Thief SAML",
      idpEntityId: idp.entityId,
      ssoUrl: "https://thief-idp.example/sso",
      certificates: [idp.certificatePem],
    },
  });
  expect(saved.status).toBe(200);
  const id = String((saved.body.connection as { id: string }).id);
  const started = await x.w.handle(
    new Request(`${BASE}/auth/sso/${id}/start?test=1`, { headers: { ...CLIENT, cookie } }),
  );
  expect(started.status).toBe(302);
  const location = new URL(started.headers.get("location") ?? "");
  const parsed = parseXml(await inflateRequest(location.searchParams.get("SAMLRequest") ?? ""));
  if (!parsed.ok) throw new Error("no AuthnRequest");
  const start = {
    requestId: attrOf(parsed.root, "ID") ?? "",
    relayState: location.searchParams.get("RelayState") ?? "",
    bind:
      started.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${BIND}=`))
        ?.split(";")[0]
        ?.split("=")[1] ?? "",
  };
  const xml = await idp.response(responseFor(x.w, id, start));
  const back = await postResponse(x.w, id, start, xml);
  expect(back.res.status).toBe(303);
  return { id, idp, start, xml };
}

describe("a stolen setup link (plan 13a Task 14, rows 1 and 2)", () => {
  it("lets the thief draft and test, but not activate, and signs in no domain user", async () => {
    const x = await scene();
    const s = await stolen(x);
    const before = await tables(x.w);
    const draft = await thiefDraft(x, s.cookie);
    const runs = await x.w.storage.findMany("ssoTestRun", []);
    expect(runs).toMatchObject([{ outcome: "passed", domainClaimed: true }]);
    // The test run opened no user and no session.
    const after = await tables(x.w);
    expect({ users: after.user, sessions: after.session, members: after.member }).toEqual({
      users: before.user,
      sessions: before.session,
      members: before.member,
    });

    // The link holds the steps domain and connection, and the kind saml. Nothing else passes.
    const held = await tables(x.w);
    const scimToken = await x.call("POST", "/sso/setup/scim-token", {
      cookie: s.cookie,
      ip: THIEF_IP,
    });
    expect([scimToken.status, scimToken.body.error]).toEqual([NONE.status, NONE.error]);
    const wrongKind = await x.call("POST", "/sso/setup/connection", {
      cookie: s.cookie,
      ip: THIEF_IP,
      body: {
        kind: "oidc",
        label: "Thief OIDC",
        issuer: "https://thief-idp.example/",
        clientId: "c",
        clientSecret: "thief-secret-0123456789",
      },
    });
    expect(wrongKind.status).toBe(400);
    const owned = await x.call("POST", "/sso/setup/connection", {
      cookie: s.cookie,
      ip: THIEF_IP,
      body: {
        kind: "saml",
        label: "Thief SAML",
        idpEntityId: draft.idp.entityId,
        ssoUrl: "https://thief-idp.example/sso",
        certificates: [draft.idp.certificatePem],
        enabled: true,
      },
    });
    expect(owned.status).toBe(400);
    // A domain of the manager is no row of the link: the thief cannot verify or add it again.
    const verify = await x.call("POST", "/sso/setup/domains/verify", {
      cookie: s.cookie,
      ip: THIEF_IP,
      body: { id: x.w.domainId },
    });
    expect(verify.status).toBeGreaterThanOrEqual(400);
    const add = await x.call("POST", "/sso/setup/domains/add", {
      cookie: s.cookie,
      ip: THIEF_IP,
      body: { domain: "acme.example" },
    });
    expect([add.status, add.body.error]).toEqual([409, "conflict"]);
    expect(await tables(x.w)).toEqual(held);
    const draftRow = await x.w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: draft.id },
    ]);
    expect(draftRow).toMatchObject({ draft: true, enabled: false });

    // The thief calls each way to turn the draft on: the setup cookie, and the link as a bearer.
    const rows = await tables(x.w);
    for (const credential of [{ cookie: s.cookie }, { bearer: s.token }, { bearer: s.session }]) {
      for (const [path, body] of [
        ["/sso/setup-links/activate", { id: s.linkId, version: 1 }],
        [`/sso/connections/update?id=${draft.id}`, { enabled: true }],
        ["/sso/domains/update", { id: x.w.domainId, enforce: true }],
        ["/sso/domains/update", { id: x.w.domainId, connectionId: draft.id }],
      ] as const) {
        const none = await x.call("POST", path, { body });
        const got = await x.call("POST", path, {
          ...credential,
          ip: THIEF_IP,
          body,
        });
        expect([got.status, got.body.error], path).toEqual([none.status, none.body.error]);
        expect(got.status, path).toBe(NONE.status);
      }
    }
    expect(await tables(x.w)).toEqual(rows);

    // No sign-in of a domain user reaches the draft.
    const start = await x.w.handle(
      new Request(`${BASE}/auth/sso/${draft.id}/start`, { headers: CLIENT }),
    );
    expect(new URL(start.headers.get("location") ?? "https://x.invalid/").host).not.toContain(
      "thief-idp.example",
    );
    expect(start.headers.getSetCookie().some((c) => c.startsWith("__Host-tempo_session="))).toBe(
      false,
    );
    // The signed Response of the test run, posted again, makes no session.
    const replay = await postAcs(
      x.w,
      draft.id,
      { SAMLResponse: btoa(draft.xml), RelayState: draft.start.relayState },
      draft.start.bind,
    );
    expect(replay.token).toBeNull();
    const discover = await x.call("POST", "/sso/discover", { body: { email: ADA } });
    expect(discover.body).toEqual({ sso: false });
    const end = await tables(x.w);
    expect({ users: end.user, sessions: end.session }).toEqual({
      users: before.user,
      sessions: before.session,
    });

    // Even the owner cannot route a domain to the draft by hand: only the activation does.
    const route = await x.call("POST", "/sso/domains/update", {
      cookie: x.manager,
      body: { id: x.w.domainId, connectionId: draft.id },
    });
    expect([route.status, route.body.error]).toEqual([404, "not_found"]);
    const domainRow = await x.w.storage.findOne("ssoDomain", [
      { field: "id", op: "eq", value: x.w.domainId },
    ]);
    expect(domainRow).toMatchObject({ connectionId: null, enforce: false });

    // The owner preview shows what the thief saved.
    const preview = await x.call("GET", `/sso/setup-links/get?id=${s.linkId}`, {
      cookie: x.manager,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({
      kind: "saml",
      issuerOrEntityId: draft.idp.entityId,
      signInHost: "thief-idp.example",
      fingerprints: [await printOf(draft.idp.certificatePem)],
    });
  });

  it("sends a notice to every owner when the owner activates the thief's draft", async () => {
    const x = await scene();
    const s = await stolen(x);
    await thiefDraft(x, s.cookie);
    expect(x.w.mail.filter((m) => m.subject.startsWith("SSO setup notice"))).toEqual([]);
    const done = await x.call("POST", "/sso/setup-links/activate", {
      cookie: x.manager,
      body: { id: s.linkId, version: 1 },
    });
    expect(done.status).toBe(200);
    const notices = x.w.mail.filter((m) => m.subject.startsWith("SSO setup notice"));
    expect(notices.map((m) => m.to).sort()).toEqual(
      ["owner@acme.example", "second@acme.example"].sort(),
    );
    for (const m of notices) expect(m.text).toContain("turned on");
    // The thief's session ends with the link.
    const status = await x.call("GET", "/sso/setup/status", { cookie: s.cookie, ip: THIEF_IP });
    expect([status.status, status.body.error]).toEqual([NONE.status, NONE.error]);
    // The rest of the risk is the doc line of Task 15 (docs).
  });

  it("answers 404 setup_link_invalid to a replay of the link after it ends", async () => {
    const x = await scene();
    const s = await stolen(x);
    await thiefDraft(x, s.cookie);
    expect(
      (
        await x.call("POST", "/sso/setup-links/activate", {
          cookie: x.manager,
          body: { id: s.linkId, version: 1 },
        })
      ).status,
    ).toBe(200);
    const again = await x.call("POST", "/sso/setup/open", {
      body: { token: s.token },
      ip: THIEF_IP,
    });
    expect([again.status, again.body.error]).toEqual([404, "setup_link_invalid"]);
    expect(again.headers.getSetCookie()).toEqual([]);
    // The owner's second activation of the ended link answers the same, and writes nothing.
    const rows = await tables(x.w);
    const twice = await x.call("POST", "/sso/setup-links/activate", {
      cookie: x.manager,
      body: { id: s.linkId, version: 1 },
    });
    expect([twice.status, twice.body.error]).toEqual([404, "setup_link_invalid"]);
    expect(await tables(x.w)).toEqual(rows);
  });

  it("sets the setup cookie with the host prefix, Path /, and no Domain", async () => {
    const x = await scene();
    const s = await stolen(x);
    const opened = await x.call("POST", "/sso/setup/open", { body: { token: s.token } });
    const cookie = opened.headers.getSetCookie()[0] ?? "";
    expect(cookie).toMatch(
      /^__Host-tempo_setup=ss_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(cookie.toLowerCase()).not.toContain("domain");
    expect(SETUP_SESSION_COOKIE).toBe("__Host-tempo_setup");
  });

  it("ends the first session of a link when the link opens again", async () => {
    const x = await scene();
    const s = await stolen(x);
    expect((await x.call("GET", "/sso/setup/status", { cookie: s.cookie })).status).toBe(200);
    const again = await x.call("POST", "/sso/setup/open", { body: { token: s.token } });
    expect(again.status).toBe(200);
    const second = (again.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    recordCredential(second.split("=")[1] ?? "");
    const old = await x.call("GET", "/sso/setup/status", { cookie: s.cookie });
    expect([old.status, old.body.error]).toEqual([NONE.status, NONE.error]);
    expect((await x.call("GET", "/sso/setup/status", { cookie: second })).status).toBe(200);
  });

  it("answers 401 to a session that is idle for 60 minutes, or past 8 hours of life", async () => {
    const x = await scene();
    const s = await stolen(x);
    x.w.clock.advance(61 * 60_000);
    const idle = await x.call("GET", "/sso/setup/status", { cookie: s.cookie });
    expect([idle.status, idle.body.error]).toEqual([NONE.status, NONE.error]);
    // A session in use stays live up to 8 hours, and no longer.
    const t = await stolen(x);
    for (let i = 0; i < 8; i += 1) {
      x.w.clock.advance(59 * 60_000);
      expect((await x.call("GET", "/sso/setup/status", { cookie: t.cookie })).status).toBe(200);
    }
    x.w.clock.advance(59 * 60_000);
    const old = await x.call("GET", "/sso/setup/status", { cookie: t.cookie });
    expect([old.status, old.body.error]).toEqual([NONE.status, NONE.error]);
  });

  it("answers 401 to a session of a link that the owner revokes", async () => {
    const x = await scene();
    const s = await stolen(x);
    expect((await x.call("GET", "/sso/setup/status", { cookie: s.cookie })).status).toBe(200);
    const revoked = await x.call("POST", "/sso/setup-links/revoke", {
      cookie: x.manager,
      body: { id: s.linkId },
    });
    expect(revoked.status).toBe(200);
    const after = await x.call("GET", "/sso/setup/status", { cookie: s.cookie });
    expect([after.status, after.body.error]).toEqual([NONE.status, NONE.error]);
    const open = await x.call("POST", "/sso/setup/open", { body: { token: s.token } });
    expect([open.status, open.body.error]).toEqual([404, "setup_link_invalid"]);
  });
});

describe("the activation of a thief's draft (plan 13a Task 14, rows 1 and 2)", () => {
  /** The activation of an owner who read the draft just before: it sends the draft version of now. */
  const activate = async (x: Scene, linkId: string, cookie = x.manager, version?: number) => {
    const draft = await x.w.storage.findOne("ssoConnection", [
      { field: "setupLinkId", op: "eq", value: linkId },
    ]);
    return x.call("POST", "/sso/setup-links/activate", {
      cookie,
      body: { id: linkId, version: version ?? draft?.version ?? 1 },
    });
  };

  it("answers 409 conflict when the thief changes and tests the draft again after the preview (R28)", async () => {
    const x = await scene();
    const s = await stolen(x);
    await thiefDraft(x, s.cookie);
    // The owner reads the preview of the draft.
    const preview = await x.call("GET", `/sso/setup-links/get?id=${s.linkId}`, {
      cookie: x.manager,
    });
    const seen = (preview.body.preview as { version: number }).version;
    expect(seen).toBe(1);
    // The link stays open: the thief saves another IdP under the same draft and passes its test.
    const swapped = await thiefDraft(x, s.cookie);
    const row = await x.w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: swapped.id },
    ]);
    expect(row?.version).toBe(2);
    const before = await tables(x.w);
    const refused = await activate(x, s.linkId, x.manager, seen);
    expect([refused.status, refused.body.error]).toEqual([409, "conflict"]);
    expect(await tables(x.w)).toEqual(before);
    expect(
      await x.w.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: swapped.id }]),
    ).toMatchObject({ draft: true, enabled: false });
    // The owner reads the new preview, and the activation then goes through.
    const again = await x.call("GET", `/sso/setup-links/get?id=${s.linkId}`, {
      cookie: x.manager,
    });
    expect((again.body.preview as { version: number }).version).toBe(2);
    expect((await activate(x, s.linkId, x.manager, 2)).status).toBe(200);
  });

  it("answers 409 setup_not_tested to a draft with no test, or with a test of an older draft", async () => {
    const x = await scene();
    const s = await stolen(x);
    const idp = await createTestIdp({ alg: "rsa" });
    const body = (certificate: string, entity: string) => ({
      kind: "saml",
      label: "Thief SAML",
      idpEntityId: entity,
      ssoUrl: "https://thief-idp.example/sso",
      certificates: [certificate],
    });
    await x.call("POST", "/sso/setup/connection", {
      cookie: s.cookie,
      body: body(idp.certificatePem, idp.entityId),
    });
    const untested = await activate(x, s.linkId);
    expect([untested.status, untested.body.error]).toEqual([409, "setup_not_tested"]);
    // The thief passes the test, then changes the IdP of the draft.
    const t = await stolen(x);
    const passed = await thiefDraft(x, t.cookie);
    const other = await createTestIdp({ alg: "rsa" });
    const saved = await x.call("POST", "/sso/setup/connection", {
      cookie: t.cookie,
      body: body(other.certificatePem, other.entityId),
    });
    expect(saved.status).toBe(200);
    const stale = await activate(x, t.linkId);
    expect([stale.status, stale.body.error]).toEqual([409, "setup_not_tested"]);
    const row = await x.w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: passed.id },
    ]);
    expect(row).toMatchObject({ draft: true, enabled: false });
    // The owner cannot turn the draft on by the update route either.
    const owner = await x.call("POST", `/sso/connections/update?id=${passed.id}`, {
      cookie: x.manager,
      body: { enabled: true },
    });
    expect([owner.status, owner.body.error]).toEqual([409, "setup_not_tested"]);
  });

  it("answers 403 forbidden_rank to an owner of another organization, for the preview too", async () => {
    const x = await scene();
    const s = await stolen(x);
    await thiefDraft(x, s.cookie);
    const other = await managerSession(x.w, "owner@beta.example", "beta");
    const cookie = `__Host-tempo_session=${other.token}`;
    const done = await activate(x, s.linkId, cookie);
    expect([done.status, done.body.error]).toEqual([403, "forbidden_rank"]);
    const preview = await x.call("GET", `/sso/setup-links/get?id=${s.linkId}`, { cookie });
    expect([preview.status, preview.body.error]).toEqual([403, "forbidden_rank"]);
    expect(await x.w.storage.findMany("ssoConnection", [])).toMatchObject([{ draft: true }]);
  });

  it("answers 403 forbidden_rank to a member who is no owner", async () => {
    const x = await scene();
    const s = await stolen(x);
    await thiefDraft(x, s.cookie);
    const member = await verifiedSession(x.w, "member@acme.example");
    const added = await addMember(x.w.config, {
      user: x.w.owner.user,
      organizationId: x.org,
      userId: member.user.id,
      role: "member",
    });
    expect(added.ok).toBe(true);
    const refused = await activate(x, s.linkId, `__Host-tempo_session=${member.token}`);
    expect([refused.status, refused.body.error]).toEqual([403, "forbidden_rank"]);
    expect(await x.w.storage.findMany("ssoConnection", [])).toMatchObject([{ draft: true }]);
  });

  it("routes only the verified domains of the link, never sets enforce, and turns on the pending token", async () => {
    const x = await scene();
    const s = await stolen(x, ["domain", "connection", "directory"]);
    const add = async (domain: string) => {
      const added = await x.call("POST", "/sso/setup/domains/add", {
        cookie: s.cookie,
        body: { domain },
      });
      expect(added.status).toBe(200);
      return added.body.domain as { id: string; record: { name: string; value: string } };
    };
    const verified = await add("thief.example");
    await add("pending.example");
    x.w.answers.a[verified.record.name] = [verified.record.value];
    x.w.answers.b[verified.record.name] = [verified.record.value];
    expect(
      (
        await x.call("POST", "/sso/setup/domains/verify", {
          cookie: s.cookie,
          body: { id: verified.id },
        })
      ).status,
    ).toBe(200);
    const minted = await x.call("POST", "/sso/setup/scim-token", { cookie: s.cookie });
    expect(minted.status).toBe(200);
    const scimToken = String(minted.body.token);
    recordCredential(scimToken);
    const users = (token: string) =>
      x.w.handle(
        new Request(`${BASE}/auth/scim/v2/Users`, {
          headers: { ...CLIENT, authorization: `Bearer ${token}` },
        }),
      );
    // A pending token opens no directory.
    expect((await users(scimToken)).status).toBe(401);
    const draft = await thiefDraft(x, s.cookie);
    const manager = await x.w.storage.findOne("ssoDomain", [
      { field: "domain", op: "eq", value: "acme.example" },
    ]);
    expect((await activate(x, s.linkId)).status).toBe(200);
    const domains = await x.w.storage.findMany("ssoDomain", []);
    const byName = Object.fromEntries(domains.map((d) => [d.domain, d]));
    expect(byName["thief.example"]).toMatchObject({ connectionId: draft.id, enforce: false });
    expect(byName["pending.example"]).toMatchObject({ connectionId: null, enforce: false });
    // The domain of the manager is no domain of the link: it stays as it was.
    expect(byName["acme.example"]).toEqual(manager);
    expect((await users(scimToken)).status).toBe(200);
    const row = await x.w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: draft.id },
    ]);
    expect(row).toMatchObject({ draft: false, enabled: true });
  });
});

describe("the activation and a live connection", () => {
  it("takes no domain from a live connection, though the link verified the domain", async () => {
    const x = await scene();
    const s = await stolen(x);
    const added = await x.call("POST", "/sso/setup/domains/add", {
      cookie: s.cookie,
      body: { domain: "thief.example" },
    });
    const domain = added.body.domain as { id: string; record: { name: string; value: string } };
    x.w.answers.a[domain.record.name] = [domain.record.value];
    x.w.answers.b[domain.record.name] = [domain.record.value];
    await x.call("POST", "/sso/setup/domains/verify", {
      cookie: s.cookie,
      body: { id: domain.id },
    });
    const live = await samlConnection(x.w, x.org, await createTestIdp({ alg: "rsa" }));
    const routed = await x.call("POST", "/sso/domains/update", {
      cookie: x.manager,
      body: { id: domain.id, connectionId: live, enforce: true },
    });
    expect(routed.status).toBe(200);
    const draft = await thiefDraft(x, s.cookie);
    const done = await x.call("POST", "/sso/setup-links/activate", {
      cookie: x.manager,
      body: { id: s.linkId, version: 1 },
    });
    expect(done.status).toBe(200);
    const row = await x.w.storage.findOne("ssoDomain", [
      { field: "id", op: "eq", value: domain.id },
    ]);
    expect(row).toMatchObject({ connectionId: live, enforce: true });
    expect(row?.connectionId).not.toBe(draft.id);
  });
});

describe("the limits and the form checks against a thief who guesses (plan 13a Task 14, row 9)", () => {
  /** The `sso.setup_refused` steps that the events hold, in order. */
  async function steps(x: Scene): Promise<string[]> {
    return (await x.events())
      .filter((e) => e.name === "sso.setup_refused")
      .map((e) => (e as unknown as { step: string }).step);
  }

  it("answers 429 to the 21st open of one link, from any address", async () => {
    const x = await scene();
    const s = await stolen(x);
    const seen: number[] = [];
    // The mint step opened once. Opens 2 to 21 come from 20 addresses, so no address limit hits.
    for (let i = 0; i < 20; i++)
      seen.push(
        (
          await x.call("POST", "/sso/setup/open", {
            body: { token: s.token },
            ip: `203.0.113.${i + 1}`,
          })
        ).status,
      );
    expect(seen).toEqual([...Array(19).fill(200), 429]);
    expect(await steps(x)).toEqual(["open_link_limit"]);
  });

  it("answers 429 to the 61st open try of one address, a refused token too", async () => {
    const x = await scene();
    const bad = `sl_${"A".repeat(43)}`;
    const seen: number[] = [];
    for (let i = 0; i < 61; i++)
      seen.push(
        (await x.call("POST", "/sso/setup/open", { body: { token: bad }, ip: THIEF_IP })).status,
      );
    expect(seen.slice(0, 60)).toEqual(Array(60).fill(404));
    expect(seen[60]).toBe(429);
    expect((await steps(x)).at(-1)).toBe("open_ip_limit");
  });

  it("tells a token of the wrong form from an unknown token only in the event", async () => {
    const x = await scene();
    const form = await x.call("POST", "/sso/setup/open", { body: { token: "nope" }, ip: THIEF_IP });
    const unknown = await x.call("POST", "/sso/setup/open", {
      body: { token: `sl_${"A".repeat(43)}` },
      ip: THIEF_IP,
    });
    expect([form.status, form.body.error]).toEqual([404, "setup_link_invalid"]);
    expect([unknown.status, unknown.body.error]).toEqual([404, "setup_link_invalid"]);
    expect(await steps(x)).toEqual(["open_token_form", "open_link_invalid"]);
  });

  it("tells a cookie of the wrong form from an unknown cookie only in the event", async () => {
    const x = await scene();
    const wrong = await x.call("GET", "/sso/setup/status", {
      cookie: `${SETUP_SESSION_COOKIE}=nope`,
    });
    const unknown = await x.call("GET", "/sso/setup/status", {
      cookie: `${SETUP_SESSION_COOKIE}=ss_${"A".repeat(43)}`,
    });
    expect([wrong.status, wrong.body.error]).toEqual([NONE.status, NONE.error]);
    expect([unknown.status, unknown.body.error]).toEqual([NONE.status, NONE.error]);
    expect(await steps(x)).toEqual(["session_cookie", "session_ended"]);
  });

  it("answers 429 to the 61st write of a link, a refused body too", async () => {
    const x = await scene();
    const s = await stolen(x);
    const seen: number[] = [];
    for (let i = 0; i < 61; i++)
      seen.push(
        (
          await x.call("POST", "/sso/setup/domains/verify", {
            cookie: s.cookie,
            ip: THIEF_IP,
            body: { id: "nope" },
          })
        ).status,
      );
    expect(seen.slice(0, 60)).toEqual(Array(60).fill(401));
    expect(seen[60]).toBe(429);
    expect((await steps(x)).at(-1)).toBe("draft_limit");
  });
});

describe("the token leak scan (row 5)", () => {
  it("shows the link token in the mint answer only, and the session token nowhere", async () => {
    const x = await scene();
    const s = await stolen(x);
    await thiefDraft(x, s.cookie);
    await x.call("POST", "/sso/setup/scim-token", { cookie: s.cookie, body: {} });
    await x.call("GET", "/sso/setup/status", { cookie: s.cookie, headers: new Headers() });
    await x.call("POST", "/sso/setup/handback", { cookie: s.cookie, body: {} });
    await x.call("GET", `/sso/setup-links/get?id=${s.linkId}`, { cookie: x.manager });
    await x.call("POST", "/sso/setup-links/activate", {
      cookie: x.manager,
      body: { id: s.linkId, version: 1 },
    });
    await x.call("POST", "/sso/setup/open", { body: { token: s.token } });

    const events = await x.events();
    const names = new Set(events.map((e) => e.name));
    // Count what reported: the scan reads these events and the two audit rows of the activate.
    for (const n of ["sso.setup_opened", "sso.test_run", "sso.activated"])
      expect(names, n).toContain(n);
    const audits = await x.w.storage.findMany("operatorAudit", []);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("sso_setup_link_activate");
    expect(actions).toContain("sso_connection_update");

    const logs = JSON.stringify(
      (["error", "info", "warn", "log", "debug"] as const).map(
        (m) => vi.mocked(console[m]).mock.calls,
      ),
    );
    const elsewhere = [
      JSON.stringify(events),
      JSON.stringify(audits),
      logs,
      JSON.stringify(x.w.mail),
      ...(await Promise.all(
        Object.keys(schema).map(async (name) =>
          JSON.stringify(await x.w.storage.findMany(name as keyof typeof schema, [])),
        ),
      )),
    ];
    for (const text of elsewhere) {
      expect(text).not.toContain(s.token);
      expect(text).not.toContain(s.session);
    }
    const holders = x.answers.filter((a) => a.text.includes(s.token));
    expect(holders.map((a) => a.body.token)).toEqual([s.token]);
    for (const a of x.answers) expect(a.text).not.toContain(s.session);
    // A header is part of an answer. Set-Cookie holds the session of the open only.
    expect(x.answers.length).toBeGreaterThan(8);
    for (const a of x.answers) {
      expect(a.headerText).not.toContain(s.token);
      expect(a.headerText).not.toContain(s.session);
      for (const c of a.headers.getSetCookie()) expect(c).not.toContain(s.token);
    }
  });
});

describe("the route sweep with a setup cookie (row 3)", () => {
  /** The `everyFeature` world with an organization, a live link, and the cookie of its session. */
  async function sweepWorld() {
    const config = everyFeature({ oidc: true, saml: true });
    const handle = createRouter(config, coreRoutes(config));
    const now = config.clock.now();
    const user = await config.storage.create("user", {
      id: newId(now),
      email: "owner@sweep.example",
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: now,
      updatedAt: now,
    });
    await createSession(config, { userId: user.id, ip: null, userAgent: null, proved: true });
    const org = await createOrganization(config, { user, slug: "sweep", name: "Sweep" });
    if (!org.ok) throw new Error(org.code);
    const made = await createSetupLink(config, SSO_APP, {
      organizationId: org.value.organization.id,
      steps: ["domain", "connection", "directory"],
      kinds: ["oidc", "saml"],
      note: "sweep",
    });
    if (!made.ok) throw new Error(made.code);
    const opened = await handle(
      new Request(`${BASE}/auth/sso/setup/open`, {
        method: "POST",
        headers: { ...CLIENT, "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ token: made.value.token }),
      }),
    );
    expect(opened.status).toBe(200);
    const cookie = (opened.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    // A draft of the link: the test start of a connection that the session owns.
    const saved = await handle(
      new Request(`${BASE}/auth/sso/setup/connection`, {
        method: "POST",
        headers: { ...CLIENT, "content-type": "application/json", origin: BASE, cookie },
        body: JSON.stringify({
          kind: "oidc",
          label: "Sweep IdP",
          issuer: "https://login.sweep-idp.example/v2.0",
          clientId: "sweep-client",
          clientSecret: "sweep-secret-0123456789",
          endpoints: {
            authorizeUrl: "https://login.sweep-idp.example/authorize",
            tokenUrl: "https://login.sweep-idp.example/token",
            jwksUrl: "https://login.sweep-idp.example/keys",
          },
        }),
      }),
    );
    expect(saved.status).toBe(200);
    const draftId = ((await saved.json()) as { connection: { id: string } }).connection.id;
    return { handle, cookie, draftId };
  }

  /** The request of a route: the path with a value for each parameter, a JSON body of `{}`. */
  function requestOf(key: RouteKey, headers: Record<string, string>, query = ""): Request {
    const entry = ROUTES.find((r) => `${r.method} ${r.path}` === key);
    if (!entry) throw new Error(`no entry ${key}`);
    const path = entry.path.replace(":provider", "google").replace(/:([A-Za-z]+)/g, "p-$1");
    const url = `${BASE}/auth${path}${query}`;
    if (entry.method === "GET") return new Request(url, { headers });
    if (entry.method === "DELETE")
      return new Request(url, { method: "DELETE", headers: { origin: BASE, ...headers } });
    return new Request(url, {
      method: entry.method,
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      body: "{}",
    });
  }

  async function answerOf(res: Response) {
    const type = res.headers.get("content-type") ?? "";
    const location = res.headers.get("location");
    let code: string | null = null;
    if (type.includes("json")) code = ((await res.json()) as { error?: string }).error ?? null;
    else await res.arrayBuffer();
    return {
      status: res.status,
      code,
      location: location === null ? null : new URL(location, BASE).pathname,
    };
  }

  it("answers as a setup route on the closed list only, and as for no credential elsewhere", async () => {
    const { handle, cookie, draftId } = await sweepWorld();
    const onList = new Set(
      SETUP_SESSION_ROUTES.filter((k) => !k.includes("?")) as readonly string[],
    );
    const seen = { setup: 0, other: 0 };
    for (const entry of ROUTES) {
      const key = `${entry.method} ${entry.path}` as RouteKey;
      const none = await answerOf(await handle(requestOf(key, CLIENT)));
      const got = await answerOf(await handle(requestOf(key, { ...CLIENT, cookie })));
      if (onList.has(key)) {
        seen.setup += 1;
        expect(got, key).not.toEqual(none);
      } else {
        seen.other += 1;
        expect(got, key).toEqual(none);
      }
    }
    // Count what ran: the six keys of the list and every other route of ROUTES.
    expect(seen.setup).toBe(6);
    expect(seen.other).toBe(ROUTES.length - 6);
    // The test start is the seventh key: with the query it answers a setup caller, else it does not.
    // It names the real draft of the session: an unknown connection answers 404 to every caller.
    const start = (headers: Record<string, string>, query = "") =>
      handle(new Request(`${BASE}/auth/sso/${draftId}/start${query}`, { headers }));
    const plain = await answerOf(await start({ ...CLIENT, cookie }));
    expect(plain).toEqual(await answerOf(await start(CLIENT)));
    // The normal start of a draft opens no sign-in, with the cookie or without it.
    const refused = await start({ ...CLIENT, cookie });
    expect(new URL(refused.headers.get("location") ?? BASE).searchParams.get("auth_error")).toBe(
      "sso_not_configured",
    );
    const bare = await answerOf(await start(CLIENT, "?test=1"));
    const test = await answerOf(await start({ ...CLIENT, cookie }, "?test=1"));
    expect([bare.status, test.status]).toEqual([404, 302]);
  });
});

describe("the test and the real flow share their checks (row 7)", () => {
  /** A bad Response by one check each. */
  const BAD: [string, (w: Scene["w"]) => Record<string, unknown>][] = [
    ["audience", () => ({ audience: "https://other-sp.example/entity" })],
    ["recipient", () => ({ recipient: "https://evil.example/acs" })],
    ["inResponseTo", () => ({ inResponseTo: "_not-this-request" })],
    [
      "expired",
      (w) => ({
        notBefore: new Date(w.clock.now().getTime() - 3_600_000),
        notOnOrAfter: new Date(w.clock.now().getTime() - 1_800_000),
      }),
    ],
  ];

  it.each(BAD)(
    "fails a Response with a bad %s in the test and in the sign-in at one step",
    async (_name, make) => {
      const x = await scene();
      const s = await stolen(x);
      const idp = await createTestIdp({ alg: "rsa" });
      const saved = await x.call("POST", "/sso/setup/connection", {
        cookie: s.cookie,
        body: {
          kind: "saml",
          label: "Same IdP",
          idpEntityId: idp.entityId,
          ssoUrl: "https://idp.example/sso",
          certificates: [idp.certificatePem],
        },
      });
      const draftId = String((saved.body.connection as { id: string }).id);
      // The real connection of the same IdP, made by the app.
      const liveId = await samlConnection(x.w, x.org, idp);

      const asTest = async () => {
        const res = await x.w.handle(
          new Request(`${BASE}/auth/sso/${draftId}/start?test=1`, {
            headers: { ...CLIENT, cookie: s.cookie },
          }),
        );
        const location = new URL(res.headers.get("location") ?? "");
        const parsed = parseXml(
          await inflateRequest(location.searchParams.get("SAMLRequest") ?? ""),
        );
        if (!parsed.ok) throw new Error("no AuthnRequest");
        const start = {
          requestId: attrOf(parsed.root, "ID") ?? "",
          relayState: location.searchParams.get("RelayState") ?? "",
          bind:
            res.headers
              .getSetCookie()
              .find((c) => c.startsWith(`${BIND}=`))
              ?.split(";")[0]
              ?.split("=")[1] ?? "",
        };
        return { start, id: draftId };
      };
      const asReal = async () => {
        const res = await x.w.handle(
          new Request(`${BASE}/auth/sso/${liveId}/start`, { headers: CLIENT }),
        );
        const location = new URL(res.headers.get("location") ?? "");
        const parsed = parseXml(
          await inflateRequest(location.searchParams.get("SAMLRequest") ?? ""),
        );
        if (!parsed.ok) throw new Error("no AuthnRequest");
        return {
          id: liveId,
          start: {
            requestId: attrOf(parsed.root, "ID") ?? "",
            relayState: location.searchParams.get("RelayState") ?? "",
            bind:
              res.headers
                .getSetCookie()
                .find((c) => c.startsWith(`${BIND}=`))
                ?.split(";")[0]
                ?.split("=")[1] ?? "",
          },
        };
      };
      const send = async (f: {
        id: string;
        start: { requestId: string; relayState: string; bind: string };
      }) => {
        const xml = await idp.response(responseFor(x.w, f.id, f.start, make(x.w)));
        return postResponse(x.w, f.id, f.start, xml);
      };

      const test = await asTest();
      await send(test);
      const [run] = await x.w.storage.findMany("ssoTestRun", []);
      expect(run?.outcome).toBe("failed");
      expect(SSO_FAILED_STEPS).toContain(run?.step);

      const real = await asReal();
      const answer = await send(real);
      expect(answer.token).toBeNull();
      expect(answer.error).toBe("sso_failed");
      const failed = (await x.events()).filter(
        (e) => e.name === "sso.failed" && "connectionId" in e && e.connectionId === liveId,
      );
      expect(failed).toHaveLength(1);
      expect((failed[0] as unknown as { step: string }).step).toBe(run?.step);
    },
  );
});
