import { vi } from "vitest";

/**
 * The one node:fs call of the recorder. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck (as entries.test.ts does).
 */
interface AppendFs {
  appendFileSync(file: URL, text: string): void;
}
const FS_MODULE = "node:fs";

/**
 * The answer recorder of plan 11g Task 5. It wraps `createRouter` in every
 * test file of core, so each answer of the router gets one line in
 * `.answers/<pid>-<worker>.jsonl`. The line holds the route's key, the
 * status, the content type, the code, and a verdict. The check run
 * (`vitest.answers.config.ts`) reads the lines. The answer itself does not change.
 *
 * The verdict is `ok`, or one failure text, by three rules:
 * 1. A code is in the entry's `codes` or `oauthCodes`, or in `ROUTER_CODES`,
 *    or is `HOST_CODE` (plan 12i Task 18), with the status of its table. A redirect carries its code in `Location`.
 *    `BODY_CODE` (ruling 43 of the 12j lane) holds only for a route with a body in its contract.
 * 2. A 2xx JSON body parses under the strict answer schema of the contract.
 * 3. The content type fits a kind of the contract: JSON for `json` and
 *    `metadata`, HTML for `html`, a redirect with `Location` for `redirect`.
 *    The `saml-metadata` standard of `metadata` answers its own XML type.
 *    A redirect has the status of its kind: a 302, or the 303 that the kind
 *    names. A redirect that carries a code is a 302.
 * 4. A route that takes `clientSecretBasic` answers `invalid_client` after
 *    an `Authorization` header as a 401 with a Basic challenge. With no
 *    header it answers a 400 with no challenge (plan 12e, ruling 19).
 * 5. A route that takes `dpopAccessToken` answers `invalid_dpop_proof` as a
 *    401 with a `DPoP error="invalid_dpop_proof"` challenge (plan 12e,
 *    ruling 31; RFC 7235 section 3.1 asks a challenge of each 401).
 * 6. A JSON error body holds only the keys of its table's error schema in
 *    the OpenAPI document (plan 12h Task 8). So the body of a 503 `not_ready`
 *    cannot gain a key, such as the name of the error, with no sign.
 * 7. A route of the `scim` kind (plan 12d) answers `application/scim+json`
 *    with `cache-control: no-store`. A failure is the SCIM error message of
 *    RFC 7644 section 3.12. It holds the Error URN and the status as its
 *    string. A `scimType` is one of the entry's `scimTypes`, with the status
 *    of `SCIM_ERRORS`.
 *    A 401 carries `Bearer realm="scim"`. A 2xx parses under the schema.
 *    A 204 of a DELETE, or of a Group PATCH, carries no body and no type.
 *    The record's code is the `scimType`, or null.
 * An answer for a path of no route has the key `null` and the verdict `ok`.
 */
