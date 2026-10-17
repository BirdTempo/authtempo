import { type Fetcher, fetchWithin, HostError, isLocalHost } from "./net.js";

// The checks of `authtempo check` (spec 19). This file and its imports use
// no Node.js module, so a Worker test runs them in workerd. Every request
// is public: no credential goes out, and no row is written, except the
// first signing key that core writes at the first JWKS read.

export const CHECK_IDS = [
  "https",
  "mount",
  "origin_rule",
  "cookie",
  "jwks",
  "well_known",
  "schema_version",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  /** The failure code, or the skip reason; null for a pass. */
  code: string | null;
  detail: string;
}

export interface CheckReport {
  base: string;
  checks: CheckResult[];
  /** Lines that start with a warning code, such as `cookie_samesite_none: …`. A warning is no failure. */
  warnings: string[];
  summary: { run: number; pass: number; fail: number; skip: number };
}

/** The codes of each check: a failure, a warning, or a skip reason. The check page has one anchor for each. */
export const CHECK_CODES = {
  https: { fail: ["base_not_https"], warn: [], skip: [] },
  mount: { fail: ["mount_missing", "mount_wrong_answer"], warn: [], skip: [] },
  origin_rule: { fail: ["origin_not_enforced"], warn: [], skip: ["no_mount"] },
  cookie: {
    fail: [
      "cookie_missing",
      "cookie_not_httponly",
      "cookie_not_secure",
      "cookie_path_not_root",
      "cookie_no_samesite",
    ],
    warn: ["cookie_samesite_none"],
    skip: ["no_mount"],
  },
  jwks: {
    fail: [
      "jwks_bad_answer",
      "jwks_empty",
      "jwks_private_part",
      "jwks_bad_key",
      "jwks_no_cache_control",
      "jwks_cache_not_public",
    ],
    warn: [],
    skip: ["no_mount", "jwt_mint_off"],
  },
  well_known: {
    fail: [
      "well_known_bad_answer",
      "well_known_mismatch",
      "well_known_issuer",
      "well_known_jwks_uri",
      "well_known_not_at_root",
    ],
    warn: [],
    skip: ["oauth_off"],
  },
  schema_version: {
    fail: ["schema_missing", "schema_behind", "schema_ahead"],
    warn: [],
    skip: ["no_database"],
  },
} as const satisfies Record<
  CheckId,
  { fail: readonly string[]; warn: readonly string[]; skip: readonly string[] }
>;

/** Every code once: the failure codes, the warning codes, and the skip reasons. */
export const ALL_CHECK_CODES: readonly string[] = [
  ...new Set(Object.values(CHECK_CODES).flatMap((c) => [...c.fail, ...c.warn, ...c.skip])),
];

export interface CheckInput {
  /** The origin of the deployment, such as https://api.example.com. */
  base: string;
  basePath: string;
  fetch: Fetcher;
  timeoutMs: number;
  /** The schema version that the caller's core needs. */
  schemaVersion: number;
  /** Reads the schema version of the database. Absent: the schema check skips. */
  readSchema?: () => Promise<number | null>;
  /** Each skip counts as a failure. */
  strict?: boolean;
}

/**
 * The cap of one body read. Core answers each check with a few hundred
 * bytes, and a hostile host could stream data until the time limit ends.
 */
export const BODY_CAP_BYTES = 64 * 1024;

/**
 * The body of an answer as text, read to its end, so no stream stays open.
 * A read fault gives "". A body over BODY_CAP_BYTES stops the run with a
 * fixed text that names the request and the cap, never the body.
 */
async function textOf(res: Response, request: string): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_CAP_BYTES) {
        await reader.cancel().catch(() => {});
        throw new HostError(
          `${request}: the answer body is over ${BODY_CAP_BYTES / 1024} KiB, the cap of one read`,
        );
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof HostError) throw e;
    return "";
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

