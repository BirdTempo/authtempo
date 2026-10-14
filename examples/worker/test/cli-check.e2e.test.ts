import { env, SELF } from "cloudflare:test";
import { CHECK_IDS, type CheckReport, runChecks } from "@authtempo/cli";
import { SCHEMA_VERSION } from "@authtempo/core";
import { expect, it } from "vitest";
import { BASE } from "./helpers";

// runChecks of @authtempo/cli in the Workers pool against this Worker on D1
// (plan 11c). runChecks imports no Node.js module, so it runs in workerd.
// The faults are wrappers around the Worker's own answers.

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const worker: Fetch = (url, init) => SELF.fetch(url, init);
const check = (fetch: Fetch, readSchema?: () => Promise<number | null>) =>
  runChecks({
    base: BASE,
    basePath: "/auth",
    fetch,
    timeoutMs: 10_000,
    schemaVersion: SCHEMA_VERSION,
    ...(readSchema ? { readSchema } : {}),
  });
const lines = (r: CheckReport) =>
  r.checks.map((c) => `${c.id} ${c.status}${c.code ? ` ${c.code}` : ""}`);

/** The Worker's answer, changed for the requests that `match` names. */
const wrap =
  (match: (url: URL) => boolean, change: (res: Response) => Promise<Response>): Fetch =>
  async (url, init) => {
    const res = await worker(url, init);
    return match(new URL(url)) ? change(res) : res;
  };

it("passes each check against the example Worker on D1, and skips the schema check with no database (plan 11c)", async () => {
  const r = await check(worker);
  expect(lines(r)).toEqual(
    CHECK_IDS.map((id) =>
      id === "schema_version" ? "schema_version skip no_database" : `${id} pass`,
    ),
  );
});

it("reads the schema version of the Worker's own D1 database", async () => {
  const r = await check(worker, async () => {
    const row = await env.DB.prepare(
      "SELECT value FROM ta_meta WHERE key = 'schema_version'",
    ).first<{
      value: string;
    }>();
    return row ? Number(row.value) : null;
  });
  expect(r.checks.at(-1)).toMatchObject({ id: "schema_version", status: "pass" });
});

it("fails with the named code of each fault of a deployment", async () => {
  const faults: [Fetch, string][] = [
    [
      wrap(
        (u) => u.pathname === "/auth/session",
        async () => new Response("not found", { status: 404 }),
      ),
      "mount fail mount_missing",
    ],
    [
      wrap(
        (u) => u.pathname === "/auth/sign-out",
        async (res) => {
          const headers = new Headers(res.headers);
          headers.set("set-cookie", (res.headers.get("set-cookie") ?? "").replace("; Secure", ""));
          return new Response(res.body, { status: res.status, headers });
        },
      ),
      "cookie fail cookie_not_secure",
    ],
    [
      wrap(
        (u) => u.pathname === "/auth/jwks",
        async (res) => {
          const body = (await res.json()) as { keys: Record<string, unknown>[] };
          return Response.json(
            { keys: body.keys.map((k) => ({ ...k, d: "private" })) },
            { headers: { "cache-control": "public, max-age=300" } },
          );
        },
      ),
      "jwks fail jwks_private_part",
    ],
    [
      wrap(
        (u) => u.pathname.startsWith("/.well-known/"),
        async (res) =>
          Response.json({
            ...((await res.json()) as object),
            issuer: "https://other.example/auth",
          }),
      ),
      "well_known fail well_known_issuer",
    ],
  ];
  for (const [fetch, expected] of faults) expect(lines(await check(fetch))).toContain(expected);
});
