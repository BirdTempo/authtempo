// The drift test (plan 11e Task 15, spec 21 item 13). The tool table follows
// the CLI's command table, the flags of each command, its help, and the key
// lists of its --json documents. The test reads each of these from the CLI's
// own entries, never from the tool table that it holds.
import { copyFileSync, mkdirSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  CHECK_JSON_KEYS,
  HELP,
  IMPORT_JSON_KEYS,
  INIT_JSON_KEYS,
  MIGRATE_JSON_KEYS,
  VERSION_JSON_KEYS,
} from "@authtempo/cli";
import { COMMANDS } from "@authtempo/cli/program";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "../../cli/test/support/pg.js";
import { localTools } from "../src/local-tools.js";
import { createServer } from "../src/server.js";
import { TOOLS, type ToolRow } from "../src/tools.js";
import { assertFreshBuild, linesOf, REPO, runServer } from "./support/bin.js";
import { type Called, connect } from "./support/client.js";
import { type FixtureRoot, fixtureRoot } from "./support/fixture-root.js";
import { assertFreshIndex, siteIndex } from "./support/index.js";

/** The commands that no tool wraps, each with its reason (spec 21 item 13). */
const EXEMPT_COMMANDS: Readonly<Record<string, string>> = {
  keys: "it needs the operator secret and changes a live deployment",
  mcp: "it is the installer of this server",
};

/** The --help flag of every command. An agent reads the tool's own schema, not the help text. */
const HELP_FLAG = { help: "it prints the help text and no JSON document" } as const;

/**
 * The flags of each wrapped command that no tool input sets, each with its
 * reason. A flag that the handler passes by itself is here too, because no
 * input key sets it. The lists come from the reviews of plan 11e Tasks 8 to 10.
 */
const EXEMPT_FLAGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  init: {
    ...HELP_FLAG,
    json: "the handler always passes it: the tool reads the one --json document",
  },
  import: {
    ...HELP_FLAG,
    target:
      'the handler sets it: memory or postgres from "against" for migrate.plan, postgres for migrate.run',
    "url-env":
      "the handler passes the server's own --url-env: no input names the variable (spec 21 item 5)",
    "url-file":
      "the server reads the connection string from its environment only, never from a file of the input",
    out: "it writes the bundle of the d1-bundle target, and the tools run against memory or postgres only",
    "dry-run": "migrate.plan always passes it, and migrate.run never does",
    report: "it writes a report file, and the tool answers the report in its result",
    repair:
      "a repair writes into users that exist, and the help says to check each such user in the app first",
    "firebase-signer-key-file":
      "a file of a secret: the input takes the name of the variable, firebase_signer_key_env",
    json: "the handler always passes it: the tool reads the one --json document",
  },
  migrate: {
    ...HELP_FLAG,
    target:
      "the handler always passes postgres: D1 migrations stay a shell command (spec 21 item 6)",
    "url-env":
      "the handler passes the server's own --url-env: no input names the variable (spec 21 item 5)",
    "url-file":
      "the server reads the connection string from its environment only, never from a file of the input",
    database: "a D1 flag: D1 migrations stay a shell command (spec 21 item 6)",
    config: "a D1 flag: D1 migrations stay a shell command (spec 21 item 6)",
    remote: "a D1 flag: D1 migrations stay a shell command (spec 21 item 6)",
    "before-1.7": "a D1 flag with --tables compat: D1 migrations stay a shell command",
    "dry-run": "the handler passes it for dry_run: true, the plan step of a run",
    json: "the handler always passes it: the tool reads the one --json document",
  },
  check: {
    ...HELP_FLAG,
    timeout: "the tool keeps the CLI's default time limit of each request",
    target: "the tool skips the schema check, which needs a database: the shell runs it",
    "url-env": "a flag of the schema check, which the tool skips",
    "url-file": "a flag of the schema check, which the tool skips",
    database: "a flag of the schema check, which the tool skips",
    config: "a flag of the schema check, which the tool skips",
    remote: "a flag of the schema check, which the tool skips",
    json: "the handler always passes it: the tool reads the one --json document",
  },
};