vi.mock("../../src/http/router.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/http/router.js")>();
  const { appendFileSync }: AppendFs = await import(/* @vite-ignore */ FS_MODULE);
  const { shapeVerdict } = await import("./answer-shape.js");
  const { DPOP_PROOF_AT_RESOURCE, ERRORS, INVALID_CLIENT_NO_HEADER, OAUTH_ERRORS, SCIM_ERRORS } =
    await import("../../src/errors.js");
  const { ROUTE_CONTRACT } = await import("../../src/http/contract/index.js");
  const { ERROR_SCHEMAS } = await import("../../src/openapi/responses.js");
  const { answerKinds } = await import("../../src/http/contract/types.js");
  const { routeKeyOf } = await import("../../src/http/route-key.js");
  const { BODY_CODE, HOST_CODE, ROUTER_CODES, ROUTES } = await import(
    "../../src/http/route-list.js"
  );
  type RouteContract = import("../../src/http/contract/types.js").RouteContract;
  type AnswerKind = RouteContract["answer"];
  type RouteKey = import("../../src/http/route-list.js").RouteKey;
  type RouteEntry = import("../../src/http/route-list.js").RouteEntry;

  // One file per worker process: vitest sets VITEST_WORKER_ID in each one.
  const node = (
    globalThis as { process?: { pid: number; env: Record<string, string | undefined> } }
  ).process;
  const FILE = new URL(
    `../../.answers/${node?.pid ?? 0}-${node?.env.VITEST_WORKER_ID ?? "0"}.jsonl`,
    import.meta.url,
  );
  // RouteEntry, not the frozen literals of ROUTES: a read of `auth` then takes any AuthForm.
  const ENTRIES = new Map<string, RouteEntry>(ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
  const CONTRACT: Record<string, RouteContract> = ROUTE_CONTRACT;
  // The host code of a baseURL list: any route answers it, and no entry declares it.
  const ROUTER = new Set<string>([...ROUTER_CODES, HOST_CODE]);
  /**
   * The keys of an error body beside `error`, for each code that has one
   * (ruling 7 of plan 12h). `message` is on hook_refused, and on the
   * invalid_body of an SSO or SCIM manager write (plan 12d). `reason` is
   * only on not_ready, and `detail` only on sso_required (plan 12d).
   */
  const CODE_KEYS: Readonly<Record<string, readonly string[]>> = {
    hook_refused: ["message"],
    not_ready: ["reason"],
    invalid_body: ["message"],
    sso_required: ["detail"],
  };

  interface AnswerRecord {
    key: string | null;
    status: number;
    type: string;
    code: string | null;
    verdict: string;
    /** The paths of the answer schema that a 2xx JSON body leaves out (ruling 8). */
    absent: string[];
    /** The paths that a 2xx JSON body sets to null. */
    nulls: string[];
  }

  /** The shape of a 2xx JSON answer beside its verdict: the keys left out, and the keys set null. */
  type JsonJudged = import("./answer-shape.js").ShapeJudged;
  const NO_SHAPE = { absent: [], nulls: [] };

  /**
   * The key of the mounted route, or the entry of ROUTES whose feature is off
   * (the router's `not_found`), or null. The router's own matcher finds the
   * mounted route, so a parameter route records its key (plan 12d Task 4).
   */
  function keyOf(
    config: import("../../src/config.js").ResolvedConfig,
    matchRoute: ReturnType<typeof m.createRouteMatcher>,
    method: string,
    pathname: string,
  ): string | null {
    const mounted = matchRoute(method, pathname)?.route;
    if (mounted) return mounted.key ?? null;
    if (!pathname.startsWith(config.basePath)) return null;
    const key = routeKeyOf(method, pathname.slice(config.basePath.length));
    return ENTRIES.has(key) ? key : null;
  }

  function kinds(contract: RouteContract): readonly AnswerKind[] {
    return answerKinds(contract);
  }

  /** Rule 1: the code is declared for the route, with the status of its table (a redirect has none). */
  function codeVerdict(key: RouteKey, code: string, status: number, redirected: boolean): string {
    const entry = ENTRIES.get(key);
    if (!entry) return `no entry for ${key}`;
    const statuses: number[] = [];
    if ((entry.codes as readonly string[]).includes(code))
      statuses.push(ERRORS[code as keyof typeof ERRORS]);
    // Rule 5: a route of a bound token answers invalid_dpop_proof as a 401 (ruling 31 of plan 12e).
    if ((entry.oauthCodes as readonly string[]).includes(code))
      statuses.push(
        code === "invalid_dpop_proof" && entry.auth.includes("dpopAccessToken")
          ? DPOP_PROOF_AT_RESOURCE
          : OAUTH_ERRORS[code as keyof typeof OAUTH_ERRORS],
      );
    // Rule 4: with no Authorization header, invalid_client is a 400 at a route of client auth.
    if (code === "invalid_client" && entry.auth.includes("clientSecretBasic"))
      statuses.push(INVALID_CLIENT_NO_HEADER);
    if (ROUTER.has(code)) statuses.push(ERRORS[code as keyof typeof ERRORS]);
    if (code === BODY_CODE && CONTRACT[key]?.body !== undefined) statuses.push(ERRORS[BODY_CODE]);
    if (statuses.length === 0) return `the code ${code} is not declared`;
    if (redirected) return "ok";
    if (!statuses.includes(status))
      return `the code ${code} answered ${status}, its table says ${statuses.join(" or ")}`;
    return "ok";
  }

  /** Rule 2: a 2xx JSON body parses under the strict schema of the `json` kind with that status. */
  function jsonVerdict(contract: RouteContract, status: number, body: unknown): JsonJudged {
    const json = kinds(contract).filter((k) => k.kind === "json");
    const fit = json.find((k) => (k.status ?? 200) === status);
    if (!fit) {
      if (kinds(contract).some((k) => k.kind === "metadata")) return { verdict: "ok", ...NO_SHAPE };
      return { verdict: `a ${status} JSON answer fits no kind of the contract`, ...NO_SHAPE };
    }
    const parsed = fit.schema.safeParse(body);
    // The shape of the answer, so the check can hold the optional and nullable keys to the wire.
    if (parsed.success) return shapeVerdict(fit.schema, body);
    const verdict = parsed.error.issues
      .map((i) => {
        const where = "keys" in i ? (i.keys as string[]).join(",") : i.path.join(".");
        return `${where}: ${i.message}`;
      })
      .join("; ");
    return { verdict, ...NO_SHAPE };
  }

  const NS_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

  /** Rule 7: a SCIM answer, judged by the SCIM error message or by the schema of its kind. */
  function scimVerdict(
    key: string,
    res: Response,
    body: unknown,
    schema: import("zod").ZodType | null,
  ): { code: string | null; verdict: string } {
    if (res.headers.get("cache-control") !== "no-store")
      return { code: null, verdict: "a SCIM answer is not no-store" };
    const status = res.status;
    if (status < 400) {
      if (schema === null) return { code: null, verdict: `a ${status} answer of a 501 route` };
      const parsed = schema.safeParse(body);
      return { code: null, verdict: parsed.success ? "ok" : parsed.error.message };
    }
    const e = body as { schemas?: unknown; status?: unknown; scimType?: unknown; detail?: unknown };
    const keys = Object.keys(e).sort().join(",");
    if (keys !== "detail,schemas,status" && keys !== "detail,schemas,scimType,status")
      return { code: null, verdict: `the SCIM error holds the keys ${keys}` };
    if (JSON.stringify(e.schemas) !== JSON.stringify([NS_ERROR]) || typeof e.detail !== "string")
      return { code: null, verdict: "the SCIM error has no Error URN or no detail" };
    if (e.status !== String(status))
      return { code: null, verdict: `the SCIM error says status ${String(e.status)}` };
    if (status === 401 && res.headers.get("www-authenticate") !== 'Bearer realm="scim"')
      return { code: null, verdict: "a SCIM 401 carries no Bearer realm challenge" };
    if (e.scimType === undefined) return { code: null, verdict: "ok" };
    const type = String(e.scimType);
    const declared = (ENTRIES.get(key)?.scimTypes ?? []) as readonly string[];
    if (!declared.includes(type))
      return { code: type, verdict: `the scimType ${type} is not declared` };
    if (SCIM_ERRORS[type as keyof typeof SCIM_ERRORS] !== status)
      return { code: type, verdict: `the scimType ${type} answered ${status}` };
    return { code: type, verdict: "ok" };
  }

  /**
   * The answer of one request. `carried` is the code that a redirect carries
   * to the app or to the OAuth client. The rule of the router gives it
   * (`redirectCode`, ruling 16 of plan 12h).
   */
  async function judge(
    request: Request,
    res: Response,
    key: string | null,
    carried: string | null,
  ): Promise<AnswerRecord> {
    const status = res.status;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    const redirected = status === 302 || status === 303;
    let code: string | null = null;
    let body: unknown;
    if (redirected) code = carried;
    else if (type === "application/json") {
      body = await res.json();
      const error = (body as { error?: unknown }).error;
      if (status >= 400 && typeof error === "string") code = error;
    }
    const base = { key, status, type, code, ...NO_SHAPE };
    if (key === null) return { ...base, verdict: "ok" };
    const contract = CONTRACT[key];
    if (!contract) return { ...base, verdict: `no contract for ${key}` };
    // Rule 6: a SCIM delete answers 204 with no body and no type (RFC 7644 section 3.6).
    // A Group PATCH answers 204 too, unless its query asks for attributes (plan 12d
    // Task 11 Behavior 4, ruling 53 P10).
    if (status === 204 && contract.answer.kind === "scim") {
      const text = await res.text();
      const bare = text === "" && res.headers.get("content-type") === null;
      const verdict =
        request.method !== "DELETE" && key !== "PATCH /scim/v2/Groups/:id"
          ? "a SCIM 204 answers a method that is not DELETE"
          : !bare
            ? "a SCIM 204 carries a body or a type"
            : res.headers.get("cache-control") !== "no-store"
              ? "a SCIM answer is not no-store"
              : "ok";
      return { ...base, verdict };
    }
    if (type === "application/scim+json") {
      if (contract.answer.kind !== "scim")
        return { ...base, verdict: "a SCIM answer fits no kind of the contract" };
      const judged = scimVerdict(key, res, await res.json(), contract.answer.schema);
      return { ...base, ...judged };
    }
    const allowed = kinds(contract);
    if (redirected) {
      const redirects = allowed.filter((k) => k.kind === "redirect");
      if (redirects.length === 0)
        return { ...base, verdict: "a redirect fits no kind of the contract" };
      // Rule 3: the status of the kind, and 302 for a redirect with a code.
      const statuses = code === null ? redirects.map((k) => k.status ?? 302) : [302];
      if (!statuses.includes(status))
        return {
          ...base,
          verdict: `a ${status} redirect, the contract says ${statuses.join(" or ")}`,
        };
      if (code === null) return { ...base, verdict: "ok" };
      return { ...base, verdict: codeVerdict(key as RouteKey, code, status, true) };
    }
    const challenge = res.headers.get("www-authenticate");
    if (code === "invalid_client" && ENTRIES.get(key)?.auth.includes("clientSecretBasic")) {
      // Rule 4: the request decides the status (RFC 6749 section 5.2).
      if (request.headers.has("authorization")) {
        if (status !== OAUTH_ERRORS.invalid_client)
          return { ...base, verdict: `an invalid_client after a header answered ${status}` };
        if (!(challenge ?? "").startsWith("Basic realm="))
          return { ...base, verdict: "an invalid_client 401 carries no Basic challenge" };
      } else {
        if (status !== INVALID_CLIENT_NO_HEADER)
          return { ...base, verdict: `an invalid_client with no header answered ${status}` };
        if (challenge !== null)
          return { ...base, verdict: "an invalid_client 400 carries a challenge" };
      }
    }
    // Rule 5: the 401 of a bad proof at a route of a bound token names its error in the DPoP challenge.
    if (
      code === "invalid_dpop_proof" &&
      ENTRIES.get(key)?.auth.includes("dpopAccessToken") &&
      !/(^|,\s*)DPoP error="invalid_dpop_proof"/.test(challenge ?? "")
    )
      return { ...base, verdict: "an invalid_dpop_proof 401 carries no DPoP error challenge" };
    if (code !== null) {
      // Rule 6: error, and the keys of CODE_KEYS for this code alone. Each key
      // must also be in the error schema of the code's table.
      const oauth = (ENTRIES.get(key)?.oauthCodes as readonly string[] | undefined)?.includes(code);
      const schemaKeys = Object.keys(
        (oauth ? ERROR_SCHEMAS.OAuthError : ERROR_SCHEMAS.Error).properties,
      );
      const allowedKeys = ["error", ...(CODE_KEYS[code] ?? [])].filter((k) =>
        schemaKeys.includes(k),
      );
      const extra = Object.keys(body as object).filter((k) => !allowedKeys.includes(k));
      if (extra.length > 0)
        return {
          ...base,
          verdict: `the ${code} body has the keys ${extra.join(", ")} that this code does not carry`,
        };
      return { ...base, verdict: codeVerdict(key as RouteKey, code, status, false) };
    }
    if (status >= 400) return { ...base, verdict: `a ${status} ${type} answer carries no code` };
    if (type === "application/json") return { ...base, ...jsonVerdict(contract, status, body) };
    if (type === "text/html") {
      if (allowed.some((k) => k.kind === "html")) return { ...base, verdict: "ok" };
      return { ...base, verdict: "an HTML answer fits no kind of the contract" };
    }
    // The SP metadata of a SAML connection is XML (plan 12d Task 8, SAML Metadata 2.0 section 4.1.1).
    if (type === "application/samlmetadata+xml" && status === 200) {
      if (allowed.some((k) => k.kind === "metadata" && k.standard === "saml-metadata"))
        return { ...base, verdict: "ok" };
      return { ...base, verdict: "a SAML metadata answer fits no kind of the contract" };
    }
    return { ...base, verdict: `a ${status} ${type} answer fits no kind of the contract` };
  }

  return {
    ...m,
    createRouter: (...a: Parameters<typeof m.createRouter>) => {
      const handle = m.createRouter(...a);
      const [config, routes] = a;
      const matchRoute = m.createRouteMatcher(config, routes);
      // The options carry the `waitUntil` of the work after the answer (ruling 23 of plan 12i).
      return async (request: Request, options?: Parameters<typeof handle>[1]) => {
        const res = await handle(request, options);
        const key = keyOf(config, matchRoute, request.method, new URL(request.url).pathname);
        // The mark of `errorRedirect` is on res, not on its clone.
        const record = await judge(request, res.clone(), key, m.redirectCode(res));
        appendFileSync(FILE, `${JSON.stringify(record)}\n`);
        return res;
      };
    },
  };
});
