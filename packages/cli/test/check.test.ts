import { readdirSync } from "node:fs";
import { expectedD1Shape } from "@authtempo/adapter-d1";
import { expectedPostgresShape } from "@authtempo/adapter-postgres";
import type { LiveShape, LiveTable } from "@authtempo/core/sql";
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
import { describeUrl } from "../src/output.js";
import { adapterD1Dir } from "../src/seams/d1.js";
import { SCHEMA_VERSION } from "../src/version.js";
import {
  BASE,
  COOKIE,
  deployment,
  doc,
  healthy,
  KEY,
  keySet,
  type Route,
  readinessOn,
  signedOut,
  signOut,
} from "./support/deployment.js";
import { type FakeIo, fakeIo } from "./support/fake-io.js";
import { ADMIN_URL, freshDatabase } from "./support/pg.js";

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
/** check reads public documents only (spec 19): no request of a run carries a credential. */
function expectNoCredential(io: FakeIo): void {
  expect(io.requests.length).toBeGreaterThan(0);
  for (const r of io.requests) {
    expect(r.headers.has("cookie"), r.url).toBe(false);
    expect(r.headers.has("authorization"), r.url).toBe(false);
  }
}
const result = (r: CheckReport | null, id: CheckId) => r?.checks.find((c) => c.id === id);

/**
 * The rows that `wrangler d1 execute --json` gives for the two reads of
 * D1_SHAPE_SQL on a fresh database, for the fake wrangler below.
 * check-schema.test.ts reads a real local D1 database. Four secret_version
 * columns have DEFAULT 1 there, but the compare reads the default of an
 * extra column only, so dflt null serves.
 */
const D1_COLUMN_ROWS = expectedD1Shape().flatMap((t) =>
  t.columns.map((c) => ({
    tableName: t.name,
    name: c.name,
    type: c.type,
    notNull: c.notNull ? 1 : 0,
    dflt: null,
    pk: t.primaryKey.indexOf(c.name) + 1,
  })),
);
const D1_INDEX_ROWS = expectedD1Shape().flatMap((t) =>
  [
    ...t.unique.map((ix) => ({ ix, isUnique: 1 })),
    ...t.indexes.map((ix) => ({ ix, isUnique: 0 })),
  ].flatMap(({ ix, isUnique }) =>
    ix.columns.map((col, seqno) => ({
      tableName: t.name,
      name: ix.name,
      isUnique,
      origin: "c",
      seqno,
      col,
    })),
  ),
);

