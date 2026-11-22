import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoConfig } from "../src/config.js";
import { resolveSession } from "../src/engine/sessions.js";
import { requireSsoManager } from "../src/engine/sso/guard.js";
import { saveDraftConnection } from "../src/engine/sso/setup-drafts.js";
import { createSetupLink } from "../src/engine/sso/setup-links.js";
import { requireSetupSession, type SetupSession } from "../src/engine/sso/setup-session.js";
import { failTestRun, passTestRun } from "../src/engine/sso/test-run-store.js";
import { escapeHtml } from "../src/http/confirm-page.js";
import { noScriptPagePolicy, pageHeaders } from "../src/http/csp.js";
import { renderSetupPage, type SetupPageInput } from "../src/http/setup-page.js";
import { newId } from "../src/primitives/ids.js";
import { GUIDES, guideOf, type IdpGuide } from "../src/sso/guides/index.js";
import { createTestIdp } from "../src/testing/saml-idp.js";
import { BASE_URL, recordCredential } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { ssoAuth } from "./sso/helpers.js";
import { managerSession } from "./sso/manager-helpers.js";

const CLIENT = { "cf-connecting-ip": "198.51.100.7", "user-agent": "setup-page-agent/1" };
const SECRET = "idp-client-secret-0123456789";
const OIDC = {
  kind: "oidc",
  label: "Acme Okta",
  issuer: "https://login.idp.example/acme",
  clientId: "acme-client",
  clientSecret: SECRET,
} as const;
const STEPS = ["idp", "domain", "connect", "test", "directory", "handback"] as const;