/**
 * The argv parts that each handler adds beside the row's flags and fixed
 * flags, written out from local-tools.ts. DATABASE_URL stands for the
 * server's --url-env, and core for the tables input.
 */
const HANDLER_ARGS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  scaffold: [],
  "migrate.plan": [
    ["--target", "memory"],
    ["--target", "postgres", "--url-env", "DATABASE_URL"],
  ],
  "migrate.run": [["--url-env", "DATABASE_URL"]],
  "schema.migrate": [["--url-env", "DATABASE_URL", "--tables", "core"], ["--dry-run"]],
  check: [],
};

/** The key list of each wrapped command's --json document. */
const KEY_LISTS: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  init: INIT_JSON_KEYS,
  import: IMPORT_JSON_KEYS,
  migrate: MIGRATE_JSON_KEYS,
  check: CHECK_JSON_KEYS,
};

/** The keys that a tool adds to its command's document: the plan handle and the shell command. */
const TOOL_KEYS: Readonly<Record<string, readonly string[]>> = {
  "migrate.plan": ["against", "plan_id", "next"],
  "schema.migrate": ["plan_id", "next"],
};

type Wrapped = ToolRow & { wraps: NonNullable<ToolRow["wraps"]> };
const wrapped = TOOLS.filter((t): t is Wrapped => t.wraps !== null);

const options = (command: string) => {
  const c = COMMANDS[command];
  if (!c) throw new Error(`the CLI has no command ${command}`);
  return c.options;
};

/** True when the help of the command lists --<flag>, as "--flag <value>" or "-n, --flag". */
function inHelp(command: string, flag: string): boolean {
  const help = HELP.find((h) => h.command === command);
  if (!help) throw new Error(`the CLI has no help for ${command}`);
  return help.flags.some((f) => f.flag.split(", ").some((p) => p.split(" ")[0] === `--${flag}`));
}

/** The flag names of an argv part. Each part is a flag, and a string flag takes the next part. */
function flagsOf(argv: readonly string[], command: string, where: string): string[] {
  const known = options(command);
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i] ?? "";
    expect(part.startsWith("--"), `${where}: ${part} is no flag`).toBe(true);
    const name = part.slice(2);
    expect(Object.hasOwn(known, name), `${where}: --${name} is no flag of ${command}`).toBe(true);
    names.push(name);
    if (known[name]?.type === "string") {
      expect(i + 1 < argv.length, `${where}: --${name} has no value`).toBe(true);
      i++;
    }
  }
  return names;
}