describe("authtempo check (spec 19)", () => {
  it("passes each check of a healthy deployment, skips the schema checks with no database, and prints the summary", async () => {
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
      "skip  schema_shape no_database",
      "skip  ready readiness_off",
      "checks",
    ]);
    expect(io.stdout.at(-1)).toBe("checks: 9 run, 6 pass, 0 fail, 3 skip");
    expect(io.stderr[0]).toBe(`reading ${BASE}/auth and ${BASE}/.well-known/`);
  });

  it("sends no cookie and no authorization header", async () => {
    const { io } = await check([]);
    expectNoCredential(io);
  });

  it("prints one JSON document with --json", async () => {
    const { code, io, report } = await check([]);
    expect(code).toBe(0);
    expect(io.stdout).toHaveLength(1);
    expect(Object.keys(report ?? {}).sort()).toEqual(Object.keys(CHECK_JSON_KEYS).sort());
    expect(report?.checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
    expect(report?.summary).toEqual({ run: 9, pass: 6, fail: 0, skip: 3 });
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
        "no SameSite",
        (r) => r.set("POST /auth/sign-out", signOut(COOKIE.replace("; SameSite=Lax", ""))),
        "cookie",
        "cookie_no_samesite",
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
        (r) => r.set("GET /auth/jwks", () => keySet([KEY], null)),
        "jwks",
        "jwks_no_cache_control",
      ],
      [
        "cache-control no-store",
        (r) => r.set("GET /auth/jwks", () => keySet([KEY], "no-store")),
        "jwks",
        "jwks_cache_not_public",
      ],
      [
        "cache-control public, max-age=0",
        (r) => r.set("GET /auth/jwks", () => keySet([KEY], "public, max-age=0")),
        "jwks",
        "jwks_cache_not_public",
      ],
      [
        "cache-control max-age=300 with no public",
        (r) => r.set("GET /auth/jwks", () => keySet([KEY], "max-age=300")),
        "jwks",
        "jwks_cache_not_public",
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
      ["no health route", (r) => r.delete("GET /auth/health"), "ready", "health_missing"],
      [
        "a health route of 200 with another status",
        (r) => r.set("GET /auth/health", () => Response.json({ status: "down" })),
        "ready",
        "health_missing",
      ],
      [
        "a health route of 200 with a text body",
        (r) => r.set("GET /auth/health", () => new Response("ok")),
        "ready",
        "health_missing",
      ],
      [
        "a readiness route of 200 with another status",
        (r) => r.set("GET /auth/ready", () => Response.json({ status: "up" })),
        "ready",
        "not_ready",
      ],
      [
        "a readiness route of 500",
        (r) => r.set("GET /auth/ready", () => new Response("error", { status: 500 })),
        "ready",
        "not_ready",
      ],
      [
        "a readiness route of 200 with a body that is not JSON",
        (r) => r.set("GET /auth/ready", () => new Response("{ready")),
        "ready",
        "not_ready",
      ],
      [
        "a readiness route of 503",
        (r) =>
          r.set("GET /auth/ready", () =>
            Response.json({ error: "not_ready", reason: "storage" }, { status: 503 }),
          ),
        "ready",
        "not_ready",
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

  it("accepts an RS256 key in the JWKS check", async () => {
    // A real RSA key of 2048 bits, as core writes it under jwtMint.alg RS256 (plan 12e).
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    const rsa = { kty: "RSA", n: jwk.n, e: jwk.e, kid: "R1", alg: "RS256", use: "sig" };
    const routes = healthy();
    routes.set("GET /auth/jwks", () => keySet([rsa]));
    const r = await check([], routes);
    expect(result(r.report, "jwks")).toMatchObject({ status: "pass" });
    expect(r.code).toBe(0);
    // The same key with a private member fails.
    routes.set("GET /auth/jwks", () => keySet([{ ...rsa, p: "AQAB" }]));
    expect(result((await check([], routes)).report, "jwks")).toMatchObject({ status: "fail" });
  });

  it("gives jwks_private_part for each private member of each key type", async () => {
    // RFC 7518 sections 6.2.2, 6.3.2, and 6.4: d of EC and OKP; d, p, q, dp, dq, qi, and oth of RSA; k of oct.
    for (const member of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
      const routes = healthy();
      routes.set("GET /auth/jwks", () => keySet([{ ...KEY, [member]: "AQAB" }]));
      const r = await check([], routes);
      expect({ member, jwks: result(r.report, "jwks")?.code }).toEqual({
        member,
        jwks: "jwks_private_part",
      });
    }
  });

  it("gives jwks_bad_key, not a stop, for an RSA key whose n is not base64url", async () => {
    // A length of 1 mod 4: no base64 text has that length.
    const bad = { kty: "RSA", n: "A".repeat(345), e: "AQAB", kid: "R2", alg: "RS256", use: "sig" };
    const routes = healthy();
    routes.set("GET /auth/jwks", () => keySet([KEY, bad]));
    const r = await check([], routes);
    expect(r.code).toBe(1);
    expect(result(r.report, "jwks")).toMatchObject({ status: "fail", code: "jwks_bad_key" });
  });

  it("skips the checks that need the mount when the mount is missing", async () => {
    const routes = healthy();
    routes.delete("GET /auth/session");
    const r = await check([], routes);
    expect(r.code).toBe(1);
    expect(result(r.report, "mount")).toMatchObject({ status: "fail", code: "mount_missing" });
    for (const id of ["origin_rule", "cookie", "jwks", "ready"] as const)
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

  it("fails an http base off this machine with exit 1, and passes http on this machine", async () => {
    // check sends no secret, so a remote http base is a failed check, not a usage error
    // (review of plan 11c Task 8). keys rotate keeps the refusal: test/keys.test.ts.
    const cli = await check([], healthy(), "http://api.example.com");
    expect(cli.code).toBe(1);
    expect(result(cli.report, "https")).toMatchObject({ status: "fail", code: "base_not_https" });
    expect(
      result((await check([], healthy(), "http://127.0.0.1:8787")).report, "https")?.status,
    ).toBe("pass");
  });

  it("turns each skip into a failure with --strict, except compat_database", async () => {
    const r = await check(["--strict"]);
    expect(r.code).toBe(1);
    for (const id of ["schema_version", "schema_shape"] as const)
      expect(result(r.report, id)).toMatchObject({ status: "fail", code: "no_database" });
    const strict = (version: number, compat: boolean) =>
      runChecks({
        base: BASE,
        basePath: "/auth",
        // The readiness route is on, so the one skip is the one of the database (plan 12h).
        fetch: deployment(readinessOn(healthy())),
        timeoutMs: 1000,
        schemaVersion: 7,
        strict: true,
        readSchema: async () => version,
        shape: {
          expected: [],
          read: async () => [],
          compat: async () => compat,
        },
      });
    expect(result(await strict(6, false), "schema_shape")).toMatchObject({
      status: "fail",
      code: "schema_not_current",
    });
    // Ruling 12: a compat database is a supported state, so the skip stays a skip.
    const compat = await strict(7, true);
    expect(result(compat, "schema_shape")).toMatchObject({
      status: "skip",
      code: "compat_database",
    });
    expect(compat.summary).toEqual({ run: 9, pass: 8, fail: 0, skip: 1 });
  });

  it("stops with exit 2 when the host gives no answer, and reports no check", async () => {
    const io = fakeIo();
    expect(await main(["check", BASE], io)).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.at(-1)).toBe(`stopped: GET ${BASE}/auth/session: no answer`);
  });

  it("shows no password of the base URL in the usage line or in stopped", async () => {
    // Spec 19 item 5 (Task 10 review I-1): the user part prints as ***.
    const cases: [string, string][] = [
      ["http://u:secretpw@127.0.0.1:9", "http://***@127.0.0.1:9"],
      ["http://:secretpw@127.0.0.1:9", "http://***@127.0.0.1:9"],
      ["https://u:secretpw@[bad", "https://***@[bad"],
    ];
    for (const [bad, shown] of cases) {
      const fault = `${shown} must be an http or https origin with no path`;
      const shell = fakeIo();
      expect(await main(["check", bad], shell)).toBe(2);
      expect(shell.requests).toEqual([]);
      expect(shell.stderr[0]).toBe(fault);
      const json = fakeIo();
      expect(await main(["check", bad, "--json"], json)).toBe(2);
      const stop = JSON.parse(json.stdout[0] ?? "") as { stopped: string };
      expect(stop.stopped).toBe(fault);
      for (const line of [...shell.stdout, ...shell.stderr, ...json.stdout, ...json.stderr])
        expect(line).not.toContain("secretpw");
    }
  });

  it("reads a body of 64 KiB, and stops on a body of one byte more with a fixed text", async () => {
    // Task 10 review I-4: a hostile host could stream data until the time limit.
    const session = (bytes: number) => {
      const json = '{"error":"unauthorized"}';
      const body = `${" ".repeat(bytes - json.length)}${json}`;
      return () =>
        new Response(body, { status: 401, headers: { "content-type": "application/json" } });
    };
    const at = healthy();
    at.set("GET /auth/session", session(65_536));
    const full = await check([], at);
    expect(full.code).toBe(0);
    expect(result(full.report, "mount")?.status).toBe("pass");
    const over = healthy();
    over.set("GET /auth/session", session(65_537));
    const io = fakeIo({ fetch: deployment(over) });
    expect(await main(["check", BASE], io)).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.at(-1)).toBe(
      `stopped: GET ${BASE}/auth/session: the answer body is over 64 KiB, the cap of one read`,
    );
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
      expect(result(r, "schema_version")).toMatchObject({ status, code });
    }
  });

  it("writes no escape sequence from the server: a control character in the issuer prints as ?", async () => {
    const routes = healthy();
    const evil = "https://other.example/\u001b[2J\u0007";
    routes.set("GET /.well-known/openid-configuration", doc(evil));
    routes.set("GET /.well-known/oauth-authorization-server", doc(evil));
    const io = fakeIo({ fetch: deployment(routes) });
    expect(await main(["check", BASE], io)).toBe(1);
    const line = io.stdout.find((l) => l.includes("well_known_issuer"));
    expect(line).toBe(
      `fail  well_known well_known_issuer: the issuer is https://other.example/?[2J?; the base is ${BASE}/auth`,
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for control characters.
    const control = /[\u0000-\u0008\u000a-\u001f\u007f]/;
    for (const l of [...io.stdout, ...io.stderr]) expect(l).not.toMatch(control);
  });

  it("names a refused database by its SQLSTATE and its host only, never by its user", async () => {
    const url = ADMIN_URL.replace(/\/\/[^@]+@/, "//no_such_user_canary:wrong-pass-canary@");
    const io = fakeIo({ env: { DATABASE_URL: url }, fetch: deployment(healthy()) });
    expect(await main(["check", BASE, "--target", "postgres"], io)).toBe(2);
    expect(io.stderr.at(-1)).toBe(`stopped: storage: 28P01 at ${describeUrl(url)}`);
    for (const l of [...io.stdout, ...io.stderr]) expect(l).not.toContain("canary");
  });

  it("names a connection string that is no URL by its storage code, and exits 2", async () => {
    // Port 99999 is out of range, so the URL does not parse.
    const url = "postgres://tempo:no-url-canary@127.0.0.1:99999/tempo_auth";
    const io = fakeIo({ env: { DATABASE_URL: url }, fetch: deployment(healthy()) });
    expect(await main(["check", BASE, "--target", "postgres"], io)).toBe(2);
    expect(io.stderr.at(-1)).toBe("stopped: storage: ERR_INVALID_URL at the database");
    for (const l of [...io.stdout, ...io.stderr]) expect(l).not.toContain("canary");
  });

  it("needs --target for the inputs of a database", async () => {
    const io = fakeIo({ fetch: deployment(healthy()) });
    expect(await main(["check", BASE, "--url-env", "DATABASE_URL"], io)).toBe(2);
    expect(io.stderr[0]).toBe("--url-env needs --target postgres");
  });

  it("reads the schema version of Postgres with --target postgres", async () => {
    const db = await freshDatabase();
    try {
      const run = async (cmd: string[]) => {
        const io = fakeIo({ env: { DATABASE_URL: db.url }, fetch: deployment(healthy()) });
        const code = await main(cmd, io);
        return { code, io };
      };
      const empty = await run(["check", BASE, "--target", "postgres", "--json"]);
      expect(empty.code).toBe(1);
      const emptyReport = observe(JSON.parse(empty.io.stdout[0] ?? "") as CheckReport);
      expect(result(emptyReport, "schema_version")).toMatchObject({
        status: "fail",
        code: "schema_missing",
      });
      expectNoCredential(empty.io);
      expect(empty.io.stdout.join("\n")).not.toContain(db.url);

      expect((await run(["migrate", "--target", "postgres"])).code).toBe(0);
      const current = await run(["check", BASE, "--target", "postgres"]);
      expect(current.code).toBe(0);
      expect(current.io.stdout.at(-1)).toBe("checks: 9 run, 8 pass, 0 fail, 1 skip");

      // Applied migrations with no version row: migrate stops on it, so check stops the same way.
      await db.sql`DELETE FROM ta_meta WHERE key = 'schema_version'`;
      const lost = await run(["check", BASE, "--target", "postgres"]);
      expect(lost.code).toBe(2);
      expect(lost.io.stdout).toEqual([]);
      expect(lost.io.stderr.at(-1)).toMatch(
        /^stopped: ta_meta has no schema_version, but ta_migrations holds \d+ applied migration\(s\)/,
      );
    } finally {
      await db.drop();
    }
  });

  it("compares the table shape after a current schema version, and reports each code of schema_shape", async () => {
    const expected = expectedPostgresShape();
    const fresh = (): LiveTable[] =>
      expected.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c, hasDefault: false })) }));
    /** The fresh shape with `change` applied to the table `name`; null drops the table. */
    const drift = (name: string, change: (t: LiveTable) => LiveTable | null): LiveShape =>
      fresh().flatMap((t) => {
        if (t.name !== name) return [t];
        const c = change(t);
        return c === null ? [] : [c];
      });
    const calls: string[] = [];
    const run = (o: { version?: number; compat?: boolean; live?: LiveShape }) =>
      runChecks({
        base: BASE,
        basePath: "/auth",
        fetch: deployment(healthy()),
        timeoutMs: 1000,
        schemaVersion: 7,
        readSchema: async () => o.version ?? 7,
        shape: {
          expected,
          read: async () => {
            calls.push("read");
            return o.live ?? fresh();
          },
          compat: async () => {
            calls.push("compat");
            return o.compat ?? false;
          },
        },
      }).then(observe);
    const shapeOf = (r: CheckReport) => result(r, "schema_shape");

    // A schema version that does not pass reads no shape.
    expect(shapeOf(await run({ version: 6 }))).toEqual({
      id: "schema_shape",
      status: "skip",
      code: "schema_not_current",
      detail: "the schema version did not pass: run authtempo migrate, then check again",
    });
    expect(calls).toEqual([]);
    // A compat database reads no shape.
    expect(shapeOf(await run({ compat: true }))).toEqual({
      id: "schema_shape",
      status: "skip",
      code: "compat_database",
      detail:
        "the database holds the Better Auth compatibility tables; the shape of core's tables does not apply",
    });
    expect(calls).toEqual(["compat"]);
    const pass = await run({});
    expect(shapeOf(pass)?.status).toBe("pass");
    expect(pass.warnings).toEqual([]);

    // Each failure code, as the code of the check.
    const withColumn = (t: LiveTable, name: string, change: object): LiveTable => ({
      ...t,
      columns: t.columns.map((c) => (c.name === name ? { ...c, ...change } : c)),
    });
    const fails: [string, LiveShape][] = [
      ["schema_table_missing", drift("ta_api_token", () => null)],
      [
        "schema_column_missing",
        drift("ta_user", (t) => ({ ...t, columns: t.columns.filter((c) => c.name !== "image") })),
      ],
      [
        "schema_column_type",
        drift("ta_session", (t) => withColumn(t, "expires_at", { type: "text" })),
      ],
      ["schema_column_null", drift("ta_user", (t) => withColumn(t, "name", { notNull: true }))],
      ["schema_unique_missing", drift("ta_user", (t) => ({ ...t, unique: [] }))],
    ];
    for (const [code, live] of fails) {
      const r = await run({ live });
      expect(shapeOf(r), code).toMatchObject({ status: "fail", code });
      expect(r.summary.fail).toBe(1);
    }

    // Six failures and four warnings at once: the detail names the first five.
    let many = fresh();
    for (const [name, change] of [
      ["ta_api_token", () => null],
      [
        "ta_session",
        (t: LiveTable) => ({
          ...withColumn(withColumn(t, "expires_at", { type: "text" }), "ip", { notNull: true }),
          indexes: t.indexes.filter((i) => i.name !== "ix_ta_session__user_id"),
        }),
      ],
      [
        "ta_user",
        (t: LiveTable) => ({
          ...t,
          columns: [
            ...t.columns.filter((c) => c.name !== "image"),
            { name: "nickname", type: "text", notNull: false, hasDefault: false },
            { name: "plan", type: "text", notNull: true, hasDefault: false },
          ],
          unique: [],
        }),
      ],
      ["ta_verification", (t: LiveTable) => ({ ...t, unique: [] })],
    ] as [string, (t: LiveTable) => LiveTable | null][]) {
      many = many.flatMap((t) => {
        if (t.name !== name) return [t];
        const c = change(t);
        return c === null ? [] : [c];
      });
    }
    many = [
      ...many,
      {
        name: "ta_app_note",
        columns: [{ name: "id", type: "text", notNull: true, hasDefault: false }],
        primaryKey: ["id"],
        unique: [],
        indexes: [],
      },
    ];
    const r = await run({ live: many });
    expect(shapeOf(r)).toEqual({
      id: "schema_shape",
      status: "fail",
      code: "schema_table_missing",
      detail:
        "the table ta_api_token is missing; the column expires_at of ta_session has another type than the migrations make; the column ip of ta_session has another NOT NULL rule than the migrations make; the table ta_user has no column image; the table ta_user has no unique index ux_ta_user__email on the columns of the migrations; and 1 more",
    });
    expect(r.warnings).toEqual([
      "schema_index_missing: the table ta_session has no index ix_ta_session__user_id on the columns of the migrations",
      "schema_column_extra: the table ta_user has the column nickname, which the migrations do not make",
      "schema_column_extra_required: the table ta_user has the NOT NULL column plan with no default: each insert of core into ta_user fails",
      "schema_table_extra: the database has the table ta_app_note, which the migrations do not make",
    ]);

    // Warnings alone pass, and the detail counts them.
    const warned = await run({
      live: [...fresh(), ...many.filter((t) => t.name === "ta_app_note")],
    });
    expect(shapeOf(warned)).toEqual({
      id: "schema_shape",
      status: "pass",
      code: null,
      detail:
        "each table of the adapter's migrations has its columns and its keys, with 1 warning(s)",
    });
  });

  it("reads the schema version of D1 with --target d1, through the project's wrangler", async () => {
    // A fake wrangler: `d1 execute --json` answers the rows of each SELECT, as wrangler 4.148.0 prints them.
    const own = readdirSync(adapterD1Dir()).filter((f) => f.endsWith(".sql"));
    const d1 = (version: string | null) => {
      const files: Record<string, string> = {
        "/work/wrangler.jsonc": JSON.stringify({
          d1_databases: [{ binding: "DB", database_name: "cli-d1" }],
        }),
        "/work/node_modules/.bin/wrangler": "",
      };
      for (const f of own) files[`${adapterD1Dir()}/${f}`] = "";
      const io = fakeIo({
        files,
        fetch: deployment(healthy()),
        run: async (_command, args) => {
          const sql = args[args.indexOf("--command") + 1] ?? "";
          const rows = sql.includes("d1_migrations")
            ? own.map((name) => ({ name }))
            : sql.includes("pragma_table_info")
              ? D1_COLUMN_ROWS
              : sql.includes("pragma_index_list")
                ? D1_INDEX_ROWS
                : sql.includes("compat_better_auth") || version === null
                  ? []
                  : [{ value: version }];
          return {
            status: 0,
            stdout: JSON.stringify([{ results: rows, success: true }]),
            stderr: "",
          };
        },
      });
      return io;
    };
    const current = d1(String(SCHEMA_VERSION));
    expect(await main(["check", BASE, "--target", "d1"], current)).toBe(0);
    expect(current.stdout.at(-1)).toBe("checks: 9 run, 8 pass, 0 fail, 1 skip");
    expect(current.stderr).toContain("reading the local D1 database cli-d1");
    expectNoCredential(current);

    const lost = d1(null);
    expect(await main(["check", BASE, "--target", "d1"], lost)).toBe(2);
    expect(lost.stderr.at(-1)).toBe(
      `stopped: ta_meta has no schema_version, but d1_migrations holds ${own.length} applied migration(s); nothing was written`,
    );
  });

  afterAll(() => {
    // A code that no test reached is a check that can report what no test proves.
    expect([...seen].sort()).toEqual([...ALL_CHECK_CODES].sort());
  });
});
