import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "../src/engine/sso/connections.js";
import {
  addSetupDomain,
  SETUP_DRAFT_PER_LINK,
  saveDraftConnection,
  verifySetupDomain,
} from "../src/engine/sso/setup-drafts.js";
import { createSetupLink } from "../src/engine/sso/setup-links.js";
import {
  openSetupSession,
  requireSetupSession,
  SETUP_OPEN_PER_IP,
  SETUP_OPEN_PER_LINK,
  SETUP_PAGE_PER_IP,
} from "../src/engine/sso/setup-session.js";
import { SETUP_REFUSAL_STEPS } from "../src/engine/sso/steps.js";
import { SETUP_TEST_PER_CONNECTION, startTestRun } from "../src/engine/sso/test-run.js";
import { LIMIT_FAMILIES } from "../src/limiter/limit.js";
import { EVENTS, validateEvent } from "../src/observe/events.js";
import type { AuthEvent } from "../src/observe/port.js";
import { SETUP_SESSION_COOKIE } from "../src/primitives/credentials.js";
import { BASE_URL, get, recordAddress, recordCredential } from "./helpers.js";
import { scimAuth } from "./scim/helpers.js";
import { type FakeIdToken, fakeFetch, fakeJwt } from "./social-helpers.js";
import { SSO_APP } from "./sso/helpers.js";
import { endpointsOf, issuerOf } from "./sso/sign-in-helpers.js";

const IP = recordAddress("198.51.100.7");
const AGENT = "observe-agent/1";
const META = { ip: IP, userAgent: AGENT };
const CLIENT = { "cf-connecting-ip": IP, "user-agent": AGENT };
const HOUR_MS = 3_600_000;
const SECRET = "idp-client-secret-0123456789";
const ADA = "ada@acme.example";
const BIND = "__Secure-tempo_session_oauth";
const NAMES = ["sso.setup_opened", "sso.setup_refused", "sso.test_run", "sso.activated"] as const;

