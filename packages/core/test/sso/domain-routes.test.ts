import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { hookRefusal } from "../../src/engine/hooks.js";
import { addMember } from "../../src/engine/organizations.js";
import { addDomain } from "../../src/engine/sso/domains.js";
import { createRouter } from "../../src/http/router.js";
import { coreRoutes } from "../../src/http/routes/index.js";
import { sha256Hex } from "../../src/primitives/crypto.js";
import type { OperatorAuditRow } from "../../src/schema.js";
import { BASE_URL } from "../helpers.js";
import { operatorFixture } from "../operator-helpers.js";
import { signUpAndVerify } from "../password-helpers.js";
import { enrolled, PASSWORD, verifiedSession } from "../totp-helpers.js";
import { fakeDns, SSO_APP } from "./helpers.js";

beforeEach(() => {
  // A refused proof and a refused guard write one log line each; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const IP = "203.0.113.7";
const SSO_SECRET = "operator-sso-0123456789abcdef-012345678";

/**
 * A platform operator of the 12f fixture, with `sso` on and two fake
 * resolvers, a secret with the scope `sso`, and an organization of another
 * person. `factor: false` leaves the operator's second factor off.
 * `limits` and `hooks` go into the config.
 */
async function routeWorld(
  options: {
    factor?: boolean;
    limits?: { domainsPerOrganization: number };
    hooks?: AuthConfig["hooks"];
  } = {},
) {
  const answers: { a: Record<string, string[]>; b: Record<string, string[]> } = { a: {}, b: {} };
  const config: Partial<AuthConfig> = {
    sso: {
      dns: [fakeDns("a", answers.a), fakeDns("b", answers.b)],
      ...(options.limits ? { limits: options.limits } : {}),
    },
    // One secret with the scope sso; the user tools stay on for the platform operator.
    operator: {
      secrets: [{ name: "sso", secretHash: await sha256Hex(SSO_SECRET), scopes: ["sso"] }],
      users: true,
    },
    ...(options.hooks ? { hooks: options.hooks } : {}),
  };
  const f = await operatorFixture({
    ...(options.factor === undefined ? {} : { factor: options.factor }),
    config,
  });
  const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
  const owner = await verifiedSession(f.auth, "owner@acme.example");
  const res = await handle(
    request("POST", "/organizations/create", { slug: "acme", name: "Acme" }, owner.token),
  );
  const org = ((await res.json()) as { organization: { id: string } }).organization.id;
  return { ...f, answers, handle, owner, org };
}

/** A request of a route under `/auth`, with the session cookie of `token`, an IP, and a user agent. */
function request(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  token: string | null,
  headers: Record<string, string> = {},
): Request {
  const h: Record<string, string> = {
    "cf-connecting-ip": IP,
    "user-agent": "manager/1",
    ...(token === null ? {} : { cookie: `__Host-tempo_session=${token}` }),
    ...headers,
  };
  if (method === "GET") return new Request(`${BASE_URL}/auth${path}`, { headers: h });
  return new Request(`${BASE_URL}/auth${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE_URL, ...h },
    body: JSON.stringify(body),
  });
}

type RouteWorld = Awaited<ReturnType<typeof routeWorld>>;

/** The status and the JSON body of one route call. */
async function send(
  w: RouteWorld,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  token: string | null = w.operator.token,
  headers: Record<string, string> = {},
): Promise<[number, Record<string, unknown>]> {
  const res = await w.handle(request(method, path, body, token, headers));
  return [res.status, (await res.json()) as Record<string, unknown>];
}

/** The domain of an answer `{ domain }`. */
function domainOf(body: Record<string, unknown>) {
  return body.domain as { id: string; record: { name: string; value: string } | null };
}

async function auditOf(w: RouteWorld, action: OperatorAuditRow["action"]) {
  return w.auth.storage.findMany("operatorAudit", [{ field: "action", op: "eq", value: action }]);
}

/**
 * A second platform operator, signed in now: the grant, then the sign-in
 * with the factor, as the 12f fixture makes the first one.
 */
async function freshOperator(w: RouteWorld, email: string): Promise<string> {
  await signUpAndVerify(w.auth, email, PASSWORD);
  const user = await w.auth.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error("no user");
  const added = await addMember(w.auth.config, {
    user: w.root,
    organizationId: w.platformOrg.id,
    userId: user.id,
    role: "operator",
  });
  if (!added.ok) throw new Error(added.code);
  return (await enrolled(w.auth, email)).session.token;
}

describe("the domain routes (plan 12d Task 2b)", () => {
  it("serves the proof of a domain to a platform operator, with an audit row per write", async () => {
    const w = await routeWorld();
    expect(await send(w, "GET", `/sso/domains?organizationId=${w.org}`, null)).toEqual([
      200,
      { domains: [] },
    ]);
    const [status, body] = await send(w, "POST", "/sso/domains/add", {
      organizationId: w.org,
      domain: "Acme.Example",
    });
    expect(status).toBe(200);
    const d = domainOf(body);
    if (!d.record) throw new Error("no record");
    // Not published yet: resolver a answers no record.
    expect(await send(w, "POST", "/sso/domains/verify", { id: d.id })).toEqual([
      400,
      { error: "domain_unverified" },
    ]);
    // A pending domain lists and updates with no verify time and no check time.
    const [, pending] = await send(w, "GET", `/sso/domains?organizationId=${w.org}`, null);
    expect(pending.domains).toMatchObject([{ id: d.id, verifiedAt: null, checkedAt: null }]);
    const [, updated] = await send(w, "POST", "/sso/domains/update", {
      id: d.id,
      includeSubdomains: true,
    });
    expect(updated.domain).toMatchObject({
      includeSubdomains: true,
      verifiedAt: null,
      checkedAt: null,
    });
    w.answers.a[d.record.name] = [d.record.value];
    w.answers.b[d.record.name] = [d.record.value];
    const [verified, after] = await send(w, "POST", "/sso/domains/verify", { id: d.id });
    expect([verified, (after.domain as { verified: boolean }).verified]).toEqual([200, true]);
    // An add of a verified domain answers it as it is: no record, no expiry, no audit row.
    const [, again] = await send(w, "POST", "/sso/domains/add", {
      organizationId: w.org,
      domain: "acme.example",
    });
    expect(again.domain).toMatchObject({ id: d.id, record: null, expiresAt: null });
    const [, routed] = await send(w, "POST", "/sso/domains/update", {
      id: d.id,
      includeSubdomains: false,
    });
    expect(routed.domain).toMatchObject({
      record: null,
      expiresAt: null,
      includeSubdomains: false,
    });
    expect(await send(w, "POST", "/sso/domains/update", { id: d.id, enforce: true })).toEqual([
      400,
      {
        error: "invalid_body",
        message: "enforce needs a verified domain routed to an enabled connection",
      },
    ]);
    const [, listed] = await send(w, "GET", `/sso/domains?organizationId=${w.org}`, null);
    expect((listed.domains as { id: string }[]).map((x) => x.id)).toEqual([d.id]);
    expect(await send(w, "POST", "/sso/domains/delete", { id: d.id })).toEqual([200, { ok: true }]);
    expect(await send(w, "POST", "/sso/domains/delete", { id: d.id })).toEqual([
      404,
      { error: "not_found" },
    ]);
    const rows = await w.auth.storage.findMany("operatorAudit", [
      { field: "actorId", op: "eq", value: w.operator.user.id },
    ]);
    expect(rows.map((r) => [r.action, r.actorKind, r.ip, r.userAgent])).toEqual([
      ["sso_domain_add", "user", IP, "manager/1"],
      ["sso_domain_update", "user", IP, "manager/1"],
      ["sso_domain_verify", "user", IP, "manager/1"],
      ["sso_domain_update", "user", IP, "manager/1"],
      ["sso_domain_delete", "user", IP, "manager/1"],
    ]);
  });

  it("refuses a caller who is not a platform operator, and an operator who fails the guard", async () => {
    const w = await routeWorld({ factor: false });
    const body = { organizationId: w.org, domain: "acme.example" };
    expect(await send(w, "POST", "/sso/domains/add", body, null)).toEqual([
      401,
      { error: "unauthorized" },
    ]);
    // The owner of the organization manages no domain until Task 3 of plan 12d.
    expect(await send(w, "POST", "/sso/domains/add", body, w.owner.token)).toEqual([
      403,
      { error: "forbidden_rank" },
    ]);
    // A platform operator with no second factor fails the operator guard.
    for (const [method, path, input] of [
      ["GET", `/sso/domains?organizationId=${w.org}`, null],
      ["POST", "/sso/domains/add", body],
    ] as const)
      expect(await send(w, method, path, input)).toEqual([403, { error: "operator_required" }]);
    const d = await addDomain(w.auth.config, SSO_APP, body);
    if (!d.ok) throw new Error(d.code);
    for (const path of ["/sso/domains/verify", "/sso/domains/update", "/sso/domains/delete"])
      expect(await send(w, "POST", path, { id: d.value.id })).toEqual([
        403,
        { error: "operator_required" },
      ]);
    expect(await auditOf(w, "sso_domain_verify")).toEqual([]);
  });

  it("answers invalid_body to a bad domain, a bad query, and a body that is not JSON", async () => {
    const w = await routeWorld();
    expect(
      await send(w, "POST", "/sso/domains/add", { organizationId: w.org, domain: "localhost" }),
    ).toEqual([400, { error: "invalid_body" }]);
    expect(await send(w, "GET", "/sso/domains", null)).toEqual([400, { error: "invalid_body" }]);
    for (const path of ["/sso/domains/verify", "/sso/domains/update", "/sso/domains/delete"])
      expect(await send(w, "POST", path, { id: "d1", more: 1 })).toEqual([
        400,
        { error: "invalid_body" },
      ]);
    const form = await w.handle(
      new Request(`${BASE_URL}/auth/sso/domains/add`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: BASE_URL,
          cookie: `__Host-tempo_session=${w.operator.token}`,
        },
        body: JSON.stringify({ organizationId: w.org, domain: "acme.example" }),
      }),
    );
    expect(form.status).toBe(400);
  });

  it("answers domain_limit, domain_taken, and token_expired through the routes", async () => {
    const w = await routeWorld({ limits: { domainsPerOrganization: 1 } });
    const [, first] = await send(w, "POST", "/sso/domains/add", {
      organizationId: w.org,
      domain: "acme.example",
    });
    expect(
      await send(w, "POST", "/sso/domains/add", { organizationId: w.org, domain: "two.example" }),
    ).toEqual([409, { error: "domain_limit" }]);
    // Another organization proves acme.example first.
    const other = await verifiedSession(w.auth, "owner@other.example");
    const res = await w.handle(
      request("POST", "/organizations/create", { slug: "other", name: "Other" }, other.token),
    );
    const otherOrg = ((await res.json()) as { organization: { id: string } }).organization.id;
    const [, second] = await send(w, "POST", "/sso/domains/add", {
      organizationId: otherOrg,
      domain: "acme.example",
    });
    const mine = domainOf(first);
    const theirs = domainOf(second);
    if (!mine.record || !theirs.record) throw new Error("no record");
    const both = [mine.record.value, theirs.record.value];
    w.answers.a[mine.record.name] = both;
    w.answers.b[mine.record.name] = both;
    expect((await send(w, "POST", "/sso/domains/verify", { id: theirs.id }))[0]).toBe(200);
    expect(await send(w, "POST", "/sso/domains/verify", { id: mine.id })).toEqual([
      409,
      { error: "domain_taken" },
    ]);
    // A pending row lives 7 days. The first operator's session is stale by then.
    const third = await w.handle(
      request("POST", "/organizations/create", { slug: "late", name: "Late" }, other.token),
    );
    const lateOrg = ((await third.json()) as { organization: { id: string } }).organization.id;
    const late = await addDomain(w.auth.config, SSO_APP, {
      organizationId: lateOrg,
      domain: "late.example",
    });
    if (!late.ok) throw new Error(late.code);
    w.auth.clock.advance(7 * DAY_MS);
    const token = await freshOperator(w, "op2@example.com");
    expect(await send(w, "POST", "/sso/domains/verify", { id: late.value.id }, token)).toEqual([
      400,
      { error: "token_expired" },
    ]);
  });

  it("answers the hook codes of operator.beforeAction at the override, and writes no row", async () => {
    let mode: "refuse" | "throw" = "refuse";
    const w = await routeWorld({
      hooks: {
        operator: {
          beforeAction: () => {
            if (mode === "refuse") throw hookRefusal("Not now.");
            throw new Error("down");
          },
        },
      },
    });
    const d = await addDomain(w.auth.config, SSO_APP, {
      organizationId: w.org,
      domain: "acme.example",
    });
    if (!d.ok) throw new Error(d.code);
    const override = { domainId: d.value.id, reason: "IdP down" };
    const secret = { authorization: `Operator ${SSO_SECRET}` };
    expect(await send(w, "POST", "/operator/sso/enforce-off", override, null, secret)).toEqual([
      403,
      { error: "hook_refused", message: "Not now." },
    ]);
    mode = "throw";
    expect(await send(w, "POST", "/operator/sso/enforce-off", override, null, secret)).toEqual([
      500,
      { error: "hook_failed" },
    ]);
    expect(await auditOf(w, "sso_enforce_off")).toEqual([]);
    const row = await w.auth.storage.findOne("ssoDomain", [
      { field: "id", op: "eq", value: d.value.id },
    ]);
    expect(row?.updatedAt).toEqual(row?.createdAt);
  });
});
