import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BASE,
  envFileText,
  envOf,
  MAX_SLOT,
  portOf,
  SERVICES,
  SLOT_0,
  STRIDE,
} from "../../../scripts/test-ports.mjs";
import { REPO } from "../scripts/lib/paths.ts";

// The port table of the test servers (plan test-servers-per-worktree, Task 1).
// Each worktree that runs tests has its own slot, and each slot its own ports.

describe("the port table of the test servers", () => {
  it("keeps the ports of the running set for slot 0", () => {
    expect(SERVICES.map((s) => [s.name, portOf(0, s.name)])).toEqual([
      ["postgres", 5439],
      ["libsql", 8089],
      ["libsql-cli", 8090],
      ["libsql-cli-compat", 8091],
      ["mysql84", 3384],
      ["mysql97", 3397],
    ]);
  });

  it("answers base plus slot times ten plus the offset for a slot above 0", () => {
    expect(SERVICES.map((s) => portOf(3, s.name))).toEqual([
      20030, 20031, 20032, 20033, 20034, 20035,
    ]);
    expect(portOf(99, "mysql97")).toBe(20995);
  });

  it("gives no port to two slots", () => {
    const seen = new Map<number, string>();
    for (let slot = 0; slot <= MAX_SLOT; slot++)
      for (const s of SERVICES) {
        const port = portOf(slot, s.name);
        expect(seen.get(port), `${port}`).toBeUndefined();
        seen.set(port, `${slot}/${s.name}`);
      }
    expect(seen.size).toBe(600);
  });

  it("refuses an unknown service and a slot outside 0 to 99", () => {
    expect(() => portOf(1, "redis")).toThrow("unknown test service: redis");
    expect(() => portOf(100, "postgres")).toThrow("slot 100 is outside 0 to 99");
    expect(() => portOf(-1, "postgres")).toThrow("slot -1 is outside 0 to 99");
    expect(() => portOf(1.5, "postgres")).toThrow("slot 1.5 is outside 0 to 99");
  });

  it("names each server by its variable, with the port of the slot", () => {
    expect(envOf(2, ["postgres"])).toEqual({
      TEMPO_AUTH_PG_URL: "postgres://tempo:tempo@localhost:20020/tempo_auth",
    });
    expect(envOf(1, ["libsql", "libsql-cli", "libsql-cli-compat", "mysql84", "mysql97"])).toEqual({
      AUTHTEMPO_LIBSQL_URL: "http://127.0.0.1:20011",
      AUTHTEMPO_LIBSQL_CLI_URL: "http://127.0.0.1:20012",
      AUTHTEMPO_LIBSQL_COMPAT_URL: "http://127.0.0.1:20013",
      AUTHTEMPO_MYSQL84_URL: "mysql://root:tempo@127.0.0.1:20014/",
      AUTHTEMPO_MYSQL97_URL: "mysql://root:tempo@127.0.0.1:20015/",
    });
  });

  it("writes the env file as sorted KEY=VALUE lines", () => {
    expect(envFileText(4, ["mysql84", "postgres"])).toBe(
      "AUTHTEMPO_MYSQL84_URL=mysql://root:tempo@127.0.0.1:20044/\n" +
        "TEMPO_AUTH_PG_URL=postgres://tempo:tempo@localhost:20040/tempo_auth\n",
    );
  });
});

// The machine checks of the design (section 6, Task 5). A test port in any
// other file is a second source that can drift, and a variable that turbo
// drops sends a helper to no server.

const TREES = ["packages", "examples", "apps", "scripts"];
/** Folders of output, caches, and installs. Every folder whose name starts with a dot is skipped too. */
const SKIP = new Set(["node_modules", "dist", "coverage", "results"]);
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm|pdf|zip|gz|tgz|db|sqlite)$/;

/**
 * Lines that may hold a test port, each with its reason. The table itself;
 * the test of the table, which types each port as a literal (lane rule:
 * never read the expected value from the constant it pins); and the sample
 * config of `wrangler dev`, which a person runs on main (slot 0) and the
 * docs page start/workers-hyperdrive.mdx shows.
 */
const EXEMPT: { file: string; line?: RegExp }[] = [
  { file: "scripts/test-ports.mjs" },
  { file: "apps/site/test/test-ports.test.ts" },
  { file: "examples/worker-postgres/wrangler.jsonc", line: /^\s*"localConnectionString": / },
];