beforeEach(() => {
  // A refused step writes one log line; the tests read the events.
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The world of `scimAuth` with `sso.setup`, OIDC with a fake IdP, and a sink of the events. */
async function world() {
  const tokens: Record<string, FakeIdToken> = {};
  const idp = fakeFetch((call) =>
    Response.json({ id_token: call.form.code, token_type: "Bearer" }),
  );
  const batches: AuthEvent[][] = [];
  const w = await scimAuth({
    sso: { oidc: true, setup: {}, fetch: idp.fetchFn },
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

/** The events of one name that a call adds. */
async function added(w: W, name: string, call: () => Promise<unknown>): Promise<AuthEvent[]> {
  const before = (await w.events()).length;
  await call();
  return (await w.events()).slice(before).filter((e) => e.name === name);
}
/** The steps of the refusals that a call adds. */
async function stepsOf(w: W, call: () => Promise<unknown>): Promise<unknown[]> {
  return (await added(w, "sso.setup_refused", call)).map((e) => e.step);
}

async function mint(
  w: W,
  steps: ("domain" | "connection" | "directory")[] = ["domain", "connection"],
) {
  const made = await createSetupLink(w.config, SSO_APP, {
    organizationId: w.org,
    steps,
    kinds: ["oidc"],
    note: "Ada at Acme IT",
  });
  if (!made.ok) throw new Error(made.code);
  recordCredential(made.value.token);
  return made.value;
}

/** A live setup session of a new link, through the real open and check of the cookie. */
async function setup(w: W, steps?: ("domain" | "connection" | "directory")[]) {
  const made = await mint(w, steps);
  const opened = await openSetupSession(w.config, made.token, META);
  if (!opened.ok) throw new Error(opened.code);
  const cookie = opened.value.cookie.split(";")[0] ?? "";
  recordCredential(cookie.split("=")[1] ?? "");
  const checked = await requireSetupSession(
    w.config,
    new Request(`${BASE_URL}/auth/sso/setup/status`, { headers: { cookie } }),
  );
  if (!checked.ok) throw new Error(checked.code);
  return { ...checked.value, cookie, linkId: made.id, token: made.token };
}
type S = Awaited<ReturnType<typeof setup>>;

const jsonPost = (path: string, body: unknown) =>
  new Request(`${BASE_URL}/auth${path}`, {
    method: "POST",
    headers: { ...CLIENT, "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify(body),
  });
const openRoute = (w: W, token: string) => w.handle(jsonPost("/sso/setup/open", { token }));
const pageRoute = (w: W) => w.handle(get("/auth/sso/setup?token=x", CLIENT));

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

const startTest = (w: W, id: string, cookie: string) =>
  w.handle(get(`/auth/sso/${id}/start?test=1`, { cookie }));

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
) {
  const url = new URL(started.headers.get("location") ?? "");
  const code = `ocode-${++codes}`;
  if (claims)
    w.tokens[code] = {
      audience: "acme-client",
      issuer: issuerOf("acme"),
      claims: { ...claims, nonce: url.searchParams.get("nonce") ?? "" },
    };
  const q = new URLSearchParams({ code, state: url.searchParams.get("state") ?? "" });
  return w.handle(get(`/auth/sso/${id}/callback?${q}`, { cookie: `${BIND}=${bindOf(started)}` }));
}

describe("the events of the setup (plan 13a Task 12)", () => {
  it("names four events with closed fields and no free text", () => {
    const fields = (name: (typeof NAMES)[number]) =>
      Object.fromEntries(Object.entries(EVENTS[name].fields).map(([k, v]) => [k, v.kind]));
    expect(fields("sso.setup_opened")).toEqual({ linkId: "id", organizationId: "id" });
    expect(fields("sso.setup_refused")).toEqual({ step: "enum" });
    expect(fields("sso.test_run")).toEqual({
      connectionId: "id",
      linkId: "id",
      outcome: "enum",
      step: "enum",
    });
    expect(fields("sso.activated")).toEqual({
      organizationId: "id",
      connectionId: "id",
      linkId: "id",
    });
    for (const name of NAMES)
      for (const spec of Object.values(EVENTS[name].fields))
        expect(["id", "enum"]).toContain(spec.kind);
    expect(EVENTS["sso.setup_refused"].level).toBe("warn");
    expect(EVENTS["sso.setup_refused"].fields.step.values).toEqual(SETUP_REFUSAL_STEPS);
    // A value outside the closed list is rejected, never kept.
    expect(validateEvent("sso.setup_refused", { step: "a raw IdP message" }).rejected).toEqual([
      "step",
    ]);
  });

  it("emits sso.setup_opened with the link and the organization after an open", async () => {
    const w = await world();
    const made = await mint(w);
    const opened = await added(w, "sso.setup_opened", () => openRoute(w, made.token));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ linkId: made.id, organizationId: w.org, level: "info" });
    const refused = await added(w, "sso.setup_opened", () => openRoute(w, `sl_${"A".repeat(43)}`));
    expect(refused).toEqual([]);
  });

  it("holds no token, secret, address, or IdP text in any event of a whole scene", async () => {
    const w = await world();
    const s = await setup(w);
    await openSetupSession(w.config, "not-a-token", META);
    await openSetupSession(w.config, `sl_${"B".repeat(43)}`, META);
    const id = await oidcDraft(w, s);
    const ok = await oidcCallback(w, id, await startTest(w, id, s.cookie), {
      sub: "ada-subject-77",
      email: ADA,
      name: "Ada Lovelace",
    });
    expect(ok.status).toBe(303);
    const bad = await oidcCallback(w, id, await startTest(w, id, s.cookie), null);
    expect(bad.status).toBe(303);
    const all = await w.events();
    const mine = all.filter((e) => (NAMES as readonly string[]).includes(e.name));
    expect(mine.map((e) => e.name)).toEqual(
      expect.arrayContaining(["sso.setup_opened", "sso.setup_refused", "sso.test_run"]),
    );
    const text = JSON.stringify(all);
    for (const secret of [
      s.token,
      s.cookie.split("=")[1] ?? "?",
      SECRET,
      ADA,
      "Ada Lovelace",
      "ada-subject-77",
      IP,
      AGENT,
      "not-a-token",
    ])
      expect(text).not.toContain(secret);
    // Each field of the four events passed its kind: no field was dropped as rejected.
    for (const e of mine) {
      const { name: _name, level: _level, ...rest } = e as Record<string, unknown>;
      const own = Object.fromEntries(
        Object.entries(rest).filter(([k]) =>
          Object.hasOwn(EVENTS[e.name as (typeof NAMES)[number]].fields, k),
        ),
      );
      expect(validateEvent(e.name as (typeof NAMES)[number], own).rejected).toEqual([]);
    }
  });
});

describe("the limits of the open (plan 13a Task 12, rulings R3 and C11)", () => {
  it("holds the numbers of the limits in code", () => {
    expect(SETUP_OPEN_PER_LINK).toEqual({ seconds: 3600, max: 20 });
    expect(SETUP_OPEN_PER_IP).toEqual({ seconds: 3600, max: 60 });
    expect(SETUP_PAGE_PER_IP).toEqual({ seconds: 3600, max: 60 });
    expect(SETUP_DRAFT_PER_LINK).toEqual({ seconds: 3600, max: 60 });
    expect(SETUP_TEST_PER_CONNECTION).toEqual({ seconds: 3600, max: 20 });
    expect(LIMIT_FAMILIES).toEqual(
      expect.arrayContaining([
        "setup-open:ip",
        "setup-open:link",
        "setup-page:ip",
        "setup-draft:link",
        "setup-test:connection",
      ]),
    );
  });

  it("answers 429 to the 21st open of one link in an hour, and the next hour opens again", async () => {
    const w = await world();
    const made = await mint(w);
    const other = await mint(w);
    for (let i = 0; i < 20; i++) expect((await openRoute(w, made.token)).status).toBe(200);
    const limited = await added(w, "limit.hit", () => openRoute(w, made.token));
    expect(limited).toEqual([expect.objectContaining({ family: "setup-open:link" })]);
    expect((await openRoute(w, made.token)).status).toBe(429);
    // Another link of the same address is not limited by this link.
    expect((await openRoute(w, other.token)).status).toBe(200);
    w.clock.advance(HOUR_MS + 1);
    expect((await openRoute(w, made.token)).status).toBe(200);
  });

  it("counts the confirm page on its own key, so a page view spends no open", async () => {
    const w = await world();
    const made = await mint(w);
    for (let i = 0; i < 60; i++) expect((await pageRoute(w)).status).toBe(200);
    const limited = await added(w, "limit.hit", () => pageRoute(w));
    expect(limited).toEqual([expect.objectContaining({ family: "setup-page:ip" })]);
    expect((await pageRoute(w)).status).toBe(429);
    // The open of the same address still passes: its key `setup-open:ip` is unspent.
    expect((await openRoute(w, made.token)).status).toBe(200);
  });
});

describe("one sso.setup_refused for each refusal step", () => {
  it("names each step of the closed list once in this table", async () => {
    const w = await world();
    // The test table below must cover the list: a step added to the list needs a row.
    expect(w.config.sso?.setup).toBeDefined();
    expect([...SETUP_REFUSAL_STEPS].sort()).toEqual(
      [
        "draft_limit",
        "draft_step",
        "open_ip_limit",
        "open_link_invalid",
        "open_link_limit",
        "open_lost",
        "open_token_form",
        "page_ip_limit",
        "session_cookie",
        "session_ended",
        "session_link",
        "test_caller",
        "test_limit",
      ].sort(),
    );
  });

  it("open_token_form: a text that is no link token", async () => {
    const w = await world();
    expect(await stepsOf(w, () => openSetupSession(w.config, "nope", META))).toEqual([
      "open_token_form",
    ]);
  });

  it("open_link_invalid: an unknown, a revoked, and an expired link", async () => {
    const w = await world();
    expect(
      await stepsOf(w, () => openSetupSession(w.config, `sl_${"A".repeat(43)}`, META)),
    ).toEqual(["open_link_invalid"]);
    const made = await mint(w);
    w.clock.advance(100 * HOUR_MS);
    expect(await stepsOf(w, () => openSetupSession(w.config, made.token, META))).toEqual([
      "open_link_invalid",
    ]);
  });

  it("open_ip_limit: the 61st try of one address", async () => {
    const w = await world();
    for (let i = 0; i < 60; i++) await openSetupSession(w.config, "nope", META);
    expect(await stepsOf(w, () => openSetupSession(w.config, "nope", META))).toEqual([
      "open_ip_limit",
    ]);
  });

  it("open_link_limit: the 21st open of one link", async () => {
    const w = await world();
    const made = await mint(w);
    for (let i = 0; i < 20; i++) await openSetupSession(w.config, made.token, META);
    expect(await stepsOf(w, () => openSetupSession(w.config, made.token, META))).toEqual([
      "open_link_limit",
    ]);
  });

  it("open_lost: the organization is gone between the link read and the write", async () => {
    const w = await world();
    const made = await mint(w);
    await w.storage.delete("organization", [{ field: "id", op: "eq", value: w.org }]);
    expect(await stepsOf(w, () => openSetupSession(w.config, made.token, META))).toEqual([
      "open_lost",
    ]);
  });

  it("page_ip_limit: the 61st view of the confirm page", async () => {
    const w = await world();
    for (let i = 0; i < 60; i++) await pageRoute(w);
    expect(await stepsOf(w, () => pageRoute(w))).toEqual(["page_ip_limit"]);
  });

  it("session_cookie: no cookie, and a value of the wrong form", async () => {
    const w = await world();
    const bare = new Request(`${BASE_URL}/auth/sso/setup/status`);
    const wrong = new Request(`${BASE_URL}/auth/sso/setup/status`, {
      headers: { cookie: `${SETUP_SESSION_COOKIE}=nope` },
    });
    expect(await stepsOf(w, () => requireSetupSession(w.config, bare))).toEqual(["session_cookie"]);
    expect(await stepsOf(w, () => requireSetupSession(w.config, wrong))).toEqual([
      "session_cookie",
    ]);
  });

  it("session_ended: an unknown value and an idle session", async () => {
    const w = await world();
    const s = await setup(w);
    const request = new Request(`${BASE_URL}/auth/sso/setup/status`, {
      headers: { cookie: s.cookie },
    });
    const unknown = new Request(`${BASE_URL}/auth/sso/setup/status`, {
      headers: { cookie: `${SETUP_SESSION_COOKIE}=ss_${"C".repeat(43)}` },
    });
    expect(await stepsOf(w, () => requireSetupSession(w.config, unknown))).toEqual([
      "session_ended",
    ]);
    w.clock.advance(61 * 60_000);
    expect(await stepsOf(w, () => requireSetupSession(w.config, request))).toEqual([
      "session_ended",
    ]);
  });

  it("session_link: the link ended and the session row did not", async () => {
    const w = await world();
    const s = await setup(w);
    await w.storage.update("ssoSetupLink", [{ field: "id", op: "eq", value: s.linkId }], {
      revokedAt: w.clock.now(),
    });
    const request = new Request(`${BASE_URL}/auth/sso/setup/status`, {
      headers: { cookie: s.cookie },
    });
    expect(await stepsOf(w, () => requireSetupSession(w.config, request))).toEqual([
      "session_link",
    ]);
  });

  it("draft_step: a write of a step that the link does not hold", async () => {
    const w = await world();
    const s = await setup(w, ["domain"]);
    expect(await stepsOf(w, () => saveDraftConnection(w.config, s, OIDC))).toEqual(["draft_step"]);
  });

  it("draft_limit: the 61st draft write of one link", async () => {
    const w = await world();
    const s = await setup(w);
    for (let i = 0; i < 60; i++) await verifySetupDomain(w.config, s, "none");
    expect(await stepsOf(w, () => addSetupDomain(w.config, s, "acme.example"))).toEqual([
      "draft_limit",
    ]);
  });

  it("test_caller: a setup session that may not test this connection", async () => {
    const w = await world();
    const owner = await setup(w);
    const id = await oidcDraft(w, owner);
    const stranger = await setup(w, ["domain"]);
    const steps = await stepsOf(w, () =>
      startTestRun(w.config, stranger, id, { ip: IP, userAgent: AGENT }),
    );
    expect(steps).toEqual(["test_caller"]);
  });

  it("test_limit: the 21st test start of one connection", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    for (let i = 0; i < 20; i++) await startTestRun(w.config, s, id, { ip: IP, userAgent: AGENT });
    expect(
      await stepsOf(w, () => startTestRun(w.config, s, id, { ip: IP, userAgent: AGENT })),
    ).toEqual(["test_limit"]);
  });

  it("emits nothing for a pass of each gate", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    expect(
      await stepsOf(w, () => startTestRun(w.config, s, id, { ip: IP, userAgent: AGENT })),
    ).toEqual([]);
    // A live connection is no draft of the link: the same call is refused as a stranger.
    const live = await createConnection(w.config, SSO_APP, {
      organizationId: w.org,
      ...OIDC,
      label: "Live",
    });
    if (!live.ok) throw new Error(live.code);
    expect(
      await stepsOf(w, () =>
        startTestRun(w.config, s, live.value.id, { ip: IP, userAgent: AGENT }),
      ),
    ).toEqual(["test_caller"]);
  });
});

describe("sso.test_run", () => {
  it("emits passed with no step, and failed with the closed step", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const passed = await added(w, "sso.test_run", async () => {
      const res = await oidcCallback(w, id, await startTest(w, id, s.cookie), {
        sub: "a-1",
        email: ADA,
        name: "Ada",
      });
      expect(res.status).toBe(303);
    });
    expect(passed).toHaveLength(1);
    expect(passed[0]).toMatchObject({ connectionId: id, linkId: s.linkId, outcome: "passed" });
    expect(passed[0]).not.toHaveProperty("step");
    const failed = await added(w, "sso.test_run", async () => {
      await oidcCallback(w, id, await startTest(w, id, s.cookie), null);
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      connectionId: id,
      linkId: s.linkId,
      outcome: "failed",
      step: "id_token",
    });
  });

  it("emits once for a run, and none for a callback that ends nothing", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const started = await startTest(w, id, s.cookie);
    const claims = { sub: "a-1", email: ADA };
    const first = await added(w, "sso.test_run", () => oidcCallback(w, id, started, claims));
    expect(first).toHaveLength(1);
    // The state is spent: a replay changes no run and emits nothing.
    const again = await added(w, "sso.test_run", () => oidcCallback(w, id, started, claims));
    expect(again).toEqual([]);
  });

  it("emits no link for the run of a manager", async () => {
    const w = await world();
    const s = await setup(w);
    const id = await oidcDraft(w, s);
    const owner = `__Host-tempo_session=${w.owner.token}`;
    const events = await added(w, "sso.test_run", async () => {
      await oidcCallback(w, id, await startTest(w, id, owner), { sub: "a-1", email: ADA });
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ connectionId: id, outcome: "passed" });
    expect(events[0]).not.toHaveProperty("linkId");
  });
});
