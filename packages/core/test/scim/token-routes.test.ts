import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { createOrganization } from "../../src/engine/organizations.js";
import { createScimToken } from "../../src/engine/scim/tokens.js";
import { createRouter } from "../../src/http/router.js";
import { coreRoutes } from "../../src/http/routes/index.js";
import { BASE_URL } from "../helpers.js";
import { operatorFixture } from "../operator-helpers.js";
import { fakeDns } from "../sso/helpers.js";
import { enrolled, verifiedSession } from "../totp-helpers.js";
import { SCIM_APP, SCIM_IP } from "./helpers.js";

beforeEach(() => {
  // A refused guard writes one log line; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MINUTE_MS = 60_000;

/**
 * The 12f fixture with `scim` on, and an owner of `acme` with a factor and
 * a fresh session. `factor: false` leaves the operator's second factor off.
 */
async function routeWorld(options: { factor?: boolean } = {}) {
  const config: Partial<AuthConfig> = { sso: { dns: [fakeDns("a", {})] }, scim: {} };
  const f = await operatorFixture({
    ...(options.factor === undefined ? {} : { factor: options.factor }),
    config,
  });
  const handle = createRouter(f.auth.config, coreRoutes(f.auth.config));
  const plain = await verifiedSession(f.auth, "owner@acme.example");
  const made = await createOrganization(f.auth.config, {
    user: plain.user,
    slug: "acme",
    name: "Acme",
  });
  if (!made.ok) throw new Error(made.code);
  // The owner turns on a factor after the create; the sign-in of the enable is fresh.
  const owner = (await enrolled(f.auth, "owner@acme.example")).session;
  return { ...f, handle, owner, org: made.value.organization.id };
}
type RouteWorld = Awaited<ReturnType<typeof routeWorld>>;

/** One route call with the session cookie of `token`: its status and body. */
async function send(
  w: RouteWorld,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  token: string | null,
): Promise<[number, Record<string, unknown>]> {
  const headers: Record<string, string> = {
    "cf-connecting-ip": SCIM_IP,
    ...(token === null ? {} : { cookie: `__Host-tempo_session=${token}` }),
  };
  const request =
    method === "GET"
      ? new Request(`${BASE_URL}/auth${path}`, { headers })
      : new Request(`${BASE_URL}/auth${path}`, {
          method,
          headers: { ...headers, "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify(body),
        });
  const res = await w.handle(request);
  return [res.status, (await res.json()) as Record<string, unknown>];
}

describe("the SCIM token routes (plan 12d Task 9)", () => {
  it("answers the refusals of the guard, the input, and the limit", async () => {
    const w = await routeWorld({ factor: false });
    const made = await createScimToken(w.auth.config, SCIM_APP, {
      organizationId: w.org,
      name: "first",
    });
    if (!made.ok) throw new Error(made.code);
    const calls = [
      ["GET", `/scim/tokens?organizationId=${w.org}`, null],
      ["POST", "/scim/tokens/create", { organizationId: w.org, name: "x" }],
      ["POST", "/scim/tokens/revoke", { id: made.value.id }],
    ] as const;
    for (const [method, path, body] of calls) {
      expect(await send(w, method, path, body, null), path).toEqual([
        401,
        { error: "unauthorized" },
      ]);
      // A platform operator with no second factor fails the operator guard.
      expect(await send(w, method, path, body, w.operator.token), path).toEqual([
        403,
        { error: "operator_required" },
      ]);
    }
    // The owner makes the second live token; the third meets the limit.
    const create = { organizationId: w.org, name: "second" };
    expect((await send(w, "POST", "/scim/tokens/create", create, w.owner.token))[0]).toBe(200);
    expect(await send(w, "POST", "/scim/tokens/create", create, w.owner.token)).toEqual([
      409,
      { error: "token_limit" },
    ]);
    // A token with no expiry lists expiresAt as null.
    const [, listed] = await send(
      w,
      "GET",
      `/scim/tokens?organizationId=${w.org}`,
      null,
      w.owner.token,
    );
    expect((listed.tokens as { expiresAt: unknown }[]).map((t) => t.expiresAt)).toEqual([
      null,
      null,
    ]);
    expect(await send(w, "GET", "/scim/tokens", null, w.owner.token)).toEqual([
      400,
      { error: "invalid_body" },
    ]);
    expect(
      await send(
        w,
        "GET",
        `/scim/tokens?organizationId=${w.org}&organizationId=${w.org}`,
        null,
        w.owner.token,
      ),
    ).toEqual([400, { error: "invalid_body" }]);
    expect(
      await send(w, "POST", "/scim/tokens/create", { ...create, name: "" }, w.owner.token),
    ).toEqual([
      400,
      {
        error: "invalid_body",
        message: "name must be 1 to 64 characters with no control character",
      },
    ]);
    expect(
      await send(w, "POST", "/scim/tokens/revoke", { id: made.value.id, more: 1 }, w.owner.token),
    ).toEqual([400, { error: "invalid_body" }]);
    expect(await send(w, "POST", "/scim/tokens/revoke", { id: "k-none" }, w.owner.token)).toEqual([
      404,
      { error: "not_found" },
    ]);
  });

  it("answers second_factor_required and session_not_fresh on every token route", async () => {
    const w = await routeWorld();
    const plain = await verifiedSession(w.auth, "solo@beta.example");
    const beta = await createOrganization(w.auth.config, {
      user: plain.user,
      slug: "beta",
      name: "Beta",
    });
    if (!beta.ok) throw new Error(beta.code);
    const org = beta.value.organization.id;
    const made = await createScimToken(w.auth.config, SCIM_APP, { organizationId: org, name: "b" });
    if (!made.ok) throw new Error(made.code);
    const calls = [
      ["GET", `/scim/tokens?organizationId=${org}`, null],
      ["POST", "/scim/tokens/create", { organizationId: org, name: "x" }],
      ["POST", "/scim/tokens/revoke", { id: made.value.id }],
    ] as const;
    // The owner has no second factor yet.
    for (const [method, path, body] of calls)
      expect(await send(w, method, path, body, plain.token), path).toEqual([
        403,
        { error: "second_factor_required" },
      ]);
    // With the factor, a session older than the fresh window.
    const factor = (await enrolled(w.auth, "solo@beta.example")).session;
    w.auth.clock.advance(w.auth.config.session.freshMinutes * MINUTE_MS);
    for (const [method, path, body] of calls)
      expect(await send(w, method, path, body, factor.token), path).toEqual([
        403,
        { error: "session_not_fresh" },
      ]);
    expect(await w.auth.storage.findMany("scimToken", [])).toHaveLength(1);
  });
});