/** Every text file of the trees, as a path from the repo root. */
function files(dir: string): string[] {
  return readdirSync(`${REPO}${dir}`, { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name.startsWith(".") || SKIP.has(e.name) ? [] : files(path);
    return e.isFile() && !BINARY.test(e.name) ? [path] : [];
  });
}
const SOURCES = TREES.flatMap(files);

/** The lines that hold a slot 0 port or a port of slots 1 to MAX_SLOT, outside the exempt lines. */
function portLines(sources: readonly { file: string; text: string }[]): string[] {
  const legacy = new Set(Object.values(SLOT_0));
  const low = BASE + STRIDE;
  const high = BASE + MAX_SLOT * STRIDE + STRIDE - 1;
  const hits: string[] = [];
  for (const { file, text: whole } of sources) {
    whole.split("\n").forEach((text, i) => {
      // A whole number: no letter, digit, or decimal point touches it, so a hash or 1.5439 is no port.
      const ports = [...text.matchAll(/(?<!\w|\d\.)\d{4,5}(?!\w|\.\d)/g)].map((m) => Number(m[0]));
      if (!ports.some((p) => legacy.has(p) || (p >= low && p <= high))) return;
      const exempt = EXEMPT.some(
        (x) => x.file === file && (x.line === undefined || x.line.test(text)),
      );
      if (!exempt) hits.push(`${file}:${i + 1}: ${text.trim()}`);
    });
  }
  return hits;
}

describe("the machine checks of the test servers", () => {
  it("scans the trees", () => {
    // 1,900 files counted 2026-10-22; a scan of no file would pass every check.
    expect(SOURCES.length).toBeGreaterThan(1500);
    expect(SOURCES).toContain("packages/adapter-postgres/test/db.ts");
  });

  it("finds no test port outside scripts/test-ports.mjs", () => {
    const all = SOURCES.map((file) => ({ file, text: readFileSync(`${REPO}${file}`, "utf8") }));
    expect(portLines(all)).toEqual([]);
  });

  it("finds a test port in a helper line, so the scan can fail", () => {
    // The ports are built from parts, so this file holds no port line of its own.
    const pg = `${54}${39}`;
    const slot3 = `${200}${34}`;
    const text = [
      `const url = env.TEMPO_AUTH_PG_URL ?? "postgres://tempo:tempo@localhost:${pg}/tempo_auth";`,
      `const mysql = "mysql://root:tempo@127.0.0.1:${slot3}/";`,
      "const timeout = 20000; const year = 2026; const other = 5432; const v = 1.5439;",
      `const hash = "a7f${slot3}ad";`,
      `It listens on port ${pg}.`,
    ].join("\n");
    expect(portLines([{ file: "packages/x/test/db.ts", text }])).toEqual([
      `packages/x/test/db.ts:1: const url = env.TEMPO_AUTH_PG_URL ?? "postgres://tempo:tempo@localhost:${pg}/tempo_auth";`,
      `packages/x/test/db.ts:2: const mysql = "mysql://root:tempo@127.0.0.1:${slot3}/";`,
      `packages/x/test/db.ts:5: It listens on port ${pg}.`,
    ]);
    // The exempt line of wrangler.jsonc is one line, not the whole file.
    expect(portLines([{ file: "examples/worker-postgres/wrangler.jsonc", text }]).length).toBe(3);
  });

  it("passes each variable that a helper reads to the tests and writes it to the env file", () => {
    const read = new Set<string>();
    for (const file of SOURCES)
      for (const m of readFileSync(`${REPO}${file}`, "utf8").matchAll(
        /\b(?:TEMPO_AUTH|AUTHTEMPO)_[A-Z0-9_]+_URL\b/g,
      ))
        read.add(m[0]);
    expect([...read].sort()).toEqual([
      "AUTHTEMPO_LIBSQL_CLI_URL",
      "AUTHTEMPO_LIBSQL_COMPAT_URL",
      "AUTHTEMPO_LIBSQL_URL",
      "AUTHTEMPO_MYSQL84_URL",
      "AUTHTEMPO_MYSQL97_URL",
      "TEMPO_AUTH_PG_URL",
    ]);
    const turbo = JSON.parse(
      readFileSync(`${REPO}turbo.json`, "utf8").replace(/^\s*\/\/.*$/gm, ""),
    ) as { globalPassThroughEnv?: string[] };
    const envFile = envFileText(
      1,
      SERVICES.map((s) => s.name),
    );
    for (const name of [...read, ...SERVICES.map((s) => s.envVar)]) {
      expect(turbo.globalPassThroughEnv ?? [], name).toContain(name);
      expect(envFile, name).toMatch(new RegExp(`^${name}=`, "m"));
    }
  });
});
