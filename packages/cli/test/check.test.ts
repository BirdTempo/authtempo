import { afterAll, describe, expect, it } from "vitest";
import {
  ALL_CHECK_CODES,
  CHECK_IDS,
  type CheckId,
  type CheckReport,
  runChecks,
} from "../src/checks.js";
import { CHECK_JSON_KEYS } from "../src/json.js";
import { main } from "../src/main.js";
import { fakeIo } from "./support/fake-io.js";

const BASE = "https://api.example.com";
const COOKIE = "tempo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
type Route = (init: RequestInit) => Response;

const signedOut = (cookie: string | null) =>
  new Response('{"ok":true}', {
    status: 200,
    headers: [
      ["content-type", "application/json"],
      ...(cookie === null ? [] : [["set-cookie", cookie] as [string, string]]),
    ],
  });
/** Core's sign-out: 403 for a foreign Origin, else 200 with the clear cookie. */
const signOut =
  (cookie: string | null): Route =>
  (init) =>
    new Headers(init.headers).has("origin")
      ? Response.json({ error: "origin_not_trusted" }, { status: 403 })
      : signedOut(cookie);
const keySet = (keys: unknown[], cache = true) =>
  Response.json({ keys }, { headers: cache ? { "cache-control": "public, max-age=300" } : {} });
const KEY = { kty: "OKP", crv: "Ed25519", x: "AAAA", kid: "K1", alg: "EdDSA", use: "sig" };
const doc =
  (issuer = `${BASE}/auth`, jwks = `${BASE}/auth/jwks`) =>
  () =>
    Response.json({ issuer, jwks_uri: jwks });

/** A deployment that answers as core does, route by route. */
function healthy(): Map<string, Route> {
  return new Map<string, Route>([
    ["GET /auth/session", () => Response.json({ error: "unauthorized" }, { status: 401 })],
    ["POST /auth/sign-out", signOut(COOKIE)],
    ["GET /auth/jwks", () => keySet([KEY])],
    ["GET /.well-known/openid-configuration", doc()],
    ["GET /.well-known/oauth-authorization-server", doc()],
  ]);
}
const deployment = (routes: Map<string, Route>) => async (url: string, init: RequestInit) =>
  routes.get(`${init.method ?? "GET"} ${new URL(url).pathname}`)?.(init) ??
  Response.json({ error: "not_found" }, { status: 404 });

/** Every code that a test of this file saw: the last test holds the set to ALL_CHECK_CODES. */
const seen = new Set<string>();
function observe(r: CheckReport): CheckReport {
  for (const c of r.checks) if (c.code) seen.add(c.code);
  for (const w of r.warnings) seen.add(w.split(":")[0] ?? "");
  return r;
}

async function check(args: string[], routes = healthy(), base = BASE) {
  const io = fakeIo({ fetch: deployment(routes) });
  const code = await main(["check", base, "--json", ...args], io);
  const report =
    io.stdout.length === 1 ? observe(JSON.parse(io.stdout[0] ?? "") as CheckReport) : null;
  return { code, io, report };
}
const result = (r: CheckReport | null, id: CheckId) => r?.checks.find((c) => c.id === id);

