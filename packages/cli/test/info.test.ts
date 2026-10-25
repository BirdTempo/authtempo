// `authtempo info` (plan 11c2 Task 5): a support report with no secret value
// and no host name. The deployment part runs against a real core handle. The
// database part runs against Docker Postgres and the D1 test project.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { applyPostgresMigrations } from "@authtempo/adapter-postgres";
import { type Auth, createAuth, createMemoryAdapter, createMemoryLimiter } from "@authtempo/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  INFO_MAX_BYTES,
  INFO_MAX_KEYS,
  infoCommand,
  KEY_PATH,
  secretNames,
  VERSION_TEXT,
} from "../src/commands/info.js";
import { INFO_JSON_KEYS, type InfoJson } from "../src/json.js";
import { main } from "../src/main.js";
import { guarded } from "../src/output.js";
import { adapterD1Dir } from "../src/seams/d1.js";
import { CORE_MIGRATIONS } from "../src/seams/postgres.js";
import { SCHEMA_VERSION } from "../src/version.js";
import { assertFreshBuild, ESC, linesOf, runBin } from "./support/bin.js";
import { d1Project, removeScaffolds } from "./support/d1-project.js";
import { OPERATOR_SECRET } from "./support/example-worker.js";
import { fakeIo } from "./support/fake-io.js";
import { freshDatabase, WRONG_PASSWORD_URL } from "./support/pg.js";

/** The port of the Postgres of this slot. No line of the CLI may name it. */
const PG_PORT = new URL(WRONG_PASSWORD_URL).port;

const BASE = "https://api.example.com";
const INFO = `${BASE}/auth/operator/info`;
const SECRET = "operator-secret-0123456789abcdef-0123456789";
const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
/** A project of the memory io: a Worker on D1 with core installed and the adapter not installed. */
const PROJECT = {
  "/work/package.json": JSON.stringify({
    name: "my-app",
    dependencies: { "@authtempo/core": "0.0.0", "@authtempo/adapter-d1": "0.0.0", hono: "4.0.0" },
  }),
  "/work/node_modules/@authtempo/core/package.json": JSON.stringify({
    name: "@authtempo/core",
    version: "0.0.0",
  }),
  "/work/wrangler.jsonc": `// The config of the Worker.\n{ "d1_databases": [{ "binding": "DB", "database_name": "auth", "database_id": "${DATABASE_ID}" }], }\n`,
};
const AGENT = "pnpm/12.8.1 npm/? node/v26.10.0 linux x64";

/** The one JSON document of a `--json` run. */
function docOf(stdout: readonly string[]): InfoJson {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? "") as InfoJson;
}

/**
 * A core handle, with the operator routes or without them. `fetchOf` makes
 * the fetch of a memory io that sends each request to the handle, with the
 * IP that the limiter keys on.
 */
function deployment(operator: boolean): Auth {
  const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
  return createAuth({
    baseURL: BASE,
    trustedOrigins: ["https://app.example.com"],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    clock,
    limiter: createMemoryLimiter(clock),
    secret: "0123456789abcdef0123456789abcdef",
    ...(operator
      ? { operator: { secretHash: createHash("sha256").update(SECRET, "utf8").digest("hex") } }
      : {}),
  });
}
const fetchOf = (auth: Auth) => async (url: string, init: RequestInit) => {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", "203.0.113.7");
  return auth.handle(new Request(url, { ...init, headers }));
};
/** The key paths of the config of `deployment(true)`, sorted as the info route sorts them. */
const CONFIG_KEYS = [
  "baseURL",
  "clock",
  "limiter",
  "mail",
  "operator",
  "operator.secretHash",
  "secret",
  "storage",
  "trustedOrigins",
];

afterAll(() => {
  removeScaffolds();
});