describe("the tool table against the CLI", () => {
  it("wraps every command of the CLI or names it as exempt", () => {
    const commands = Object.keys(COMMANDS);
    expect(commands.length).toBeGreaterThan(0);
    const used = new Set(wrapped.map((t) => t.wraps.command));
    for (const name of commands)
      expect(
        used.has(name) !== Object.hasOwn(EXEMPT_COMMANDS, name),
        `${name}: wrapped by a row, or exempt, and not both`,
      ).toBe(true);
    // A row that wraps a command the CLI lacks, or a stale exemption, fails here.
    for (const name of [...used, ...Object.keys(EXEMPT_COMMANDS)])
      expect(Object.hasOwn(COMMANDS, name), `${name} is a command of the CLI`).toBe(true);
  });

  it("passes only flags that the command knows", () => {
    expect(wrapped.length).toBeGreaterThan(0);
    for (const t of wrapped) {
      const { command, flags, positional, fixed, toolOnly } = t.wraps;
      const known = options(command);
      for (const [key, flag] of Object.entries(flags)) {
        expect(Object.hasOwn(known, flag), `${t.name}: --${flag} is no flag of ${command}`).toBe(
          true,
        );
        expect(inHelp(command, flag), `${t.name}: the help of ${command} lists --${flag}`).toBe(
          true,
        );
        expect(Object.hasOwn(t.input.shape, key), `${t.name}: ${key} is an input key`).toBe(true);
      }
      flagsOf(fixed, command, `${t.name} fixed`);
      const parts = HANDLER_ARGS[t.name];
      expect(parts, `${t.name}: the handler's own argv is written out here`).toBeDefined();
      for (const part of parts ?? []) flagsOf(part, command, `${t.name} handler`);
      for (const key of [...positional, ...toolOnly])
        expect(Object.hasOwn(t.input.shape, key), `${t.name}: ${key} is an input key`).toBe(true);
      for (const key of Object.keys(t.input.shape))
        expect(
          Object.hasOwn(flags, key) || positional.includes(key) || toolOnly.includes(key),
          `${t.name}: the input ${key} maps to a flag, a positional, or the tool`,
        ).toBe(true);
    }
  });

  it("maps each flag of a wrapped command to an input, or names it as exempt", () => {
    const commands = [...new Set(wrapped.map((t) => t.wraps.command))].sort();
    expect(Object.keys(EXEMPT_FLAGS).sort()).toEqual(commands);
    for (const command of commands) {
      const known = Object.keys(options(command));
      const exempt = EXEMPT_FLAGS[command] ?? {};
      const passed = new Set(
        wrapped
          .filter((t) => t.wraps.command === command)
          .flatMap((t) => Object.values(t.wraps.flags)),
      );
      for (const flag of known)
        expect(
          passed.has(flag) !== Object.hasOwn(exempt, flag),
          `${command} --${flag}: set by an input, or exempt, and not both`,
        ).toBe(true);
      for (const [flag, reason] of Object.entries(exempt)) {
        expect(known, `${command}: the exempt flag --${flag} is a flag of the CLI`).toContain(flag);
        expect(reason.length, `${command} --${flag}: the reason`).toBeGreaterThan(0);
      }
    }
  });

  it("answers the keys of the CLI's JSON", () => {
    for (const t of wrapped) {
      const list = KEY_LISTS[t.wraps.command];
      expect(list, `${t.name}: the key list of ${t.wraps.command}`).toBeDefined();
      expect([...t.outputKeys].sort(), t.name).toEqual(
        [...Object.keys(list ?? {}), ...(TOOL_KEYS[t.name] ?? [])].sort(),
      );
    }
    for (const name of Object.keys(TOOL_KEYS))
      expect(
        wrapped.map((t) => t.name),
        `${name} is a row`,
      ).toContain(name);
    // The version tool answers the keys of `authtempo --version --json` among its own.
    const version = TOOLS.find((t) => t.name === "version");
    expect(version?.outputKeys).toEqual(expect.arrayContaining(Object.keys(VERSION_JSON_KEYS)));
  });
});

/** A deployment that answers 404 to each request: check then answers a result with failures. */
async function notFoundServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

const FIXTURES = join(REPO, "packages/import/test/fixtures");

