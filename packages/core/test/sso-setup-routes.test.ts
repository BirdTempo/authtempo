import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoConfig } from "../src/config.js";
import { resolveSession } from "../src/engine/sessions.js";
import { requireSsoManager } from "../src/engine/sso/guard.js";
import { createSetupLink, revokeSetupLink } from "../src/engine/sso/setup-links.js";
import { SETUP_SESSION_IDLE_MS } from "../src/engine/sso/setup-session.js";
import { json } from "../src/http/json.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { setupSessionRoute } from "../src/http/routes/sso-setup.js";
import { SETUP_SESSION_COOKIE } from "../src/primitives/credentials.js";
import { BASE_URL, recordCredential } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { ssoAuth } from "./sso/helpers.js";
import { managerSession } from "./sso/manager-helpers.js";

const MINUTE_MS = 60_000;
const CLIENT = { "cf-connecting-ip": "198.51.100.7", "user-agent": "setup-routes-agent/1" };
const STATUS = "GET /sso/setup/status" as const;
const HANDBACK = "POST /sso/setup/handback" as const;

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** An engine with `sso.setup` on (or `sso`), an owner of acme, and a way to mint links. */
async function world(sso: SsoConfig = { oidc: true, setup: {} } as SsoConfig) {
  const w = ssoAuth({ sso, password: { hash: FAST, uniformSignUp: false } });
  const owner = await managerSession(w, "owner@acme.example", "acme");
  const resolved = await resolveSession(w.config, owner.token);
  if (!resolved) throw new Error("the session ended");
  const guard = await requireSsoManager(w.config, resolved, owner.org);
  if (!guard.ok) throw new Error(guard.code);
  const mint = async () => {
    const made = await createSetupLink(w.config, guard.value, {
      organizationId: owner.org,
      steps: ["domain", "connection"],
      kinds: ["oidc"],
      note: "Ada at Acme IT",
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    return made.value;
  };
  return { w, owner, actor: guard.value, mint };
}
type World = Awaited<ReturnType<typeof world>>;

const url = (path: string) => `${BASE_URL}/auth${path}`;

/** A same-origin JSON POST, as the page of the app sends it. */
const jsonPost = (path: string, body: unknown, cookie?: string) =>
  new Request(url(path), {
    method: "POST",
    headers: {
      ...CLIENT,
      "content-type": "application/json",
      origin: BASE_URL,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });

/** The form post of the confirm page: same-origin as a browser reports it. */
const formPost = (path: string, fields: Record<string, string>) =>
  new Request(url(path), {
    method: "POST",
    headers: {
      ...CLIENT,
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
      "sec-fetch-site": "same-origin",
    },
    body: new URLSearchParams(fields).toString(),
  });

const getWith = (path: string, cookie?: string) =>
  new Request(url(path), { headers: { ...CLIENT, ...(cookie === undefined ? {} : { cookie }) } });

/** The status and the text of an answer. */
async function read(res: Response): Promise<[number, string]> {
  return [res.status, await res.text()];
}

/** The `name=value` pair of the setup cookie that an answer sets, or throws. */
function cookieOf(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SETUP_SESSION_COOKIE}=`));
  if (!set) throw new Error("no setup cookie");
  const pair = set.split(";")[0] ?? "";
  recordCredential(pair.split("=")[1] ?? "");
  return pair;
}

const sessionRows = (w: World["w"]) => w.storage.findMany("ssoSetupSession", []);
const auditRows = (w: World["w"]) =>
  w.storage.findMany("operatorAudit", [
    { field: "action", op: "eq", value: "sso_setup_link_open" },
  ]);

/** A router with a stub at the status key: the route of Task 9 does not exist yet, so the test builds its own. */
function withStatusRoute(w: World["w"]) {
  const routes = coreRoutes(w.config).filter((r) => r.key !== STATUS && r.key !== HANDBACK);
  routes.push(
    // The answer has the shape of the contract of the status route, so the answers check reads it.
    setupSessionRoute(STATUS, async (_ctx, caller) =>
      json(
        {
          link: {
            id: caller.link.id,
            steps: ["domain", "connection"],
            kinds: ["oidc"],
            note: caller.link.note,
            expiresAt: caller.link.expiresAt.toISOString(),
            readyAt: null,
          },
          domains: [],
          connection: null,
          scimToken: null,
        },
        200,
      ),
    ),
    setupSessionRoute(HANDBACK, async () => json({ done: true }, 200)),
  );
  return createRouter(w.config, routes);
}

describe("the setup routes (plan 13a Task 3)", () => {
  it("serves the confirm page to a GET with no cookie, no session row, and no audit row", async () => {
    const { w, mint } = await world();
    const made = await mint();
    const res = await w.handle(getWith(`/sso/setup?token=${made.token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.getSetCookie()).toEqual([]);
    const html = await res.text();
    expect(html).toContain(`action="/auth/sso/setup/open"`);
    expect(html).toContain(`name="token" value="${made.token}"`);
    expect(html).not.toContain("<script");
    // Twice, as a scanner that follows the link and fetches it again.
    expect((await w.handle(getWith(`/sso/setup?token=${made.token}`))).status).toBe(200);
    expect(await sessionRows(w)).toEqual([]);
    expect(await auditRows(w)).toEqual([]);
    const link = await w.storage.findOne("ssoSetupLink", [
      { field: "id", op: "eq", value: made.id },
    ]);
    expect(link?.openedAt).toBeNull();
  });

  it("answers 400 invalid_body to a GET with no token", async () => {
    const { w } = await world();
    const res = await w.handle(getWith("/sso/setup"));
    expect([res.status, await res.json()]).toEqual([400, { error: "invalid_body" }]);
  });

  it("opens with a JSON post: the cookie, one session row, one audit row", async () => {
    const { w, mint } = await world();
    const made = await mint();
    const res = await w.handle(jsonPost("/sso/setup/open", { token: made.token }));
    expect([res.status, await res.json()]).toEqual([200, { linkId: made.id }]);
    const set = res.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(
      /^__Host-tempo_setup=ss_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(await sessionRows(w)).toHaveLength(1);
    expect(await auditRows(w)).toHaveLength(1);
  });

  it("opens with the form of the confirm page and answers a page with the cookie", async () => {
    const { w, mint } = await world();
    const made = await mint();
    const res = await w.handle(formPost("/sso/setup/open", { token: made.token }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(cookieOf(res)).toMatch(/^__Host-tempo_setup=ss_/);
    expect(await sessionRows(w)).toHaveLength(1);
  });

  it("answers an unknown, an expired, a revoked, and an ended link with one status and one body", async () => {
    const { w, mint, actor } = await world();
    const expired = await mint();
    const revoked = await mint();
    await revokeSetupLink(w.config, actor, revoked.id);
    const ended = await mint();
    await w.storage.update("ssoSetupLink", [{ field: "id", op: "eq", value: ended.id }], {
      endedAt: w.clock.now(),
    });
    w.clock.advance(73 * 3_600_000);
    const answers = [
      `sl_${"A".repeat(43)}`,
      expired.token,
      revoked.token,
      ended.token,
      "plain-text",
    ];
    const got: [number, string][] = [];
    for (const token of answers)
      got.push(await read(await w.handle(jsonPost("/sso/setup/open", { token }))));
    for (const g of got) expect(g).toEqual([404, JSON.stringify({ error: "setup_link_invalid" })]);
    expect(await sessionRows(w)).toEqual([]);
  });

  it("refuses a cross-site POST to the open and to each setup POST before the handler, with no row", async () => {
    const { w, mint } = await world();
    const made = await mint();
    const router = withStatusRoute(w);
    const paths = ["/sso/setup/open", "/sso/setup/handback"];
    for (const path of paths) {
      // A form from another site: the browser reports Sec-Fetch-Site: cross-site and sends no Origin of ours.
      const form = new Request(url(path), {
        method: "POST",
        headers: {
          ...CLIENT,
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "cross-site",
          origin: "https://evil.example",
        },
        body: new URLSearchParams({ token: made.token }).toString(),
      });
      expect(await read(await router(form)), path).toEqual([
        403,
        JSON.stringify({ error: "origin_not_trusted" }),
      ]);
      // A form with no Origin and no same-origin proof, as a cross-site post of an older browser sends it.
      const bare = new Request(url(path), {
        method: "POST",
        headers: {
          ...CLIENT,
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "cross-site",
        },
        body: new URLSearchParams({ token: made.token }).toString(),
      });
      expect((await router(bare)).status, path).toBe(403);
      // A JSON post whose Origin is not trusted.
      const foreign = new Request(url(path), {
        method: "POST",
        headers: { ...CLIENT, "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ token: made.token }),
      });
      expect((await router(foreign)).status, path).toBe(403);
    }
    expect(await sessionRows(w)).toEqual([]);
    expect(await auditRows(w)).toEqual([]);
  });

  it("answers a setup session as for no credential at every route outside the closed list", async () => {
    const { w, mint, owner } = await world();
    const made = await mint();
    const cookie = cookieOf(await w.handle(jsonPost("/sso/setup/open", { token: made.token })));
    // The cookie is live: the one route of the list that this test builds accepts it.
    const router = withStatusRoute(w);
    const live = await router(getWith("/sso/setup/status", cookie));
    expect(live.status).toBe(200);
    expect(((await live.json()) as { link: { id: string } }).link.id).toBe(made.id);
    const org = owner.org;
    const calls: [string, () => Request, () => Request][] = [
      [
        "live connection read",
        () => getWith(`/sso/connections?organizationId=${org}`, cookie),
        () => getWith(`/sso/connections?organizationId=${org}`),
      ],
      [
        "connection update",
        () => jsonPost("/sso/connections/update?id=sc_x", { label: "x" }, cookie),
        () => jsonPost("/sso/connections/update?id=sc_x", { label: "x" }),
      ],
      [
        "enforce",
        () => jsonPost("/sso/domains/update", { id: "sd_x", enforce: true }, cookie),
        () => jsonPost("/sso/domains/update", { id: "sd_x", enforce: true }),
      ],
      [
        "member route",
        () => getWith(`/organizations/members?organizationId=${org}`, cookie),
        () => getWith(`/organizations/members?organizationId=${org}`),
      ],
      [
        "member add",
        () =>
          jsonPost(
            "/organizations/members/add",
            { organizationId: org, userId: "u_x", role: "member" },
            cookie,
          ),
        () =>
          jsonPost("/organizations/members/add", {
            organizationId: org,
            userId: "u_x",
            role: "member",
          }),
      ],
    ];
    for (const [name, withCookie, without] of calls) {
      const a = await read(await router(withCookie()));
      const b = await read(await router(without()));
      expect(b[0], name).toBe(401);
      expect(a, name).toEqual(b);
    }
    // The link is untouched by those calls.
    const link = await w.storage.findOne("ssoSetupLink", [
      { field: "id", op: "eq", value: made.id },
    ]);
    expect(link?.revokedAt).toBeNull();
  });

  it("answers a setup route as for no credential after an idle end and after a revoke", async () => {
    const { w, mint, actor } = await world();
    const none = await read(await withStatusRoute(w)(getWith("/sso/setup/status")));
    expect(none[0]).toBe(401);
    const first = await mint();
    const idle = cookieOf(await w.handle(jsonPost("/sso/setup/open", { token: first.token })));
    const router = withStatusRoute(w);
    expect((await router(getWith("/sso/setup/status", idle))).status).toBe(200);
    w.clock.advance(SETUP_SESSION_IDLE_MS + MINUTE_MS);
    expect(await read(await router(getWith("/sso/setup/status", idle)))).toEqual(none);
    const second = await mint();
    const revoked = cookieOf(await w.handle(jsonPost("/sso/setup/open", { token: second.token })));
    expect((await router(getWith("/sso/setup/status", revoked))).status).toBe(200);
    await revokeSetupLink(w.config, actor, second.id);
    expect(await read(await router(getWith("/sso/setup/status", revoked)))).toEqual(none);
  });

  it("gives a setup session no user: the session endpoint answers as for no cookie and sets no user cookie", async () => {
    const { w, mint } = await world();
    const made = await mint();
    const cookie = cookieOf(await w.handle(jsonPost("/sso/setup/open", { token: made.token })));
    const anonymous = await w.handle(getWith("/session"));
    const withSetup = await w.handle(getWith("/session", cookie));
    expect(await read(withSetup)).toEqual(await read(anonymous));
    expect(withSetup.headers.getSetCookie()).toEqual([]);
    expect(anonymous.headers.getSetCookie()).toEqual([]);
    expect(
      await w.storage.findMany("session", [{ field: "userId", op: "eq", value: "none" }]),
    ).toEqual([]);
  });

  it("serves no setup route while sso.setup is off, and serves them while it is on", async () => {
    for (const sso of [{ oidc: true }, { oidc: true, setup: false }] as SsoConfig[]) {
      const { w } = await world(sso);
      const token = `sl_${"A".repeat(43)}`;
      const page = await w.handle(getWith(`/sso/setup?token=${token}`));
      expect([page.status, await page.json()]).toEqual([404, { error: "not_found" }]);
      const open = await w.handle(jsonPost("/sso/setup/open", { token }));
      expect(open.status).toBe(404);
    }
    const { w } = await world();
    expect((await w.handle(getWith(`/sso/setup?token=sl_x`))).status).toBe(200);
  });

  it("refuses to build a setup session route for a key outside the closed list", () => {
    const stub = async () => json({}, 200);
    expect(() => setupSessionRoute("POST /sso/setup-links/create", stub)).toThrow(/closed list/);
    expect(() => setupSessionRoute("POST /sso/setup/open", stub)).toThrow(/closed list/);
    expect(() => setupSessionRoute("GET /sso/connections", stub)).toThrow(/closed list/);
    expect(() => setupSessionRoute("POST /sso/setup/handback", stub)).not.toThrow();
  });
});