describe("authtempo info (plan 11c2)", () => {
  it("lists the SQLite and MySQL adapters of the project among the adapters (plan 12g)", async () => {
    const files = {
      "/work/package.json": JSON.stringify({
        name: "my-app",
        dependencies: {
          "@authtempo/adapter-mysql": "0.0.0",
          "@authtempo/adapter-sqlite": "0.0.0",
          "@authtempo/core": "0.0.0",
        },
      }),
    };
    const io = fakeIo({ files });
    expect(await main(["info", "--json"], io)).toBe(0);
    const doc = docOf(io.stdout);
    expect(doc.adapters).toEqual(["adapter-mysql", "adapter-sqlite"]);
    expect(doc.packages).toEqual({
      "@authtempo/adapter-mysql": null,
      "@authtempo/adapter-sqlite": null,
      "@authtempo/core": null,
    });
  });

  it("reports the tools and the project, and makes no network call", async () => {
    const io = fakeIo({ files: PROJECT, env: { npm_config_user_agent: AGENT } });
    expect(await main(["info", "--json"], io)).toBe(0);
    expect(io.requests).toHaveLength(0);
    const doc = docOf(io.stdout);
    expect(doc).toEqual({
      cli: "0.0.0",
      schemaVersion: 15,
      runtime: { node: "v26.10.0", platform: "linux", arch: "x64" },
      packageManager: { name: "pnpm", version: "12.8.1", source: "user-agent" },
      packages: { "@authtempo/core": "0.0.0", "@authtempo/adapter-d1": null },
      adapters: ["adapter-d1"],
      project: { wrangler: true, d1Databases: ["auth"] },
      env: { AUTHTEMPO_OPERATOR_SECRET: "unset", AUTH_SECRET: "unset", DATABASE_URL: "unset" },
      database: null,
      deployment: null,
      unread: [],
      exit: 0,
      stopped: null,
    });
    for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain(DATABASE_ID);

    const human = fakeIo({ files: PROJECT, env: { npm_config_user_agent: AGENT } });
    expect(await main(["info"], human)).toBe(0);
    expect(human.stdout).toEqual([
      "authtempo 0.0.0 (schema version 15)",
      "runtime: node v26.10.0, linux, x64",
      "package manager: pnpm 12.8.1 (from npm_config_user_agent)",
      "packages: @authtempo/adapter-d1 not installed, @authtempo/core 0.0.0",
      "adapters: adapter-d1",
      "wrangler: 1 D1 database: auth",
      "env: AUTHTEMPO_OPERATOR_SECRET unset, AUTH_SECRET unset, DATABASE_URL unset",
    ]);
    expect(human.stderr).toEqual([]);
    for (const line of human.stdout) expect(line).not.toContain(DATABASE_ID);
  });

  it("reads the package manager from package.json when no user agent is set, and drops a value that is no tool word", async () => {
    const run = async (files: Record<string, string>, env: Record<string, string> = {}) => {
      const io = fakeIo({ files, env });
      expect(await main(["info", "--json"], io)).toBe(0);
      return docOf(io.stdout);
    };
    const pkg = (packageManager: string) => ({
      "/work/package.json": JSON.stringify({ name: "my-app", packageManager }),
    });
    expect((await run(pkg("pnpm@12.8.1+sha512.abcdef"))).packageManager).toEqual({
      name: "pnpm",
      version: "12.8.1",
      source: "package.json",
    });
    expect((await run(pkg("pnpm@12.8.1"))).packageManager).toEqual({
      name: "pnpm",
      version: "12.8.1",
      source: "package.json",
    });
    // The user agent comes first, and the hash after the plus is not printed.
    expect((await run(pkg("yarn@4.0.0"), { npm_config_user_agent: AGENT })).packageManager).toEqual(
      { name: "pnpm", version: "12.8.1", source: "user-agent" },
    );
    expect((await run(pkg("pnpm@12.8.1 or later"))).packageManager).toBeNull();
    expect((await run(pkg("pnpm"))).packageManager).toBeNull();
    expect(
      (await run({}, { npm_config_user_agent: "\u001b[2Jpnpm/12.8.1 npm/?" })).packageManager,
    ).toBeNull();
    const none = await run({});
    expect(none.packageManager).toBeNull();
    expect(none.project).toBeNull();
    expect(none.packages).toEqual({});
    expect(none.adapters).toEqual([]);
  });

  it("warns on a wrangler config that does not parse, and lists no D1 database", async () => {
    const io = fakeIo({
      files: {
        "/work/package.json": '{ "name": "my-app" }',
        "/work/wrangler.json": "{ not json",
      },
    });
    expect(await main(["info", "--json"], io)).toBe(0);
    expect(docOf(io.stdout).project).toEqual({ wrangler: true, d1Databases: [] });
    expect(io.stderr).toEqual([
      "warning: /work/wrangler.json does not parse; the report lists no D1 database",
    ]);
  });

  it("lists the secret names as set or unset, from the example files of the templates", async () => {
    expect(secretNames()).toEqual(["AUTHTEMPO_OPERATOR_SECRET", "AUTH_SECRET", "DATABASE_URL"]);
    const io = fakeIo({
      env: { AUTH_SECRET: "probe-secret-77", BASE_URL: "http://127.0.0.1:3000" },
    });
    expect(await main(["info", "--json"], io)).toBe(0);
    const doc = docOf(io.stdout);
    expect(doc.env).toEqual({
      AUTHTEMPO_OPERATOR_SECRET: "unset",
      AUTH_SECRET: "set",
      DATABASE_URL: "unset",
    });
    expect(Object.keys(doc.env)).not.toContain("BASE_URL");
  });

  it("holds no secret value on any line, also when the driver echoes it", async () => {
    const env = {
      AUTH_SECRET: "probe-secret-77",
      DATABASE_URL: WRONG_PASSWORD_URL,
      AUTHTEMPO_OPERATOR_SECRET: OPERATOR_SECRET,
    };
    const io = fakeIo({ env });
    const ctx = guarded(io);
    expect(await infoCommand.run(["--target", "postgres", "--json"], ctx)).toBe(1);
    const doc = docOf(io.stdout);
    expect(doc.database).toBeNull();
    expect(doc.unread).toEqual([{ part: "database", reason: "storage: 28P01" }]);
    expect(doc.env).toEqual({
      AUTHTEMPO_OPERATOR_SECRET: "set",
      AUTH_SECRET: "set",
      DATABASE_URL: "set",
    });
    expect(doc.exit).toBe(1);
    expect(io.stderr).toContain("reading the postgres database");
    const never = [
      "probe-secret-77",
      "wrong-pass-5",
      "tempo:wrong-pass-5",
      OPERATOR_SECRET,
      "localhost",
      PG_PORT,
    ];
    for (const line of [...io.stdout, ...io.stderr])
      for (const s of never) expect(line, s).not.toContain(s);
    // The scrub list holds each set value, also the two that no part read.
    for (const value of [env.AUTH_SECRET, OPERATOR_SECRET, env.DATABASE_URL]) {
      ctx.out(`the driver said ${value}`);
      expect(io.stdout.at(-1)).toBe("the driver said ***");
    }

    const human = fakeIo({ env });
    expect(await main(["info", "--target", "postgres"], human)).toBe(1);
    expect(human.stdout).toContain("unread: database: storage: 28P01");
    expect(human.stdout).toContain(
      "env: AUTHTEMPO_OPERATOR_SECRET set, AUTH_SECRET set, DATABASE_URL set",
    );
    for (const line of [...human.stdout, ...human.stderr])
      for (const s of never) expect(line, s).not.toContain(s);
  });

  it("reports the database by its kind and its schema version", async () => {
    const db = await freshDatabase();
    try {
      await applyPostgresMigrations(db.sql);
      const io = fakeIo({ env: { DATABASE_URL: db.url } });
      expect(await main(["info", "--target", "postgres", "--json"], io)).toBe(0);
      const doc = docOf(io.stdout);
      expect(doc.database).toEqual({
        kind: "postgres",
        schemaVersion: SCHEMA_VERSION,
        applied: CORE_MIGRATIONS.length,
        compatVersion: null,
      });
      expect(doc.unread).toEqual([]);
      expect(io.stderr).toEqual(["reading the postgres database"]);
      for (const line of [...io.stdout, ...io.stderr]) {
        expect(line).not.toContain("localhost");
        expect(line).not.toContain(PG_PORT);
      }

      const human = fakeIo({ env: { DATABASE_URL: db.url } });
      expect(await main(["info", "--target", "postgres"], human)).toBe(0);
      expect(human.stdout).toContain(
        `database: postgres, schema version ${SCHEMA_VERSION}, ${doc.database?.applied} migrations applied, compat version none`,
      );
    } finally {
      await db.drop();
    }
  });

  describe("on D1", { timeout: 300_000 }, () => {
    it("reports the local D1 database of the project by its kind, with no database_id", () => {
      assertFreshBuild();
      const p = d1Project({
        files: {
          "package.json": JSON.stringify({
            name: "my-worker",
            dependencies: { "@authtempo/adapter-d1": "0.0.0" },
          }),
        },
      });
      const migrate = runBin(["migrate", "--target", "d1"], { cwd: p.dir });
      expect(migrate.status, migrate.stderr).toBe(0);
      const r = runBin(["info", "--target", "d1", "--json"], { cwd: p.dir });
      expect(r.status, r.stderr).toBe(0);
      const doc = JSON.parse(r.stdout) as InfoJson;
      const own = readdirSync(adapterD1Dir()).filter((f) => f.endsWith(".sql")).length;
      expect(doc.database).toEqual({
        kind: "d1",
        schemaVersion: SCHEMA_VERSION,
        applied: own,
        compatVersion: null,
      });
      expect(doc.project).toEqual({ wrangler: true, d1Databases: ["cli-d1"] });
      expect(doc.packages).toEqual({ "@authtempo/adapter-d1": "0.0.0" });
      expect(doc.adapters).toEqual(["adapter-d1"]);
      expect(doc).toMatchObject({ unread: [], exit: 0, stopped: null });
      expect(linesOf(r.stderr)).toContain("reading the local D1 database");
      // The fixture's database_id is `cli-d1-fixture`: it never prints.
      expect(r.stdout + r.stderr).not.toContain("cli-d1-fixture");
      expect(r.stdout + r.stderr).not.toContain(ESC);
    });
  });

  it("reports the version and the config keys of the deployment", async () => {
    const io = fakeIo({
      env: { AUTHTEMPO_OPERATOR_SECRET: SECRET },
      fetch: fetchOf(deployment(true)),
    });
    expect(await main(["info", BASE, "--json"], io)).toBe(0);
    const doc = docOf(io.stdout);
    expect(doc.deployment).toEqual({
      core: "0.0.0",
      schemaVersion: 15,
      configKeys: CONFIG_KEYS,
      dropped: 0,
    });
    expect(doc.unread).toEqual([]);
    expect(io.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${INFO}`]);
    expect(io.requests[0]?.headers.get("authorization")).toBe(`Operator ${SECRET}`);
    expect(io.stderr).toEqual(["reading the deployment"]);
    for (const line of [...io.stdout, ...io.stderr]) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("api.example.com");
    }

    const human = fakeIo({
      env: { AUTHTEMPO_OPERATOR_SECRET: SECRET },
      fetch: fetchOf(deployment(true)),
    });
    expect(await main(["info", BASE], human)).toBe(0);
    const at = human.stdout.indexOf(
      "deployment: core 0.0.0, schema version 15, 9 config keys, 0 dropped",
    );
    expect(at).toBeGreaterThan(0);
    expect(human.stdout.slice(at + 1)).toEqual(CONFIG_KEYS.map((k) => `config key: ${k}`));
  });

  it("prints no key path that is not a plain name, and counts it", async () => {
    const long = "a".repeat(2000);
    const hostile = async () =>
      Response.json({
        core: "0.0.0\u001b[31m",
        schemaVersion: 10,
        configKeys: ["basePath", "\u001b[2Jx", long, 7],
      });
    const io = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: SECRET }, fetch: hostile });
    expect(await main(["info", BASE, "--json"], io)).toBe(0);
    const doc = docOf(io.stdout);
    expect(doc.deployment).toEqual({
      core: "unreadable",
      schemaVersion: 10,
      configKeys: ["basePath"],
      dropped: 3,
    });
    const human = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: SECRET }, fetch: hostile });
    expect(await main(["info", BASE], human)).toBe(0);
    expect(human.stdout).toContain(
      "deployment: core unreadable, schema version 10, 1 config keys, 3 dropped",
    );
    for (const line of [...io.stdout, ...io.stderr, ...human.stdout, ...human.stderr]) {
      expect(line).not.toContain(ESC);
      expect(line).not.toContain(long);
      expect(line).not.toContain("[31m");
    }

    // After INFO_MAX_KEYS entries, the rest count as dropped too.
    const many = Array.from({ length: 500 }, (_, i) => `key${i}`);
    const wide = fakeIo({
      env: { AUTHTEMPO_OPERATOR_SECRET: SECRET },
      fetch: async () => Response.json({ core: "0.0.0", schemaVersion: 10, configKeys: many }),
    });
    expect(await main(["info", BASE, "--json"], wide)).toBe(0);
    const d = docOf(wide.stdout).deployment;
    expect(d?.configKeys).toEqual(many.slice(0, 400));
    expect(d?.dropped).toBe(100);
  });

  it("names an answer that is not an info document, or larger than 64 KiB, as unread", async () => {
    const run = async (body: unknown) => {
      const io = fakeIo({
        env: { AUTHTEMPO_OPERATOR_SECRET: SECRET },
        fetch: async () => Response.json(body),
      });
      const code = await main(["info", BASE, "--json"], io);
      return { code, doc: docOf(io.stdout) };
    };
    for (const body of [
      { core: "0.0.0", schemaVersion: "10", configKeys: [] },
      { core: "0.0.0", schemaVersion: 0, configKeys: [] },
      { core: "0.0.0", schemaVersion: 10000, configKeys: [] },
      { core: "0.0.0", schemaVersion: 10, configKeys: "baseURL" },
      ["baseURL"],
    ]) {
      const { code, doc } = await run(body);
      expect(code, JSON.stringify(body)).toBe(1);
      expect(doc.deployment).toBeNull();
      expect(doc.unread).toEqual([
        { part: "deployment", reason: "the answer is not an info document" },
      ]);
    }
    const big = {
      core: "0.0.0",
      schemaVersion: 10,
      configKeys: Array(4000).fill("abcdefghijklmnop"),
    };
    const { code, doc } = await run(big);
    expect(code).toBe(1);
    expect(doc.deployment).toBeNull();
    expect(doc.unread).toEqual([
      {
        part: "deployment",
        reason: "GET /operator/info answered 200: the answer is larger than 64 KiB",
      },
    ]);
  });

  it("names an off route as unread, and exits 1", async () => {
    const io = fakeIo({
      env: { AUTHTEMPO_OPERATOR_SECRET: SECRET },
      fetch: fetchOf(deployment(false)),
    });
    expect(await main(["info", BASE, "--json"], io)).toBe(1);
    const doc = docOf(io.stdout);
    expect(doc.deployment).toBeNull();
    expect(doc.unread).toEqual([
      {
        part: "deployment",
        reason:
          "GET /operator/info answered 404: the operator route is off, or core is older than 11c2",
      },
    ]);
    expect(doc.exit).toBe(1);
    expect(doc.stopped).toBeNull();

    // A wrong secret: 401, unread, and no stop.
    const wrong = fakeIo({
      env: { AUTHTEMPO_OPERATOR_SECRET: "operator-secret-wrong-wrong-wrong-wrong-wrong" },
      fetch: fetchOf(deployment(true)),
    });
    expect(await main(["info", BASE, "--json"], wrong)).toBe(1);
    expect(docOf(wrong.stdout).unread).toEqual([
      {
        part: "deployment",
        reason: "GET /operator/info answered 401: the deployment refused the operator secret",
      },
    ]);
    // No answer: unread with no host name.
    const silent = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: SECRET } });
    expect(await main(["info", BASE, "--json"], silent)).toBe(1);
    expect(docOf(silent.stdout).unread).toEqual([
      { part: "deployment", reason: "GET /operator/info: no answer" },
    ]);
    for (const line of [...silent.stdout, ...silent.stderr])
      expect(line).not.toContain("api.example.com");
  });

  it("reads the operator secret before any part, so a missing secret costs no connection", async () => {
    const io = fakeIo({
      env: { DATABASE_URL: WRONG_PASSWORD_URL },
    });
    expect(await main(["info", BASE, "--target", "postgres"], io)).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toBe(
      "set AUTHTEMPO_OPERATOR_SECRET to the operator secret, or give --token-env or --token-file",
    );
    expect(io.stderr).not.toContain("reading the postgres database");
    expect(io.requests).toHaveLength(0);
  });

  it("names a connection string that is no URL as unread, and exits 1", async () => {
    const io = fakeIo({ env: { DATABASE_URL: "nonsense" } });
    expect(await main(["info", "--target", "postgres", "--json"], io)).toBe(1);
    const doc = docOf(io.stdout);
    expect(doc.database).toBeNull();
    expect(doc.unread).toEqual([{ part: "database", reason: "storage: ERR_INVALID_URL" }]);
    expect(io.stderr).toEqual(["reading the postgres database"]);
  });

  it("stops the read of a large answer at the cap, and pulls no more of the stream", async () => {
    const chunk = new Uint8Array(16 * 1024).fill(0x61);
    let sent = 0;
    const stream = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          // One MiB in all: the whole body is a proof that the reader read past the cap.
          if (sent >= 1024 * 1024) controller.close();
          else {
            controller.enqueue(chunk);
            sent += chunk.byteLength;
          }
        },
      });
    const io = fakeIo({
      env: { AUTHTEMPO_OPERATOR_SECRET: SECRET },
      fetch: async () =>
        new Response(stream(), { status: 200, headers: { "content-type": "application/json" } }),
    });
    expect(await main(["info", BASE, "--json"], io)).toBe(1);
    expect(docOf(io.stdout).unread).toEqual([
      {
        part: "deployment",
        reason: "GET /operator/info answered 200: the answer is larger than 64 KiB",
      },
    ]);
    // The cap is 64 KiB: the reader cancels the stream on the chunk that passes
    // it. The stream queues one chunk ahead of the reader, so two chunks at most.
    expect(sent).toBeGreaterThan(64 * 1024);
    expect(sent).toBeLessThanOrEqual(64 * 1024 + 2 * chunk.byteLength);
  });

  it("needs --target for the inputs of a database, and the base URL for the inputs of the deployment", async () => {
    for (const [args, message] of [
      [["--url-env", "DATABASE_URL"], "--url-env needs --target postgres"],
      [["--database", "auth"], "--database needs --target d1"],
      [["--token-env", "X"], "--token-env needs the base URL of the deployment"],
      [["--timeout", "5"], "--timeout needs the base URL of the deployment"],
      [
        ["https://a.example.com", "https://b.example.com"],
        "unexpected argument https://b.example.com",
      ],
    ] as const) {
      const io = fakeIo();
      expect(await main(["info", ...args], io), args.join(" ")).toBe(2);
      expect(io.stdout).toEqual([]);
      expect(io.stderr[0]).toBe(message);
    }
  });

  it("holds InfoJson to its key list", async () => {
    const io = fakeIo({ files: PROJECT });
    expect(await main(["info", "--json"], io)).toBe(0);
    expect(Object.keys(docOf(io.stdout)).sort()).toEqual(Object.keys(INFO_JSON_KEYS).sort());
    expect(INFO_MAX_BYTES).toBe(65_536);
    expect(INFO_MAX_KEYS).toBe(400);
    for (const path of ["basePath", "operator.secretHash", "a1", "A.b2"])
      expect(path).toMatch(KEY_PATH);
    for (const path of ["", "1abc", "a.b.c", "a-b", "a.", ".a", "a".repeat(41), "a b"])
      expect(path).not.toMatch(KEY_PATH);
    for (const v of ["0.0.0", "1.2.3", "1.2.3-beta.1", "1.2.3+build.7"])
      expect(v).toMatch(VERSION_TEXT);
    for (const v of ["0.0.0\u001b[31m", "1.2", "v1.2.3", "1.2.3-", `1.2.3-${"a".repeat(41)}`])
      expect(v).not.toMatch(VERSION_TEXT);
  });
});
