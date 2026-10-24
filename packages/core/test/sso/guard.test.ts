import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { startImpersonation } from "../../src/engine/operator/impersonation.js";
import { addMember, createOrganization } from "../../src/engine/organizations.js";
import { resolveSession } from "../../src/engine/sessions.js";
import { requireSsoManager } from "../../src/engine/sso/guard.js";
import { createRouter } from "../../src/http/router.js";
import { coreRoutes } from "../../src/http/routes/index.js";
import { BASE_URL } from "../helpers.js";
import { operatorFixture } from "../operator-helpers.js";
import { enrolled, verifiedSession } from "../totp-helpers.js";
import { fakeDns } from "./helpers.js";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MINUTE_MS = 60_000;

/**
 * The 12f fixture with OIDC connections and impersonation on. It holds a
 * platform operator with a factor and a fresh session, and the HTTP view.
 * `owner@acme.example` creates an organization through the engine.
 */
async function guardWorld() {
  const config: Partial<AuthConfig> = {
    sso: { oidc: true, dns: [fakeDns("a", {})] },
    operator: { users: true, impersonation: {} },
  };
  const f = await operatorFixture({ config });
  const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
  const owner = await verifiedSession(f.auth, "owner@acme.example");
  const made = await createOrganization(f.auth.config, {
    user: owner.user,
    slug: "acme",
    name: "Acme",
  });
  if (!made.ok) throw new Error(made.code);
  return { ...f, handle, owner, org: made.value.organization.id };
}

/** One route call with the session cookie of `token`; its status and JSON body. */
async function send(
  w: Awaited<ReturnType<typeof guardWorld>>,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  token: string,
): Promise<[number, unknown]> {
  const headers: Record<string, string> = { cookie: `__Host-tempo_session=${token}` };
  const request =
    method === "GET"
      ? new Request(`${BASE_URL}/auth${path}`, { headers })
      : new Request(`${BASE_URL}/auth${path}`, {
          method,
          headers: { ...headers, "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify(body),
        });
  const res = await w.handle(request);
  return [res.status, await res.json()];
}

/** The input of an OIDC connection of `organizationId`. */
const connection = (organizationId: string) => ({
  organizationId,
  kind: "oidc",
  label: "Acme IdP",
  issuer: "https://login.idp.example/acme",
  clientId: "acme",
  clientSecret: "acme-secret-0123456789",
});

describe("the SSO manager guard (plan 12d Task 3)", () => {
  it("answers one code per failed step of the manager guard", async () => {
    const w = await guardWorld();
    const { config } = w.auth;
    const admin = await verifiedSession(w.auth, "admin@acme.example");
    const added = await addMember(config, {
      user: w.owner.user,
      organizationId: w.org,
      userId: admin.user.id,
      role: "admin",
    });
    expect(added.ok).toBe(true);
    const guard = async (token: string) => {
      const resolved = await resolveSession(config, token);
      if (!resolved) throw new Error("the session ended");
      const r = await requireSsoManager(config, resolved, w.org);
      return r.ok ? r.value.kind : r.code;
    };
    expect(await guard(admin.token)).toBe("forbidden_rank");
    expect(await guard(w.owner.token)).toBe("second_factor_required");
    // The factor through 12c's enable: the sign-in of the enable makes a fresh session.
    const factor = await enrolled(w.auth, "owner@acme.example");
    expect(await guard(factor.session.token)).toBe("owner");
    w.auth.clock.advance(config.session.freshMinutes * MINUTE_MS);
    expect(await guard(factor.session.token)).toBe("session_not_fresh");
    // One log line per refusal, with the step name and no user id.
    const lines = vi
      .mocked(console.error)
      .mock.calls.filter((c) => c[0] === "authtempo: sso guard refused");
    expect(lines).toEqual([
      ["authtempo: sso guard refused", "rank"],
      ["authtempo: sso guard refused", "second_factor"],
      ["authtempo: sso guard refused", "fresh"],
    ]);
  });

  it("refuses an impersonation session", async () => {
    const w = await guardWorld();
    const { config } = w.auth;
    const started = await startImpersonation(config, {
      operator: w.operator,
      userId: w.owner.user.id,
      reason: "Ticket 9: the owner cannot see the SSO page",
      ip: null,
      userAgent: null,
    });
    if (!started.ok) throw new Error(started.code);
    const token = started.value.token;
    // The router refuses each write to an impersonation session.
    expect(await send(w, "POST", "/sso/connections/create", connection(w.org), token)).toEqual([
      403,
      { error: "impersonation_session" },
    ]);
    // The read passes the router; the guard refuses the session.
    expect(await send(w, "GET", `/sso/connections?organizationId=${w.org}`, null, token)).toEqual([
      403,
      { error: "forbidden_rank" },
    ]);
    const resolved = await resolveSession(config, token);
    if (!resolved) throw new Error("the session ended");
    expect(resolved.session.actorId).toBe(w.operator.user.id);
    const r = await requireSsoManager(config, resolved, w.org);
    expect(r.ok ? r.value.kind : r.code).toBe("forbidden_rank");
    expect(await w.auth.storage.findMany("ssoConnection", [])).toEqual([]);
  });

  it("passes a platform operator for any organization", async () => {
    const w = await guardWorld();
    // The operator is no member of the organization.
    expect(
      await w.auth.storage.findOne("member", [
        { field: "organizationId", op: "eq", value: w.org },
        { field: "userId", op: "eq", value: w.operator.user.id },
      ]),
    ).toBeNull();
    const [status, body] = await send(
      w,
      "POST",
      "/sso/connections/create",
      connection(w.org),
      w.operator.token,
    );
    expect(status).toBe(200);
    const id = (body as { connection: { id: string } }).connection.id;
    const rows = await w.auth.storage.findMany("operatorAudit", [
      { field: "action", op: "eq", value: "sso_connection_create" },
    ]);
    expect(rows.map((r) => [r.actorKind, r.actorId, r.data?.connectionId])).toEqual([
      ["user", w.operator.user.id, id],
    ]);
  });
});