async function jsonOf(res: Response, request: string): Promise<Record<string, unknown> | null> {
  const text = await textOf(res, request);
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/** The SameSite values of a cookie (RFC 6265bis). A cookie with none of them gets the browser's default. */
const SAME_SITE = ["lax", "strict", "none"] as const;

/**
 * A cache-control that lets a verifier and a shared cache hold the key set:
 * `public` and a `max-age` above 0, as core sends (`public, max-age=300`,
 * packages/core/src/http/routes/jwt.ts). A ruling of the review of plan 11c
 * Task 8: `no-store`, `private`, or `max-age=0` makes each verifier fetch
 * the keys on each token.
 */
function sharedCache(value: string): boolean {
  const parts = value.split(",").map((p) => p.trim().toLowerCase());
  const maxAge = parts.find((p) => p.startsWith("max-age="))?.slice("max-age=".length);
  return (
    parts.includes("public") &&
    !parts.includes("no-store") &&
    maxAge !== undefined &&
    /^\d+$/.test(maxAge) &&
    Number(maxAge) > 0
  );
}

/** A public signing key as core serves it: a kid, EdDSA or ES256, and use sig. */
const goodKey = (k: Record<string, unknown>) =>
  typeof k.kid === "string" && (k.alg === "EdDSA" || k.alg === "ES256") && k.use === "sig";

/**
 * Runs the seven checks in the order of CHECK_IDS. A host that gives no HTTP
 * answer throws a HostError (exit 2); every answer is a result. The function
 * fails itself when it reports another list than CHECK_IDS, so a check that
 * does not run cannot pass in silence.
 */
export async function runChecks(input: CheckInput): Promise<CheckReport> {
  const { base, basePath } = input;
  const auth = `${base}${basePath}`;
  const results: CheckResult[] = [];
  const warnings: string[] = [];
  const add = (id: CheckId, status: CheckStatus, code: string | null, detail: string) => {
    results.push({ id, status, code, detail });
  };
  const get = (url: string) =>
    fetchWithin(input.fetch, url, { headers: { accept: "application/json" } }, input.timeoutMs);
  const post = (url: string, headers: Record<string, string>) =>
    fetchWithin(
      input.fetch,
      url,
      { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" },
      input.timeoutMs,
    );

  const host = new URL(base);
  if (host.protocol === "https:") add("https", "pass", null, `${base} uses https`);
  else if (isLocalHost(host.hostname))
    add("https", "pass", null, `${base} is on this machine; a deploy needs https`);
  else
    add(
      "https",
      "fail",
      "base_not_https",
      `${base} uses http; the session cookie is Secure, so a browser drops it`,
    );

  const session = await get(`${auth}/session`);
  const sessionType = session.headers.get("content-type") ?? "";
  const sessionBody = await jsonOf(session, `GET ${auth}/session`);
  const mount =
    session.status === 404 || !sessionType.includes("application/json") || sessionBody === null
      ? "mount_missing"
      : session.status === 401 && sessionBody.error === "unauthorized"
        ? null
        : "mount_wrong_answer";
  if (mount === null) add("mount", "pass", null, `GET ${auth}/session answers 401 JSON`);
  else if (mount === "mount_missing")
    add(
      "mount",
      "fail",
      mount,
      `GET ${auth}/session answers ${session.status} with no core JSON: the routes are not at ${basePath}`,
    );
  else
    add(
      "mount",
      "fail",
      mount,
      `GET ${auth}/session answers ${session.status}; core answers 401 with no credential`,
    );

  if (mount !== null) {
    for (const id of ["origin_rule", "cookie", "jwks"] as const)
      add(id, "skip", "no_mount", `the routes are not at ${auth}`);
  } else {
    const foreign = await post(`${auth}/sign-out`, { origin: "https://check.invalid" });
    await textOf(foreign, `POST ${auth}/sign-out`);
    if (foreign.status === 403)
      add("origin_rule", "pass", null, "a POST from an untrusted origin answers 403");
    else
      add(
        "origin_rule",
        "fail",
        "origin_not_enforced",
        `a POST with Origin https://check.invalid answers ${foreign.status}; core answers 403`,
      );

    // A sign-out with no cookie and no Origin touches no row and answers the clear cookie (routes/sessions.ts).
    const out = await post(`${auth}/sign-out`, {});
    await textOf(out, `POST ${auth}/sign-out`);
    const cookie = out.status === 200 ? out.headers.getSetCookie()[0] : undefined;
    if (cookie === undefined)
      add(
        "cookie",
        "fail",
        "cookie_missing",
        `POST ${auth}/sign-out answers ${out.status} with no Set-Cookie`,
      );
    else {
      const name = cookie.split("=")[0] ?? "";
      const attrs = cookie.split(";").map((a) => a.trim().toLowerCase());
      if (!attrs.includes("httponly"))
        add("cookie", "fail", "cookie_not_httponly", `the cookie ${name} has no HttpOnly`);
      else if (!attrs.includes("secure"))
        add("cookie", "fail", "cookie_not_secure", `the cookie ${name} has no Secure`);
      else if (!attrs.includes("path=/"))
        add("cookie", "fail", "cookie_path_not_root", `the cookie ${name} has no Path=/`);
      else if (!SAME_SITE.some((v) => attrs.includes(`samesite=${v}`)))
        add(
          "cookie",
          "fail",
          "cookie_no_samesite",
          `the cookie ${name} has no SameSite of Lax, Strict, or None; core sets SameSite`,
        );
      else {
        if (attrs.includes("samesite=none"))
          warnings.push(
            `cookie_samesite_none: the cookie ${name} is SameSite=None; keep it only for an app on another site`,
          );
        add(
          "cookie",
          "pass",
          null,
          `the cookie ${name} is HttpOnly, Secure, Path=/, and has SameSite`,
        );
      }
    }

    const jwks = await get(`${auth}/jwks`);
    if (jwks.status === 404) {
      await textOf(jwks, `GET ${auth}/jwks`);
      add("jwks", "skip", "jwt_mint_off", `GET ${auth}/jwks answers 404: jwtMint is false`);
    } else {
      const cache = jwks.headers.get("cache-control");
      const body = await jsonOf(jwks, `GET ${auth}/jwks`);
      const keys = body && Array.isArray(body.keys) ? (body.keys as unknown[]) : null;
      const records = keys?.filter(isRecord) ?? [];
      if (jwks.status !== 200 || keys === null)
        add(
          "jwks",
          "fail",
          "jwks_bad_answer",
          `GET ${auth}/jwks answers ${jwks.status} with no key set`,
        );
      else if (keys.length === 0) add("jwks", "fail", "jwks_empty", "the key set holds no key");
      else if (records.some((k) => "d" in k))
        add("jwks", "fail", "jwks_private_part", "a key of the key set holds a private part (d)");
      else if (records.length !== keys.length || !records.every(goodKey))
        add(
          "jwks",
          "fail",
          "jwks_bad_key",
          "a key has no kid, no alg of EdDSA or ES256, or no use of sig",
        );
      else if (!cache)
        add("jwks", "fail", "jwks_no_cache_control", "the key set has no cache-control");
      else if (!sharedCache(cache))
        add(
          "jwks",
          "fail",
          "jwks_cache_not_public",
          `the key set has cache-control: ${cache}; core sends public, max-age=300, so each verifier can hold the keys`,
        );
      else
        add(
          "jwks",
          "pass",
          null,
          `the key set holds ${keys.length} public key(s); cache-control: ${cache}`,
        );
    }
  }

  const oidc = await get(`${host.origin}/.well-known/openid-configuration`);
  const as = await get(`${host.origin}/.well-known/oauth-authorization-server`);
  const a = await jsonOf(oidc, `GET ${host.origin}/.well-known/openid-configuration`);
  const b = await jsonOf(as, `GET ${host.origin}/.well-known/oauth-authorization-server`);
  if (oidc.status === 404 && as.status === 404) {
    const under = await get(`${auth}/.well-known/openid-configuration`);
    await textOf(under, `GET ${auth}/.well-known/openid-configuration`);
    if (under.status === 200)
      add(
        "well_known",
        "fail",
        "well_known_not_at_root",
        `the documents answer under ${basePath} only; mount auth.wellKnown at the origin root`,
      );
    else add("well_known", "skip", "oauth_off", "both documents answer 404: oauth is off");
  } else if (oidc.status !== 200 || as.status !== 200 || !a || !b)
    add(
      "well_known",
      "fail",
      "well_known_bad_answer",
      `the documents answer ${oidc.status} and ${as.status}; both answer 200 JSON with oauth on`,
    );
  else if (a.issuer !== b.issuer || a.jwks_uri !== b.jwks_uri)
    add(
      "well_known",
      "fail",
      "well_known_mismatch",
      "the two documents name another issuer or another jwks_uri",
    );
  else if (a.issuer !== auth)
    add(
      "well_known",
      "fail",
      "well_known_issuer",
      `the issuer is ${String(a.issuer)}; the base is ${auth}`,
    );
  else if (a.jwks_uri !== `${auth}/jwks`)
    add(
      "well_known",
      "fail",
      "well_known_jwks_uri",
      `jwks_uri is ${String(a.jwks_uri)}; the key set is at ${auth}/jwks`,
    );
  else add("well_known", "pass", null, `both documents name the issuer ${auth}`);

  if (!input.readSchema)
    add(
      "schema_version",
      "skip",
      "no_database",
      "give --target and the inputs of the database to read the schema version",
    );
  else {
    const v = await input.readSchema();
    if (v === null)
      add(
        "schema_version",
        "fail",
        "schema_missing",
        "the database has no ta_meta: run authtempo migrate",
      );
    else if (v < input.schemaVersion)
      add(
        "schema_version",
        "fail",
        "schema_behind",
        `the database is at version ${v}; core needs ${input.schemaVersion}: run authtempo migrate`,
      );
    else if (v > input.schemaVersion)
      add(
        "schema_version",
        "fail",
        "schema_ahead",
        `the database is at version ${v}; this CLI knows ${input.schemaVersion}: use a newer CLI`,
      );
    else add("schema_version", "pass", null, `the database is at version ${v}`);
  }

  if (results.length !== CHECK_IDS.length || results.some((r, i) => r.id !== CHECK_IDS[i]))
    throw new Error(
      `runChecks reported ${results.map((r) => r.id).join(", ")}; the table is ${CHECK_IDS.join(", ")}`,
    );
  const checks =
    input.strict === true
      ? results.map((r) => (r.status === "skip" ? { ...r, status: "fail" as const } : r))
      : results;
  const count = (s: CheckStatus) => checks.filter((r) => r.status === s).length;
  return {
    base,
    checks,
    warnings,
    summary: { run: checks.length, pass: count("pass"), fail: count("fail"), skip: count("skip") },
  };
}
