import type { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { scimBase } from "../../engine/scim/discovery.js";
import { publicConnection } from "../../engine/sso/connections.js";
import { summary as domainSummary } from "../../engine/sso/domains.js";
import { recheckSsoManager } from "../../engine/sso/guard.js";
import { activateSetup, previewSetup } from "../../engine/sso/setup-activate.js";
import {
  addSetupDomain,
  createPendingScimToken,
  saveDraftConnection,
  verifySetupDomain,
} from "../../engine/sso/setup-drafts.js";
import { setupRefused } from "../../engine/sso/setup-events.js";
import {
  createSetupLink,
  getSetupLink,
  handBack,
  listSetupLinks,
  revokeSetupLink,
} from "../../engine/sso/setup-links.js";
import {
  openSetupSession,
  requireSetupSession,
  SETUP_PAGE_PER_IP,
  SETUP_STATUS_PER_IP,
} from "../../engine/sso/setup-session.js";
import { testRunResult } from "../../engine/sso/test-run.js";
import type { ErrorCode } from "../../errors.js";
import { ipKey } from "../../limiter/ip-key.js";
import { limit } from "../../limiter/limit.js";
import { sha256Hex } from "../../primitives/crypto.js";
import { fail, ok } from "../../result.js";
import type { SetupStep, SsoSetupLinkRow, SsoSetupSessionRow } from "../../schema.js";
import { guideOf, spValues } from "../../sso/guides/index.js";
import { isJsonRequest, readBody } from "../body.js";
import { escapeHtml } from "../confirm-page.js";
import {
  domainIdBody,
  setupActivateBody,
  setupConnectionBody,
  setupDomainAddBody,
  setupLinkCreateBody,
  setupLinkCreateQuery,
  setupLinkIdBody,
  setupLinkIdQuery,
  setupLinkListQuery,
  setupOpenBody,
  setupPageQuery,
  setupStatusQuery,
} from "../contract/sso.js";
import { noScriptPagePolicy, pageHeaders } from "../csp.js";
import { json, respond } from "../json.js";
import { ROUTES, type RouteKey } from "../route-list.js";
import type { Route, RouteContext } from "../router.js";
import {
  type DraftSummary,
  renderSetupPage,
  type SetupDomain,
  type SetupPageInput,
  type SetupPageStep,
  stepsOfLink,
  type TestSummary,
} from "../setup-page.js";
import { managedBody, managedCall, readQuery } from "./sso.js";

/**
 * The closed list of the setup session (plan 13a Task 3, spec 6.1 item 6).
 * Each entry is a route key that takes the setup cookie as its credential,
 * and no route outside this list reads that cookie. `setupSessionRoute` is
 * the one way to build such a route, and it refuses a key that is not
 * here. So a new route is closed to a setup session by default: it needs
 * a line in this list, and the test of this list holds it to `ROUTES`.
 * The last entry is the test start of a draft (Task 7). It is one route
 * with two callers, so its handler reads this list for the `test=1` query.
 */
export const SETUP_SESSION_ROUTES: readonly string[] = Object.freeze([
  "POST /sso/setup/domains/add",
  "POST /sso/setup/domains/verify",
  "POST /sso/setup/connection",
  "POST /sso/setup/scim-token",
  "POST /sso/setup/handback",
  "GET /sso/setup/status",
  "GET /sso/:connectionId/start?test=1",
]);

/** What a handler of a setup session route gets: the live link and the live session of its cookie. */
export interface SetupCaller {
  link: SsoSetupLinkRow;
  session: SsoSetupSessionRow;
}

/**
 * Builds one route that a setup session calls. The route key must be in
 * `SETUP_SESSION_ROUTES`, else the build throws, so no route takes the
 * cookie by accident. `requireSetupSession` runs before the handler and
 * before any body read. Each refusal answers 401 `unauthorized`, the answer
 * of a request with no credential. The router builds the Origin and Fetch
 * Metadata rules around it as for each POST.
 */
export function setupSessionRoute(
  key: RouteKey,
  handler: (ctx: RouteContext, caller: SetupCaller) => Promise<Response>,
): Route {
  const entry = ROUTES.find((r) => `${r.method} ${r.path}` === key);
  if (!entry || !SETUP_SESSION_ROUTES.includes(key))
    throw new Error(`authtempo: ${key} is not on the closed list of the setup session`);
  return {
    method: entry.method,
    path: entry.path,
    key,
    async handler(ctx) {
      const caller = await requireSetupSession(ctx.config, ctx.request);
      if (!caller.ok) return respond(caller);
      return handler(ctx, caller.value);
    },
  };
}

/**
 * Counts each load of a route on `setup-status:ip` before the cookie check, so a caller with no
 * valid cookie costs a count too. The route stays a setup session route: the check runs after.
 */
function withStatusLimit(route: Route): Route {
  return {
    ...route,
    async handler(ctx) {
      if (!(await limit(ctx.config, "setup-status:ip", ipKey(ctx.ip), SETUP_STATUS_PER_IP)))
        return respond(fail("rate_limited"));
      return route.handler(ctx);
    },
  };
}

/**
 * The confirm page of a setup link. It reads no row and writes none, so a
 * mail scanner that fetches the link opens nothing (spec 6.1 item 5). The
 * person presses the button, and the browser posts the token to the open.
 * No script, so a scanner that runs JavaScript opens nothing either.
 */
function confirmPage(config: ResolvedConfig, token: string): string {
  const action = escapeHtml(`${config.basePath}/sso/setup/open`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>Set up single sign-on</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; background: #f6f6f6; color: #111; }
main { background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 4px rgba(0,0,0,0.12); text-align: center; max-width: 24rem; }
button { font: inherit; padding: 0.75rem 1.5rem; border: 0; border-radius: 0.375rem; background: #111; color: #fff; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>Set up single sign-on</h1>
<p>Press the button to start. Start only if a person of your company gave you this link.</p>
<form method="post" action="${action}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Start</button>
</form>
</main>
</body>
</html>
`;
}

/**
 * The page after a form open. It holds one link to the page of the setup
 * (`GET /sso/setup/status`). The link is a top-level GET, which carries the
 * cookie of `SameSite=Lax`.
 */
function openedPage(config: ResolvedConfig): string {
  const next = escapeHtml(`${config.basePath}/sso/setup/status`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<meta name="robots" content="noindex">
<title>Set up single sign-on</title>
</head>
<body>
<main>
<h1>The setup is open</h1>
<p><a href="${next}">Continue</a></p>
</main>
</body>
</html>
`;
}

/** The step that the page opens on when the person chose none: the first step that has work left. */
function firstOpenStep(
  link: SsoSetupLinkRow,
  have: { idp: boolean; draft: boolean; verified: boolean; passed: boolean; token: boolean },
  testRun: boolean,
): SetupPageStep {
  if (link.readyAt !== null) return "confirm";
  const has = (s: SetupStep) => link.steps.includes(s);
  if (has("connection") && testRun) return "test";
  if (has("connection") && !have.draft && !have.idp) return "idp";
  if (has("domain") && !have.verified) return "domain";
  if (has("connection") && !have.draft) return "connect";
  if (has("connection") && !have.passed) return "test";
  if (has("directory") && !have.token) return "directory";
  return "handback";
}

/**
 * Reads the rows of one setup session and builds the input of the page. It reads the rows of
 * the link only: its domains, its one draft, its pending token, and its runs. A run id of another
 * link answers `not_found` in `testRunResult`, and the page shows that code and no result.
 */
async function pageInput(
  config: ResolvedConfig,
  caller: SetupCaller,
  query: z.infer<typeof setupStatusQuery>,
): Promise<{ page: SetupPageInput; status: Record<string, unknown> }> {
  const { link, session } = caller;
  const linkIs = { field: "setupLinkId", op: "eq", value: link.id } as const;
  const [organization, domainRows, draftRow, tokenRow] = await Promise.all([
    config.storage.findOne("organization", [{ field: "id", op: "eq", value: link.organizationId }]),
    config.storage.findMany(
      "ssoDomain",
      [{ field: "organizationId", op: "eq", value: link.organizationId }, linkIs],
      { sort: { field: "id", dir: "asc" } },
    ),
    config.storage.findOne("ssoConnection", [linkIs, { field: "draft", op: "eq", value: true }]),
    config.storage.findOne("scimToken", [linkIs, { field: "pending", op: "eq", value: true }]),
  ]);
  const domains: SetupDomain[] = domainRows.map((row) => {
    const d = domainSummary(row);
    return { id: d.id, domain: d.domain, verified: d.verified, record: d.record };
  });
  let draft: DraftSummary | null = null;
  if (draftRow) {
    const c = publicConnection(config, draftRow);
    draft = {
      id: c.id,
      kind: c.kind,
      label: c.label,
      version: draftRow.version,
      issuer: c.oidc?.issuer ?? null,
      clientId: c.oidc?.clientId ?? null,
      ssoUrl: c.saml?.ssoUrl ?? null,
      idpEntityId: c.saml?.idpEntityId ?? null,
    };
  }

  // The run of the query, else the newest run of this link for the draft.
  let runId = query.run ?? null;
  if (runId === null && draftRow) {
    const [newest] = await config.storage.findMany(
      "ssoTestRun",
      [
        { field: "linkId", op: "eq", value: link.id },
        { field: "connectionId", op: "eq", value: draftRow.id },
      ],
      {
        sort: [
          { field: "createdAt", dir: "desc" },
          { field: "id", dir: "desc" },
        ],
        limit: 1,
      },
    );
    runId = newest?.id ?? null;
  }
  let test: TestSummary | null = null;
  let error: ErrorCode | null = null;
  if (runId !== null) {
    const result = await testRunResult(config, caller, runId);
    if (result.ok) {
      const r = result.value;
      test = {
        outcome: r.run.outcome,
        step: r.run.step,
        help: r.help,
        attributeNames: r.run.attributeNames,
        address: r.address,
        name: r.name,
        domainClaimed: r.run.domainClaimed,
        current: draftRow !== null && r.run.draftVersion === draftRow.version,
      };
    } else error = result.code;
  }

  let guide = query.idp === undefined ? null : guideOf(query.idp);
  if (guide !== null && !guide.kinds.some((k) => link.kinds.includes(k))) guide = null;
  // A saved draft with no choice of IdP keeps the generic guide of its kind.
  if (guide === null && draftRow)
    guide = guideOf(draftRow.kind === "saml" ? "generic-saml" : "generic-oidc");

  const sp = spValues(config, draftRow?.id ?? "");
  const values = {
    acsUrl: draftRow ? (sp.acsUrl ?? "") : "",
    entityId: draftRow ? (sp.entityId ?? "") : "",
    redirectUri: draftRow ? (sp.redirectUri ?? "") : "",
    scimBaseUrl: sp.scimBaseUrl ?? scimBase(config),
    scimToken: "",
  };

  const allowed = stepsOfLink(link.steps);
  const step: SetupPageStep =
    query.step !== undefined && allowed.includes(query.step)
      ? query.step
      : firstOpenStep(
          link,
          {
            idp: query.idp !== undefined,
            draft: draftRow !== null,
            verified: domains.some((d) => d.verified),
            passed: test?.outcome === "passed" && test.current,
            token: tokenRow !== null,
          },
          query.run !== undefined,
        );

  const page: SetupPageInput = {
    step,
    // One value for one session, and no other party can compute it: it hashes the secret of the session.
    csrf: await sha256Hex(`setup-csrf:${session.tokenHash}`),
    link: {
      organization: organization?.name ?? "",
      note: link.note,
      steps: link.steps,
      kinds: link.kinds,
    },
    guide,
    values,
    draft,
    test,
    error,
    domains,
    scim: tokenRow ? { hint: tokenRow.hint } : null,
  };
  // The JSON answer of the same rows (the contract of `GET /sso/setup/status`). The test result
  // is null for a run that is not a run of this link: the page shows its code, the JSON does not.
  const status = {
    link: {
      id: link.id,
      steps: link.steps,
      kinds: link.kinds,
      note: link.note,
      expiresAt: link.expiresAt.toISOString(),
      readyAt: link.readyAt?.toISOString() ?? null,
    },
    domains: domainRows.map(domainSummary),
    connection: draftRow ? publicConnection(config, draftRow) : null,
    scimToken: tokenRow ? { id: tokenRow.id, hint: tokenRow.hint } : null,
    test,
  };
  return { page, status };
}

/**
 * The routes of the setup link for its IT admin (plan 13a Task 3). They
 * exist when `sso.setup` is on. The routes of the setup session itself are
 * built with `setupSessionRoute` by the tasks that own them.
 */
export function ssoSetupRoutes(config: ResolvedConfig): Route[] {
  if (!config.sso || !config.sso.setup) return [];
  return [
    {
      method: "GET",
      path: "/sso/setup",
      key: "GET /sso/setup",
      handler: async (ctx) => {
        const query = readQuery(ctx.url, setupPageQuery);
        if (!query.ok) return respond(query);
        // The page reads no row, but each view costs a render: it counts on its own key.
        if (!(await limit(ctx.config, "setup-page:ip", ipKey(ctx.ip), SETUP_PAGE_PER_IP))) {
          setupRefused(ctx.config, "page_ip_limit");
          return respond(fail("rate_limited"));
        }
        return new Response(confirmPage(ctx.config, query.value.token), {
          status: 200,
          headers: pageHeaders(ctx.config, noScriptPagePolicy(ctx.config)),
        });
      },
    },
    {
      method: "POST",
      path: "/sso/setup/open",
      key: "POST /sso/setup/open",
      handler: async (ctx) => {
        const body = await readBody(ctx.request, setupOpenBody);
        if (!body.ok) return respond(body);
        const opened = await openSetupSession(ctx.config, body.value.token, {
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!opened.ok) return respond(opened);
        const headers = { "set-cookie": opened.value.cookie };
        if (isJsonRequest(ctx.request)) return json({ linkId: opened.value.linkId }, 200, headers);
        return new Response(openedPage(ctx.config), {
          status: 200,
          headers: { ...pageHeaders(ctx.config, noScriptPagePolicy(ctx.config)), ...headers },
        });
      },
    },
    withStatusLimit(
      // The page of the setup (Task 9). The ACS of a test sign-in answers 303 here with `run=<id>`.
      // A caller that asks for JSON (the client call) gets the rows of the same read (Task 11).
      setupSessionRoute("GET /sso/setup/status", async (ctx, caller) => {
        const query = readQuery(ctx.url, setupStatusQuery);
        if (!query.ok) return respond(query);
        const { page, status } = await pageInput(ctx.config, caller, query.value);
        if ((ctx.request.headers.get("accept") ?? "").toLowerCase().includes("application/json"))
          return json(status);
        return new Response(renderSetupPage(ctx.config, page), {
          status: 200,
          headers: pageHeaders(ctx.config, noScriptPagePolicy(ctx.config)),
        });
      }),
    ),
    ...linkRoutes(),
    ...sessionRoutes(),
  ];
}

/** The organization of a setup link, or null for an id with no row (`not_found`). */
async function linkOrganization(config: ResolvedConfig, id: string): Promise<string | null> {
  const row = await config.storage.findOne("ssoSetupLink", [{ field: "id", op: "eq", value: id }]);
  return row ? row.organizationId : null;
}

/**
 * The five routes of a manager for the setup links (plan 13a Task 11). Each runs `managedCall`:
 * the session, the `sso-manage:user` count, the body, the organization of the row, the manager
 * guard, then the act. A link of another organization answers `forbidden_rank` (ruling R8), and
 * an id with no row answers `not_found`. The body of each is at the floor (64 KiB).
 */
function linkRoutes(): Route[] {
  const meta = (ctx: RouteContext) => ({
    ip: ctx.ip,
    userAgent: ctx.request.headers.get("user-agent"),
  });
  const byId = (input: { id: string }, ctx: RouteContext) => linkOrganization(ctx.config, input.id);
  const idQuery = async (ctx: RouteContext) => readQuery(ctx.url, setupLinkIdQuery);
  return [
    {
      method: "POST",
      path: "/sso/setup-links/create",
      key: "POST /sso/setup-links/create",
      handler: (ctx) =>
        managedCall(
          ctx.config,
          ctx,
          async (c) => {
            const query = readQuery(c.url, setupLinkCreateQuery);
            if (!query.ok) return query;
            const body = await managedBody(setupLinkCreateBody)(c);
            if (!body.ok) return body;
            return ok({ ...body.value, organizationId: query.value.organizationId });
          },
          async (input) => input.organizationId,
          (actor, input) => createSetupLink(ctx.config, actor, input, meta(ctx)),
          (made) => json(made),
        ),
    },
    {
      method: "GET",
      path: "/sso/setup-links/list",
      key: "GET /sso/setup-links/list",
      handler: (ctx) =>
        managedCall(
          ctx.config,
          ctx,
          async (c) => readQuery(c.url, setupLinkListQuery),
          async (q) => q.organizationId,
          (actor, q) => listSetupLinks(ctx.config, actor, q.organizationId),
          (links) => json({ links }),
        ),
    },
    {
      method: "GET",
      path: "/sso/setup-links/get",
      key: "GET /sso/setup-links/get",
      handler: (ctx) =>
        managedCall(
          ctx.config,
          ctx,
          idQuery,
          (q) => byId(q, ctx),
          async (actor, q) => {
            const link = await getSetupLink(ctx.config, actor, q.id);
            if (!link.ok) return link;
            const preview = await previewSetup(ctx.config, actor, q.id);
            if (!preview.ok) return preview;
            return ok({ link: link.value, preview: preview.value });
          },
          (found) => json(found),
        ),
    },
    {
      method: "POST",
      path: "/sso/setup-links/revoke",
      key: "POST /sso/setup-links/revoke",
      handler: (ctx) =>
        managedCall(
          ctx.config,
          ctx,
          managedBody(setupLinkIdBody),
          (b) => byId(b, ctx),
          (actor, b) => revokeSetupLink(ctx.config, actor, b.id, meta(ctx)),
          () => json({ ok: true }),
        ),
    },
    {
      method: "POST",
      path: "/sso/setup-links/activate",
      key: "POST /sso/setup-links/activate",
      handler: (ctx) =>
        managedCall(
          ctx.config,
          ctx,
          managedBody(setupActivateBody),
          (b) => byId(b, ctx),
          async (actor, b) => {
            const link = await linkOrganization(ctx.config, b.id);
            // The row can go between the two reads: the engine answers `not_found` for it.
            const organizationId = link ?? "";
            return activateSetup(
              ctx.config,
              actor,
              b.id,
              b.version,
              async () => {
                const still = await recheckSsoManager(ctx.config, actor, organizationId);
                return still.ok ? ok(undefined) : still;
              },
              meta(ctx),
            );
          },
          (connection) => json({ connection }),
        ),
    },
  ];
}

/**
 * The five routes of a setup session that write (plan 13a Task 11). Each is built with
 * `setupSessionRoute`, so the cookie check runs before the handler and before any body read. The
 * body of each is JSON only, as the contract says. The connection route has a cap of 4 MiB
 * (`BODY_CAPS`, ruling R5). The engine counts each write on `setup-draft:link` after the read.
 */
function sessionRoutes(): Route[] {
  const meta = (ctx: RouteContext) => ({
    ip: ctx.ip,
    userAgent: ctx.request.headers.get("user-agent"),
  });
  return [
    setupSessionRoute("POST /sso/setup/domains/add", async (ctx, caller) => {
      const body = await managedBody(setupDomainAddBody)(ctx);
      if (!body.ok) return respond(body);
      const r = await addSetupDomain(ctx.config, caller, body.value.domain, meta(ctx));
      return r.ok ? json({ domain: r.value }) : respond(r);
    }),
    setupSessionRoute("POST /sso/setup/domains/verify", async (ctx, caller) => {
      const body = await managedBody(domainIdBody)(ctx);
      if (!body.ok) return respond(body);
      const r = await verifySetupDomain(ctx.config, caller, body.value.id, meta(ctx));
      return r.ok ? json({ domain: r.value }) : respond(r);
    }),
    setupSessionRoute("POST /sso/setup/connection", async (ctx, caller) => {
      const body = await managedBody(setupConnectionBody)(ctx);
      if (!body.ok) return respond(body);
      const r = await saveDraftConnection(ctx.config, caller, body.value, meta(ctx));
      return r.ok ? json({ connection: r.value }) : respond(r);
    }),
    setupSessionRoute("POST /sso/setup/scim-token", async (ctx, caller) => {
      const r = await createPendingScimToken(ctx.config, caller, meta(ctx));
      if (!r.ok) return respond(r);
      return json({ id: r.value.id, token: r.value.token, scimBaseUrl: scimBase(ctx.config) });
    }),
    setupSessionRoute("POST /sso/setup/handback", async (ctx, caller) => {
      const r = await handBack(ctx.config, caller);
      return r.ok ? json({ ok: true }) : respond(r);
    }),
  ];
}