beforeEach(() => {
  for (const m of ["error", "info", "warn", "log", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type MintSteps = ("domain" | "connection" | "directory")[];

/** An engine with `sso.setup` on, an owner of acme, and a way to mint links and to open a page session. */
async function world(sso: SsoConfig = { oidc: true, saml: true, setup: {} } as SsoConfig) {
  const w = ssoAuth({ sso, password: { hash: FAST, uniformSignUp: false } });
  const owner = await managerSession(w, "owner@acme.example", "acme");
  const resolved = await resolveSession(w.config, owner.token);
  if (!resolved) throw new Error("the session ended");
  const guard = await requireSsoManager(w.config, resolved, owner.org);
  if (!guard.ok) throw new Error(guard.code);
  /** A link, its open through the real route, and the cookie pair of the setup session. */
  const open = async (steps: MintSteps = ["domain", "connection", "directory"]) => {
    const made = await createSetupLink(w.config, guard.value, {
      organizationId: owner.org,
      steps,
      kinds: ["oidc", "saml"],
      note: "Ada at Acme IT",
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const res = await w.handle(
      new Request(`${BASE_URL}/auth/sso/setup/open`, {
        method: "POST",
        headers: {
          ...CLIENT,
          "content-type": "application/json",
          origin: BASE_URL,
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ token: made.value.token }),
      }),
    );
    const set = res.headers.getSetCookie()[0] ?? "";
    const cookie = set.split(";")[0] ?? "";
    recordCredential(cookie.split("=")[1] ?? "");
    const checked = await requireSetupSession(
      w.config,
      new Request(`${BASE_URL}/auth/sso/setup/status`, { headers: { cookie } }),
    );
    if (!checked.ok) throw new Error(checked.code);
    const session: SetupSession = checked.value;
    return { cookie, session, linkId: made.value.id };
  };
  const status = (cookie: string, query = "") =>
    w.handle(
      new Request(`${BASE_URL}/auth/sso/setup/status${query}`, {
        headers: { ...CLIENT, cookie },
      }),
    );
  return { w, owner, open, status };
}
type World = Awaited<ReturnType<typeof world>>;

async function html(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  return res.text();
}

async function samlDraft(x: World, s: SetupSession) {
  const idp = await createTestIdp({ alg: "rsa" });
  const saved = await saveDraftConnection(x.w.config, s, {
    kind: "saml",
    label: "Acme SAML",
    idpEntityId: idp.entityId,
    ssoUrl: "https://idp.example/sso",
    certificates: [idp.certificatePem],
  });
  if (!saved.ok) throw new Error(saved.code);
  return saved.value;
}

async function oidcDraft(x: World, s: SetupSession) {
  const saved = await saveDraftConnection(x.w.config, s, OIDC);
  if (!saved.ok) throw new Error(saved.code);
  return saved.value;
}

/** A run of the draft that ends as the test callback ends it: a pending row, then a pass or a fail. */
async function endedRun(
  x: World,
  s: SetupSession,
  connectionId: string,
  end: { pass: { name: string | null; names: string[] } } | { fail: string },
  version = 1,
) {
  const now = x.w.config.clock.now();
  const row = {
    id: newId(now),
    organizationId: s.link.organizationId,
    connectionId,
    linkId: s.link.id,
    outcome: "pending" as const,
    step: null,
    attributeNames: [],
    domainClaimed: false,
    draftVersion: version,
    createdAt: now,
    updatedAt: now,
  };
  await x.w.storage.create("ssoTestRun", row);
  if ("fail" in end) await failTestRun(x.w.config, row, end.fail);
  else
    await passTestRun(
      x.w.config,
      row,
      {
        subject: "subject-1",
        email: "ada@acme.example",
        name: end.pass.name,
        image: null,
        amr: [],
        acr: null,
        authnContext: null,
        sessionNotOnOrAfter: null,
      },
      end.pass.names,
    );
  return row.id;
}

describe("the setup page route (plan 13a Task 9)", () => {
  it("answers 401 with no cookie, as for no credential", async () => {
    const x = await world();
    const res = await x.w.handle(new Request(`${BASE_URL}/auth/sso/setup/status`));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).not.toContain("text/html");
  });

  it("CSP: each step has the headers of the other pages and no script", async () => {
    const x = await world();
    const { cookie } = await x.open();
    const want = pageHeaders(x.w.config, noScriptPagePolicy(x.w.config));
    for (const step of STEPS) {
      const res = await x.status(cookie, `?step=${step}`);
      const body = await html(res);
      expect(res.headers.get("content-security-policy"), step).toBe(
        want["content-security-policy"],
      );
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("content-security-policy")).not.toContain("script-src");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe(want["content-type"]);
      expect(res.headers.get("referrer-policy")).toBe(want["referrer-policy"]);
      expect(res.headers.get("x-robots-tag")).toBe(want["x-robots-tag"]);
      expect(body, step).not.toMatch(/<script/i);
      expect(body, step).not.toMatch(/\son[a-z]+=/i);
      // Each form posts to a route of this app, under the base path.
      for (const m of body.matchAll(/<form [^>]*action="([^"]*)"/g))
        expect(m[1], step).toMatch(/^\/auth\/sso\/setup\//);
    }
  });

  it("steps shown: a link with no directory step has no directory page and no token form", async () => {
    const x = await world();
    const { cookie } = await x.open(["domain", "connection"]);
    for (const step of STEPS) {
      const body = await html(await x.status(cookie, `?step=${step}`));
      expect(body, step).not.toContain("step=directory");
      expect(body, step).not.toContain("/sso/setup/scim-token");
    }
    const all = await x.open(["domain", "connection", "directory"]);
    const body = await html(await x.status(all.cookie, "?step=directory"));
    expect(body).toContain("step=directory");
    expect(body).toContain('action="/auth/sso/setup/scim-token"');
  });

  it("steps shown: a link with the domain step only has no connection page", async () => {
    const x = await world();
    const { cookie } = await x.open(["domain"]);
    const body = await html(await x.status(cookie, "?step=connect"));
    expect(body).not.toContain("step=connect");
    expect(body).not.toContain("step=idp");
    expect(body).not.toContain("/sso/setup/connection");
    expect(body).toContain('action="/auth/sso/setup/domains/add"');
  });

  it("starts on the choice of the IdP, then shows the guide of the choice", async () => {
    const x = await world();
    const { cookie } = await x.open();
    const first = await html(await x.status(cookie));
    for (const g of GUIDES) expect(first).toContain(`idp=${g.id}`);
    const okta = await html(await x.status(cookie, "?step=connect&idp=okta"));
    expect(okta).toContain("Okta");
    expect(okta).toContain("Create App Integration");
    // An id with no guide gives no guide, and no error.
    const none = await html(await x.status(cookie, "?step=connect&idp=nope"));
    expect(none).not.toContain("Create App Integration");
  });

  it("values: the connect step shows the real ACS URL, entity id, and redirect URI", async () => {
    const x = await world();
    const { cookie, session } = await x.open();
    const saml = await samlDraft(x, session);
    const body = await html(await x.status(cookie, "?step=connect&idp=okta"));
    expect(body).toContain(`${BASE_URL}/auth/sso/${saml.id}/acs`);
    expect(body).toContain(`${BASE_URL}/auth/sso/${saml.id}/metadata`);
    // The same link makes a second draft by a change of the one draft: switch to OIDC in another link.
    const y = await x.open();
    const oidc = await oidcDraft(x, y.session);
    const other = await html(await x.status(y.cookie, "?step=connect&idp=okta"));
    expect(other).toContain(`${BASE_URL}/auth/sso/${oidc.id}/callback`);
    expect(other).not.toContain(`${BASE_URL}/auth/sso/${saml.id}/acs`);
  });

  it("values: the launch text names the real start URL", async () => {
    const x = await world();
    const { cookie, session } = await x.open();
    const saml = await samlDraft(x, session);
    const body = await html(await x.status(cookie, "?step=connect&idp=okta"));
    expect(body).toContain(`${BASE_URL}/auth/sso/${saml.id}/start`);
    expect(body).not.toContain("/sso/&lt;id&gt;/start");
  });

  it("secret: a saved OIDC secret is in no step", async () => {
    const x = await world();
    const { cookie, session } = await x.open();
    await oidcDraft(x, session);
    for (const step of STEPS) {
      const body = await html(await x.status(cookie, `?step=${step}&idp=okta`));
      expect(body, step).not.toContain(SECRET);
    }
    // The form of a saved draft shows the other values and asks for the secret again.
    const body = await html(await x.status(cookie, "?step=connect&idp=okta"));
    expect(body).toContain("https://login.idp.example/acme");
    expect(body).not.toMatch(/name="clientSecret"[^>]*value=/);
  });

  it("goes to the next open step, and to the confirm page after the hand back", async () => {
    const x = await world();
    const a = await x.open(["domain"]);
    expect(await html(await x.status(a.cookie))).toContain('action="/auth/sso/setup/domains/add"');
    const b = await x.open(["connection"]);
    expect(await html(await x.status(b.cookie))).toContain("idp=okta");
    await oidcDraft(x, b.session);
    // A draft with no passed test: the test page.
    expect(await html(await x.status(b.cookie))).toContain("/start?test=1");
    await x.w.storage.update("ssoSetupLink", [{ field: "id", op: "eq", value: b.linkId }], {
      readyAt: x.w.config.clock.now(),
    });
    const done = await html(await x.status(b.cookie));
    expect(done).toContain("Your work is done");
    expect(done).not.toContain("/start?test=1");
  });

  it("test: shows a passed run with its attribute names, the address, and the name", async () => {
    const x = await world();
    const { cookie, session } = await x.open();
    const draft = await oidcDraft(x, session);
    const run = await endedRun(x, session, draft.id, {
      pass: { name: "Ada Lovelace", names: ["email", "groups"] },
    });
    const body = await html(await x.status(cookie, `?run=${run}`));
    expect(body).toContain("The test passed");
    expect(body).toContain("ada@acme.example");
    expect(body).toContain("Ada Lovelace");
    expect(body).toContain("groups");
    expect(body).toContain("/start?test=1");
  });

  it("test: a run of an older draft version is marked as old", async () => {
    const x = await world();
    const { cookie, session } = await x.open();
    const draft = await oidcDraft(x, session);
    const run = await endedRun(x, session, draft.id, { pass: { name: null, names: [] } }, 0);
    const body = await html(await x.status(cookie, `?run=${run}`));
    expect(body).toContain("older version");
  });

  it("test: a failed run shows the help line of its step", async () => {
    const x = await world();
    const { cookie, session } = await x.open();
    const draft = await oidcDraft(x, session);
    const run = await endedRun(x, session, draft.id, { fail: "signature" });
    const body = await html(await x.status(cookie, `?run=${run}`));
    expect(body).toContain("The test did not pass");
    expect(body).toContain("Upload the current signing certificate.");
  });

  it("test: the run of another link shows no result", async () => {
    const x = await world();
    const a = await x.open();
    const b = await x.open();
    const draft = await oidcDraft(x, a.session);
    const run = await endedRun(x, a.session, draft.id, {
      pass: { name: "Ada Lovelace", names: ["email"] },
    });
    const body = await html(await x.status(b.cookie, `?run=${run}`));
    expect(body).not.toContain("ada@acme.example");
    expect(body).not.toContain("Ada Lovelace");
    expect(body).toContain("not_found");
  });

  it("test: hostile attribute names, address, and name from the IdP come out escaped", async () => {
    const x = await world();
    const { cookie, session } = await x.open();
    const draft = await oidcDraft(x, session);
    const name = `<script>alert('name')</script>`;
    const names = [`<img src=x onerror=alert(1)>`, `"><svg/onload=alert(2)>`];
    const run = await endedRun(x, session, draft.id, { pass: { name, names } });
    const body = await html(await x.status(cookie, `?run=${run}`));
    expect(body).not.toMatch(/<script|<img|<svg/i);
    expect(body).toContain(escapeHtml(name));
    for (const n of names) expect(body).toContain(escapeHtml(n));
  });

  it("override: sso.setup.page gives the HTML, and core still sets the headers", async () => {
    const seen: SetupPageInput[] = [];
    const x = await world({
      oidc: true,
      saml: true,
      setup: {
        page: (input) => {
          seen.push(input);
          return `<html><body>app page ${input.step}</body></html>`;
        },
      },
    } as SsoConfig);
    const { cookie } = await x.open();
    const res = await x.status(cookie);
    expect(await html(res)).toBe("<html><body>app page idp</body></html>");
    expect(res.headers.get("content-security-policy")).toBe(noScriptPagePolicy(x.w.config));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(seen).toHaveLength(1);
    const input = seen[0] as SetupPageInput;
    expect(input.link).toEqual({
      organization: "acme",
      note: "Ada at Acme IT",
      steps: ["domain", "connection", "directory"],
      kinds: ["oidc", "saml"],
    });
    expect(input.csrf).toMatch(/^[0-9a-f]{64}$/);
    expect(input.error).toBeNull();
    expect(input.guide).toBeNull();
  });
});

/** The text that an attack puts in a value. A tag of the field makes each case its own. */
const hostile = (tag: string) => `"><script>alert('${tag}')</script>&<b>`;

function base(over: Partial<SetupPageInput> = {}): SetupPageInput {
  return {
    step: "connect",
    csrf: "c".repeat(64),
    link: {
      organization: "Acme",
      note: "Ada at Acme IT",
      steps: ["domain", "connection", "directory"],
      kinds: ["oidc", "saml"],
    },
    guide: null,
    values: {
      acsUrl: "https://auth.example/auth/sso/c1/acs",
      entityId: "https://auth.example/auth/sso/c1/metadata",
      redirectUri: "https://auth.example/auth/sso/c1/callback",
      scimBaseUrl: "https://auth.example/auth/scim/v2",
      scimToken: "",
    },
    draft: null,
    test: null,
    error: null,
    domains: [],
    scim: null,
    ...over,
  };
}

const OKTA = guideOf("okta") as IdpGuide;
const DRAFT = {
  id: "c1",
  kind: "oidc" as const,
  label: "Acme Okta",
  version: 1,
  issuer: "https://login.idp.example/acme",
  clientId: "acme-client",
  ssoUrl: null,
  idpEntityId: null,
};
const TEST = {
  outcome: "passed" as const,
  step: null,
  help: "",
  attributeNames: ["email"],
  address: "ada@acme.example",
  name: "Ada",
  domainClaimed: true,
  current: true,
};
const guideWith = (over: Partial<IdpGuide>): IdpGuide => ({ ...OKTA, ...over });

describe("the page escapes every value (plan 13a Task 9, hand-offs)", () => {
  const cases: [string, (h: string) => Partial<SetupPageInput>][] = [
    ["note", (h) => ({ step: "idp", link: { ...base().link, note: h } })],
    ["organization", (h) => ({ step: "idp", link: { ...base().link, organization: h } })],
    ["draft label", (h) => ({ draft: { ...DRAFT, label: h } })],
    ["draft issuer", (h) => ({ draft: { ...DRAFT, issuer: h } })],
    ["draft client id", (h) => ({ draft: { ...DRAFT, clientId: h } })],
    [
      "draft sso url",
      (h) => ({ draft: { ...DRAFT, kind: "saml", issuer: null, clientId: null, ssoUrl: h } }),
    ],
    [
      "draft idp entity id",
      (h) => ({ draft: { ...DRAFT, kind: "saml", issuer: null, clientId: null, idpEntityId: h } }),
    ],
    ["draft id", (h) => ({ step: "test", draft: { ...DRAFT, id: h } })],
    ["guide name", (h) => ({ guide: guideWith({ name: h }) })],
    ["guide step text", (h) => ({ guide: guideWith({ steps: [{ text: h }] }) })],
    [
      "guide step reason",
      (h) => ({ guide: guideWith({ steps: [{ text: "A step.", unconfirmed: h }] }) }),
    ],
    [
      "guide field label",
      (h) => ({
        guide: guideWith({
          fields: { ...OKTA.fields, acsUrl: h },
          steps: [{ text: "A step.", value: "acsUrl" }],
        }),
      }),
    ],
    [
      "value in a step",
      (h) => ({
        guide: guideWith({ steps: [{ text: "A step.", value: "acsUrl" }] }),
        values: { ...base().values, acsUrl: h },
      }),
    ],
    ["guide launch", (h) => ({ draft: DRAFT, guide: guideWith({ launch: h }) })],
    [
      "guide launch reason",
      (h) => ({ draft: DRAFT, guide: guideWith({ launch: "A launch.", launchUnconfirmed: h }) }),
    ],
    ["guide directory", (h) => ({ step: "directory", guide: guideWith({ directory: h }) })],
    [
      "guide scim step",
      (h) => ({
        step: "directory",
        guide: guideWith({ steps: [{ text: `For SCIM, ${h}` }] }),
      }),
    ],
    ["scim hint", (h) => ({ step: "directory", scim: { hint: h } })],
    [
      "test attribute name",
      (h) => ({ step: "test", draft: DRAFT, test: { ...TEST, attributeNames: [h] } }),
    ],
    ["test address", (h) => ({ step: "test", draft: DRAFT, test: { ...TEST, address: h } })],
    ["test name", (h) => ({ step: "test", draft: DRAFT, test: { ...TEST, name: h } })],
    [
      "test help",
      (h) => ({
        step: "test",
        draft: DRAFT,
        test: { ...TEST, outcome: "failed", help: h, address: null, name: null },
      }),
    ],
    [
      "test step",
      (h) => ({
        step: "test",
        draft: DRAFT,
        test: { ...TEST, outcome: "failed", step: h, address: null, name: null },
      }),
    ],
    [
      "domain name",
      (h) => ({
        step: "domain",
        domains: [{ id: "d1", domain: h, verified: true, record: null }],
      }),
    ],
    [
      "domain id",
      (h) => ({
        step: "domain",
        domains: [
          {
            id: h,
            domain: "acme.test",
            verified: false,
            record: { name: "n", type: "TXT", value: "v" },
          },
        ],
      }),
    ],
    [
      "domain record name",
      (h) => ({
        step: "domain",
        domains: [
          {
            id: "d1",
            domain: "acme.test",
            verified: false,
            record: { name: h, type: "TXT", value: "v" },
          },
        ],
      }),
    ],
    [
      "domain record value",
      (h) => ({
        step: "domain",
        domains: [
          {
            id: "d1",
            domain: "acme.test",
            verified: false,
            record: { name: "n", type: "TXT", value: h },
          },
        ],
      }),
    ],
  ];

  it.each(cases)("%s", async (tag, patch) => {
    const x = await world();
    const h = hostile(tag);
    const out = renderSetupPage(x.w.config, base(patch(h)));
    expect(out, tag).not.toContain("<script");
    expect(out, tag).not.toContain(h);
    expect(out, tag).toContain(escapeHtml(h));
  });

  it("the text of a guide with <id>, <your tenant>, and <Directory (tenant) ID> shows as text", async () => {
    const x = await world();
    const text = "Open <your tenant> and copy <Directory (tenant) ID> to /sso/<id>/start.";
    const out = renderSetupPage(
      x.w.config,
      base({ guide: guideWith({ steps: [{ text }] }), draft: DRAFT }),
    );
    expect(out).toContain(escapeHtml(text));
    expect(out).not.toContain("<your tenant>");
  });
});

describe("the Unconfirmed marks of the guides (plan 13a Task 9, Task 15)", () => {
  it("each guide shows each mark, and the guides hold eight", async () => {
    const x = await world();
    const marks = (g: IdpGuide) => [
      ...g.steps.flatMap((s) => (s.unconfirmed === undefined ? [] : [s.unconfirmed])),
      ...(g.launchUnconfirmed === undefined ? [] : [g.launchUnconfirmed]),
    ];
    expect(GUIDES.flatMap(marks)).toHaveLength(8);
    for (const g of GUIDES) {
      const shown = g.kinds
        .flatMap((kind) =>
          (["connect", "directory"] as const).map((step) =>
            renderSetupPage(
              x.w.config,
              base({ step, guide: g, draft: { ...DRAFT, kind }, scim: null }),
            ),
          ),
        )
        .join("\n");
      for (const m of marks(g)) {
        expect(shown, `${g.id}: ${m}`).toContain(escapeHtml(m));
        expect(shown).toContain("Unconfirmed");
      }
    }
  });

  it("a guide with no mark shows no Unconfirmed word", async () => {
    const x = await world();
    const g = guideOf("generic-oidc") as IdpGuide;
    const out = renderSetupPage(x.w.config, base({ guide: g, draft: DRAFT }));
    expect(out).not.toContain("Unconfirmed");
  });
});
