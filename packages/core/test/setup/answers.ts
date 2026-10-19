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
 *    with the status of its table. A redirect carries its code in `Location`.
 * 2. A 2xx JSON body parses under the strict answer schema of the contract.
 * 3. The content type fits a kind of the contract: JSON for `json` and
 *    `metadata`, HTML for `html`, a 302 with `Location` for `redirect`.
 * An answer for a path of no route has the key `null` and the verdict `ok`.
 */
vi.mock("../../src/http/router.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/http/router.js")>();
  const { appendFileSync }: AppendFs = await import(/* @vite-ignore */ FS_MODULE);
  const { shapeOf } = await import("./answer-shape.js");
  const { ERRORS, OAUTH_ERRORS } = await import("../../src/errors.js");
  const { ROUTE_CONTRACT } = await import("../../src/http/contract/index.js");
  const { AUTH_ERROR_PARAM } = await import("../../src/http/redirect.js");
  const { routeKeyOf } = await import("../../src/http/route-key.js");
  const { ROUTER_CODES, ROUTES } = await import("../../src/http/route-list.js");
  type RouteContract = import("../../src/http/contract/types.js").RouteContract;
  type AnswerKind = RouteContract["answer"];
  type RouteKey = import("../../src/http/route-list.js").RouteKey;

  // One file per worker process: vitest sets VITEST_WORKER_ID in each one.
  const node = (
    globalThis as { process?: { pid: number; env: Record<string, string | undefined> } }
  ).process;
  const FILE = new URL(
    `../../.answers/${node?.pid ?? 0}-${node?.env.VITEST_WORKER_ID ?? "0"}.jsonl`,
    import.meta.url,
  );
  const ENTRIES = new Map(ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
  const CONTRACT: Record<string, RouteContract> = ROUTE_CONTRACT;
  const ROUTER = new Set<string>(ROUTER_CODES);

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
  interface JsonJudged {
    verdict: string;
    absent: string[];
    nulls: string[];
  }
  const NO_SHAPE = { absent: [], nulls: [] };

  /** The key of the mounted route, or the entry of ROUTES whose feature is off (the router's `not_found`), or null. */
  function keyOf(
    config: import("../../src/config.js").ResolvedConfig,
    routes: readonly import("../../src/http/router.js").Route[],
    method: string,
    pathname: string,
  ): string | null {
    const mounted = routes.find(
      (r) => r.method === method && config.basePath + r.path === pathname,
    );
    if (mounted) return mounted.key ?? null;
    if (!pathname.startsWith(config.basePath)) return null;
    const key = routeKeyOf(method, pathname.slice(config.basePath.length));
    return ENTRIES.has(key) ? key : null;
  }

  function kinds(contract: RouteContract): AnswerKind[] {
    return contract.alt ? [contract.answer, contract.alt] : [contract.answer];
  }

  /** The code that a redirect carries to the app or to the OAuth client, or null. */
  function redirectCode(res: Response, requestUrl: string): string | null {
    const location = new URL(res.headers.get("location") ?? "", requestUrl);
    return location.searchParams.get(AUTH_ERROR_PARAM) ?? location.searchParams.get("error");
  }

  /** Rule 1: the code is declared for the route, with the status of its table (a redirect has none). */
  function codeVerdict(key: RouteKey, code: string, status: number, redirected: boolean): string {
    const entry = ENTRIES.get(key);
    if (!entry) return `no entry for ${key}`;
    const statuses: number[] = [];
    if ((entry.codes as readonly string[]).includes(code))
      statuses.push(ERRORS[code as keyof typeof ERRORS]);
    if ((entry.oauthCodes as readonly string[]).includes(code))
      statuses.push(OAUTH_ERRORS[code as keyof typeof OAUTH_ERRORS]);
    if (ROUTER.has(code)) statuses.push(ERRORS[code as keyof typeof ERRORS]);
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
    if (parsed.success) return { verdict: "ok", ...shapeOf(fit.schema, body) };
    const verdict = parsed.error.issues
      .map((i) => {
        const where = "keys" in i ? (i.keys as string[]).join(",") : i.path.join(".");
        return `${where}: ${i.message}`;
      })
      .join("; ");
    return { verdict, ...NO_SHAPE };
  }

  async function judge(request: Request, res: Response, key: string | null): Promise<AnswerRecord> {
    const status = res.status;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    const redirected = status === 302 || status === 303;
    let code: string | null = null;
    let body: unknown;
    if (redirected) code = redirectCode(res, request.url);
    else if (type === "application/json") {
      body = await res.json();
      const error = (body as { error?: unknown }).error;
      if (status >= 400 && typeof error === "string") code = error;
    }
    const base = { key, status, type, code, ...NO_SHAPE };
    if (key === null) return { ...base, verdict: "ok" };
    const contract = CONTRACT[key];
    if (!contract) return { ...base, verdict: `no contract for ${key}` };
    const allowed = kinds(contract);
    if (redirected) {
      if (!allowed.some((k) => k.kind === "redirect"))
        return { ...base, verdict: "a redirect fits no kind of the contract" };
      if (code === null) return { ...base, verdict: "ok" };
      return { ...base, verdict: codeVerdict(key as RouteKey, code, status, true) };
    }
    if (code !== null)
      return { ...base, verdict: codeVerdict(key as RouteKey, code, status, false) };
    if (status >= 400) return { ...base, verdict: `a ${status} ${type} answer carries no code` };
    if (type === "application/json") return { ...base, ...jsonVerdict(contract, status, body) };
    if (type === "text/html") {
      if (allowed.some((k) => k.kind === "html")) return { ...base, verdict: "ok" };
      return { ...base, verdict: "an HTML answer fits no kind of the contract" };
    }
    return { ...base, verdict: `a ${status} ${type} answer fits no kind of the contract` };
  }

  return {
    ...m,
    createRouter: (...a: Parameters<typeof m.createRouter>) => {
      const handle = m.createRouter(...a);
      const [config, routes] = a;
      return async (request: Request) => {
        const res = await handle(request);
        const key = keyOf(config, routes, request.method, new URL(request.url).pathname);
        const record = await judge(request, res.clone(), key);
        appendFileSync(FILE, `${JSON.stringify(record)}\n`);
        return res;
      };
    },
  };
});