describe("authtempo check (spec 19)", () => {
  it("passes each check of a healthy deployment, skips the schema check with no database, and prints the summary", async () => {
    const io = fakeIo({ fetch: deployment(healthy()) });
    expect(await main(["check", BASE], io)).toBe(0);
    expect(io.stdout.map((l) => l.split(":")[0])).toEqual([
      "pass  https",
      "pass  mount",
      "pass  origin_rule",
      "pass  cookie",
      "pass  jwks",
      "pass  well_known",
      "skip  schema_version no_database",
      "checks",
    ]);
    expect(io.stdout.at(-1)).toBe("checks: 7 run, 6 pass, 0 fail, 1 skip");
    expect(io.stderr[0]).toBe(`reading ${BASE}/auth and ${BASE}/.well-known/`);
  });

  it("prints one JSON document with --json", async () => {
    const { code, io, report } = await check([]);
    expect(code).toBe(0);
    expect(io.stdout).toHaveLength(1);
    expect(Object.keys(report ?? {}).sort()).toEqual(Object.keys(CHECK_JSON_KEYS).sort());
    expect(report?.checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
    expect(report?.summary).toEqual({ run: 7, pass: 6, fail: 0, skip: 1 });
  });

  it("fails with the named code of each fault, and exits 1", async () => {
    const faults: [string, (r: Map<string, Route>) => void, CheckId, string][] = [
      [
        "an HTML page at the mount",
        (r) =>
          r.set(
            "GET /auth/session",
            () => new Response("<html>", { headers: { "content-type": "text/html" } }),
          ),
        "mount",
        "mount_missing",
      ],
      [
        "200 JSON at the mount",
        (r) => r.set("GET /auth/session", () => Response.json({ user: null })),
        "mount",
        "mount_wrong_answer",
      ],
      [
        "no origin rule",
        (r) => r.set("POST /auth/sign-out", () => signedOut(COOKIE)),
        "origin_rule",
        "origin_not_enforced",
      ],
      ["no cookie", (r) => r.set("POST /auth/sign-out", signOut(null)), "cookie", "cookie_missing"],
      [
        "no HttpOnly",
        (r) => r.set("POST /auth/sign-out", signOut(COOKIE.replace("; HttpOnly", ""))),
        "cookie",
        "cookie_not_httponly",
      ],
      [
        "no Secure",
        (r) => r.set("POST /auth/sign-out", signOut(COOKIE.replace("; Secure", ""))),
        "cookie",
        "cookie_not_secure",
      ],
      [
        "a cookie path of /auth",
        (r) => r.set("POST /auth/sign-out", signOut(COOKIE.replace("Path=/", "Path=/auth"))),
        "cookie",
        "cookie_path_not_root",
      ],
      [
        "a key set of 500",
        (r) => r.set("GET /auth/jwks", () => Response.json({ error: "internal" }, { status: 500 })),
        "jwks",
        "jwks_bad_answer",
      ],
      ["an empty key set", (r) => r.set("GET /auth/jwks", () => keySet([])), "jwks", "jwks_empty"],
      [
        "a private part",
        (r) => r.set("GET /auth/jwks", () => keySet([{ ...KEY, d: "secret" }])),
        "jwks",
        "jwks_private_part",
      ],
      [
        "an RS256 key",
        (r) => r.set("GET /auth/jwks", () => keySet([{ ...KEY, alg: "RS256" }])),
        "jwks",
        "jwks_bad_key",
      ],
      [
        "no cache-control",
        (r) => r.set("GET /auth/jwks", () => keySet([KEY], false)),
        "jwks",
        "jwks_no_cache_control",
      ],
      [
        "one document only",
        (r) => r.delete("GET /.well-known/oauth-authorization-server"),
        "well_known",
        "well_known_bad_answer",
      ],
      [
        "two documents that differ",
        (r) => r.set("GET /.well-known/oauth-authorization-server", doc(`${BASE}/other`)),
        "well_known",
        "well_known_mismatch",
      ],
      [
        "another issuer",
        (r) => {
          r.set("GET /.well-known/openid-configuration", doc("https://other.example/auth"));
          r.set("GET /.well-known/oauth-authorization-server", doc("https://other.example/auth"));
        },
        "well_known",
        "well_known_issuer",
      ],
      [
        "another jwks_uri",
        (r) => {
          r.set("GET /.well-known/openid-configuration", doc(undefined, `${BASE}/keys`));
          r.set("GET /.well-known/oauth-authorization-server", doc(undefined, `${BASE}/keys`));
        },
        "well_known",
        "well_known_jwks_uri",
      ],
      [
        "documents under basePath only",
        (r) => {
          r.delete("GET /.well-known/openid-configuration");
          r.delete("GET /.well-known/oauth-authorization-server");
          r.set("GET /auth/.well-known/openid-configuration", doc());
        },
        "well_known",
        "well_known_not_at_root",
      ],
    ];
    for (const [name, change, id, code] of faults) {
      const routes = healthy();
      change(routes);
      const r = await check([], routes);
      expect(r.code, name).toBe(1);
      expect(result(r.report, id), name).toMatchObject({ status: "fail", code });
    }
  });

  it("skips the checks that need the mount when the mount is missing", async () => {
    const routes = healthy();
    routes.delete("GET /auth/session");
    const r = await check([], routes);
    expect(r.code).toBe(1);
    expect(result(r.report, "mount")).toMatchObject({ status: "fail", code: "mount_missing" });
    for (const id of ["origin_rule", "cookie", "jwks"] as const)
      expect(result(r.report, id)).toMatchObject({ status: "skip", code: "no_mount" });
  });

  it("skips the key set and the documents of features that are off, and exits 0", async () => {
    const routes = healthy();
    for (const k of [
      "GET /auth/jwks",
      "GET /.well-known/openid-configuration",
      "GET /.well-known/oauth-authorization-server",
    ])
      routes.delete(k);
    const r = await check([], routes);
    expect(r.code).toBe(0);
    expect(result(r.report, "jwks")).toMatchObject({ status: "skip", code: "jwt_mint_off" });
    expect(result(r.report, "well_known")).toMatchObject({ status: "skip", code: "oauth_off" });
  });

  it("warns on a SameSite=None cookie, and passes the cookie check", async () => {
    const routes = healthy();
    routes.set("POST /auth/sign-out", signOut(COOKIE.replace("SameSite=Lax", "SameSite=None")));
    const r = await check([], routes);
    expect(r.code).toBe(0);
    expect(result(r.report, "cookie")?.status).toBe("pass");
    expect(r.report?.warnings[0]).toMatch(/^cookie_samesite_none: /);
    expect(r.io.stderr).toContain(`warning: ${r.report?.warnings[0]}`);
  });

  it("fails an http base off this machine, and passes http on this machine", async () => {
    // The command refuses http to another host as a usage error (net.ts, review of plan 11c
    // Task 3), so the https check of runChecks serves a caller that gives the base itself.
    const cli = await check([], healthy(), "http://api.example.com");
    expect(cli.code).toBe(2);
    expect(cli.io.stderr[0]).toBe(
      "http://api.example.com must use https: http is for localhost, 127.0.0.1, or [::1] only",
    );
    const r = observe(
      await runChecks({
        base: "http://api.example.com",
        basePath: "/auth",
        fetch: deployment(healthy()),
        timeoutMs: 1000,
        schemaVersion: 7,
      }),
    );
    expect(result(r, "https")).toMatchObject({ status: "fail", code: "base_not_https" });
    expect(
      result((await check([], healthy(), "http://127.0.0.1:8787")).report, "https")?.status,
    ).toBe("pass");
  });

  it("turns each skip into a failure with --strict", async () => {
    const r = await check(["--strict"]);
    expect(r.code).toBe(1);
    expect(result(r.report, "schema_version")).toMatchObject({
      status: "fail",
      code: "no_database",
    });
  });

  it("stops with exit 2 when the host gives no answer, and reports no check", async () => {
    const io = fakeIo();
    expect(await main(["check", BASE], io)).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.at(-1)).toBe(`stopped: GET ${BASE}/auth/session: no answer`);
  });

  it("compares the schema version of the database with the version of the CLI", async () => {
    const cases: [number | null, string, string | null][] = [
      [7, "pass", null],
      [null, "fail", "schema_missing"],
      [6, "fail", "schema_behind"],
      [8, "fail", "schema_ahead"],
    ];
    for (const [version, status, code] of cases) {
      const r = observe(
        await runChecks({
          base: BASE,
          basePath: "/auth",
          fetch: deployment(healthy()),
          timeoutMs: 1000,
          schemaVersion: 7,
          readSchema: async () => version,
        }),
      );
      expect(r.checks.at(-1)).toMatchObject({ id: "schema_version", status, code });
    }
  });

  it("needs --target for the inputs of a database", async () => {
    const io = fakeIo({ fetch: deployment(healthy()) });
    expect(await main(["check", BASE, "--url-env", "DATABASE_URL"], io)).toBe(2);
    expect(io.stderr[0]).toBe("--url-env needs --target postgres");
  });

  afterAll(() => {
    // A code that no test reached is a check that can report what no test proves.
    expect([...seen].sort()).toEqual([...ALL_CHECK_CODES].sort());
  });
});