describe("the tool table on the wire", () => {
  let fx: FixtureRoot | undefined;
  let db: Awaited<ReturnType<typeof freshDatabase>> | undefined;
  let deployment: Awaited<ReturnType<typeof notFoundServer>> | undefined;
  beforeAll(() => {
    assertFreshBuild();
    assertFreshIndex();
  });
  afterAll(async () => {
    fx?.remove();
    await deployment?.close();
    await db?.drop();
  });

  it("answers the keys of the CLI's JSON in a real call of each tool", async () => {
    db = await freshDatabase();
    deployment = await notFoundServer();
    fx = fixtureRoot();
    mkdirSync(join(fx.root, "supabase"));
    copyFileSync(join(FIXTURES, "supabase-users.csv"), join(fx.root, "supabase/users.csv"));
    copyFileSync(join(FIXTURES, "supabase-identities.csv"), join(fx.root, "supabase/ids.csv"));
    const s = await connect(
      createServer({
        surface: "local",
        index: siteIndex(),
        skills: [],
        root: fx.root,
        env: { PATH: process.env.PATH ?? "", DATABASE_URL: db.url },
        local: localTools,
      }),
    );
    const calls: [string, Called][] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await s.call(name, args);
      expect(r.isError, `${name}: ${r.texts.join("\n")}`).toBe(false);
      calls.push([name, r]);
      return r.structured ?? {};
    };
    try {
      await call("docs.search", { query: "magic link" });
      await call("docs.read", { path: "/docs/guides/magic-link/" });
      await call("version", {});
      await call("scaffold", { dir: "app", stack: "workers-d1" });
      const schemaPlan = await call("schema.migrate", { dry_run: true });
      await call("schema.migrate", { plan_id: schemaPlan.plan_id, confirm: true });
      const users = {
        provider: "supabase",
        users: "supabase/users.csv",
        identities: "supabase/ids.csv",
        formats: "bcrypt",
      };
      await call("migrate.plan", { ...users, against: "empty" });
      const plan = await call("migrate.plan", { ...users, against: "database" });
      await call("migrate.run", { ...users, plan_id: plan.plan_id, confirm: true });
      await call("check", { base_url: deployment.origin });
    } finally {
      await s.close();
    }
    // Each row of the table gets a call, and each answer has the row's keys.
    expect([...new Set(calls.map(([name]) => name))].sort()).toEqual(
      TOOLS.map((t) => t.name).sort(),
    );
    for (const [name, r] of calls) {
      const keys = TOOLS.find((t) => t.name === name)?.outputKeys ?? [];
      expect(Object.keys(r.structured ?? {}).sort(), name).toEqual([...keys].sort());
    }
  });

  it("serves the same tool table on the wire", async () => {
    // The local surface: the built binary on raw JSON-RPC.
    const run = await runServer(
      [],
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "drift-test", version: "0.0.0" },
          },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      ],
    );
    const answer = linesOf(run.stdout)
      .map((l) => JSON.parse(l) as { id?: unknown; result?: { tools?: unknown } })
      .find((m) => m.id === 2);
    const local = (answer?.result?.tools ?? []) as Listed[];
    expect(local.length, run.stderr).toBeGreaterThan(0);
    holdToRows(local, "local");

    // The remote surface: the same factory, in process.
    const remote = await connect(
      createServer({ surface: "remote", index: siteIndex(), skills: [] }),
    );
    try {
      holdToRows((await remote.client.listTools()).tools as Listed[], "remote");
    } finally {
      await remote.close();
    }
  });
});

interface Listed {
  name: string;
  inputSchema: { additionalProperties?: unknown; properties?: Record<string, unknown> };
  outputSchema?: { properties?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
}

/** The listed tools equal the rows of the surface, both ways, with each schema strict and each hint of the row. */
function holdToRows(listed: readonly Listed[], surface: "local" | "remote"): void {
  const rows = TOOLS.filter((t) => t.surfaces.includes(surface));
  expect(listed.map((t) => t.name).sort(), surface).toEqual(rows.map((t) => t.name).sort());
  for (const t of listed) {
    const r = rows.find((x) => x.name === t.name);
    expect(t.inputSchema.additionalProperties, `${surface} ${t.name}`).toBe(false);
    expect(Object.keys(t.inputSchema.properties ?? {}).sort(), `${surface} ${t.name}`).toEqual(
      Object.keys(r?.input.shape ?? {}).sort(),
    );
    expect(Object.keys(t.outputSchema?.properties ?? {}).sort(), `${surface} ${t.name}`).toEqual(
      [...(r?.outputKeys ?? [])].sort(),
    );
    expect(t.annotations, `${surface} ${t.name}`).toEqual(r?.annotations);
  }
}
