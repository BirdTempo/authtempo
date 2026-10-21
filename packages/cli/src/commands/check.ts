import { join } from "node:path";
import { parseArgs } from "node:util";
import { expectedD1Shape } from "@authtempo/adapter-d1";
import { expectedMysqlShape } from "@authtempo/adapter-mysql";
import { expectedPostgresShape } from "@authtempo/adapter-postgres";
import { expectedSqliteShape } from "@authtempo/adapter-sqlite";
import type { ExpectedShape, LiveShape } from "@authtempo/core/sql";
import { COMMON_OPTIONS, oneOf, parseOrUsage } from "../args.js";
import { type CheckInput, runChecks } from "../checks.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { CHECK_HELP } from "../help/check.js";
import type { CheckJson } from "../json.js";
import { baseOf, basePathOf, timeoutOf } from "../net.js";
import { describeUrl, printJson } from "../output.js";
import { readableVersion, readD1Version } from "../schema-version.js";
import {
  findWranglerConfig,
  readD1CompatText,
  readD1Project,
  readD1Shape,
  wranglerOf,
} from "../seams/d1.js";
import { openMysql } from "../seams/mysql.js";
import {
  openPostgres,
  type PostgresSeam,
  readPostgresLiveShape,
  storageFailure,
} from "../seams/postgres.js";
import { openSqlite } from "../seams/sqlite.js";
import { DEFAULT_URL_ENV, readSecret } from "../secrets.js";
import { SCHEMA_VERSION } from "../version.js";
import { readUrl, sqliteSourceOf } from "./migrate.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  "base-path": { type: "string" },
  timeout: { type: "string" },
  strict: { type: "boolean" },
  target: { type: "string" },
  "url-env": { type: "string" },
  "url-file": { type: "string" },
  file: { type: "string" },
  "auth-token-env": { type: "string" },
  "auth-token-file": { type: "string" },
  database: { type: "string" },
  config: { type: "string" },
  remote: { type: "boolean" },
} as const;

/**
 * A database holds the compat tables when its `compat_better_auth` row has a
 * text other than "0" (ruling 11 of plan 11c2). The compat migrations write
 * "1" and up; a core database has no row.
 */
const compatRow = (text: string | null) => text !== null && text !== "0";

const URL_FLAGS = ["url-env", "url-file"] as const;
const D1_FLAGS = ["database", "config", "remote"] as const;
const SQLITE_FLAGS = ["file", "auth-token-env", "auth-token-file"] as const;

/** The members of a SQLite or MySQL seam that the two schema checks call. */
interface ReadSeam {
  ping(): Promise<void>;
  appliedCore(): Promise<string[]>;
  schemaVersionText(): Promise<string | null>;
  liveShape(): Promise<LiveShape>;
  close(): Promise<void>;
}

/**
 * The two schema checks on a seam of SQLite or MySQL (plan 12g Task 6). Each
 * read opens the seam, reads, and closes it, as the Postgres reads do. A
 * driver error leaves the seam as a Stop (exit 2). `compat` answers whether
 * the database holds the compat tables.
 */
function seamInputs<S extends ReadSeam>(
  open: () => Promise<S>,
  note: () => void,
  expected: ExpectedShape,
  compat: (seam: S) => Promise<boolean>,
): { readSchema: () => Promise<number | null>; shape: NonNullable<CheckInput["shape"]> } {
  const using = async <T>(f: (seam: S) => Promise<T>): Promise<T> => {
    const seam = await open();
    try {
      return await f(seam);
    } finally {
      await seam.close();
    }
  };
  return {
    readSchema: () => {
      note();
      return using(async (seam) => {
        await seam.ping();
        const applied = await seam.appliedCore();
        // The rule of migrate: a version that is no whole number stops the run (exit 2).
        return readableVersion(await seam.schemaVersionText(), applied.length);
      });
    },
    shape: {
      expected,
      read: () => using((seam) => seam.liveShape()),
      compat: () => using(compat),
    },
  };
}

/**
 * `authtempo check <base url>` (spec 19). It runs `runChecks` over the
 * network, with the two schema checks on the database that `--target` names.
 * Exit 0 when no check fails, 1 when one fails, 2 when a host or the
 * database gives no answer.
 */
export const checkCommand: Command = {
  help: CHECK_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    const { values: v, positionals } = parseOrUsage(
      () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
      Object.keys(OPTIONS),
    );
    if (positionals.length > 1) throw new UsageError(`unexpected argument ${positionals[1]}`);
    // check sends no secret: a remote http base is the failure base_not_https, not a usage error.
    const base = baseOf(positionals[0], { allowHttp: true });
    const basePath = basePathOf(v["base-path"]);
    const timeoutMs = timeoutOf(v.timeout);
    const target = oneOf("target", v.target, ["d1", "postgres", "sqlite", "mysql"] as const);
    for (const flag of URL_FLAGS)
      if (v[flag] !== undefined && (target === undefined || target === "d1"))
        throw new UsageError(`--${flag} needs --target postgres, mysql, or sqlite`);
    for (const flag of D1_FLAGS)
      if (v[flag] !== undefined && target !== "d1")
        throw new UsageError(`--${flag} needs --target d1`);
    for (const flag of SQLITE_FLAGS)
      if (v[flag] !== undefined && target !== "sqlite")
        throw new UsageError(`--${flag} needs --target sqlite`);
    let readSchema: (() => Promise<number | null>) | undefined;
    let shape: CheckInput["shape"];
    if (target === "postgres") {
      const url = readSecret(ctx, {
        envFlag: "url-env",
        fileFlag: "url-file",
        env: v["url-env"],
        file: v["url-file"],
        defaultEnv: DEFAULT_URL_ENV,
        what: "the connection string",
      });
      readSchema = async () => {
        ctx.err(`connecting to ${describeUrl(url)}`);
        // The open is inside the try: a string that is no URL throws there (ERR_INVALID_URL).
        let pg: PostgresSeam | undefined;
        try {
          let applied: string[];
          let text: string | null;
          try {
            pg = openPostgres(url, 1);
            await pg.ping();
            applied = await pg.appliedCore();
            text = await pg.schemaVersionText();
          } catch (e) {
            throw new Stop(storageFailure(e, url));
          }
          // The rule of migrate: a version that is no whole number, or no version row over
          // applied migrations, stops the run (exit 2), because this CLI cannot place the database.
          return readableVersion(text, applied.length);
        } finally {
          await pg?.close();
        }
      };
      shape = {
        expected: expectedPostgresShape(),
        read: () => readPostgresLiveShape(url),
        async compat() {
          const pg = openPostgres(url, 1);
          try {
            return compatRow(await pg.compatText());
          } catch (e) {
            throw new Stop(storageFailure(e, url));
          } finally {
            await pg.close();
          }
        },
      };
    } else if (target === "sqlite") {
      const source = sqliteSourceOf(ctx, v);
      const where =
        "file" in source ? `opening ${source.file}` : `connecting to ${describeUrl(source.url)}`;
      ({ readSchema, shape } = seamInputs(
        () => openSqlite(source, (s) => ctx.addSecret(s), { readOnly: true }),
        () => ctx.err(where),
        expectedSqliteShape(),
        async (seam) => compatRow(await seam.compatText()),
      ));
    } else if (target === "mysql") {
      const url = readUrl(ctx, v);
      ({ readSchema, shape } = seamInputs(
        async () => openMysql(url, (s) => ctx.addSecret(s)),
        () => ctx.err(`connecting to ${describeUrl(url)}`),
        expectedMysqlShape(),
        // Owner decision 4 of plan 12g: no compat tables on MySQL.
        async () => false,
      ));
    } else if (target === "d1") {
      const project = readD1Project(ctx, findWranglerConfig(ctx, v.config), v.database);
      if (!ctx.exists(wranglerOf(project.cwd)))
        throw new Stop(
          `no wrangler in ${join(project.cwd, "node_modules")}: install the packages of the project first`,
        );
      const t = { ...project, remote: v.remote === true };
      readSchema = async () => {
        ctx.err(`reading the ${t.remote ? "remote" : "local"} D1 database ${t.database}`);
        return (await readD1Version(ctx, t)).version;
      };
      shape = {
        expected: expectedD1Shape(),
        read: () => readD1Shape(ctx, t),
        compat: async () => compatRow(await readD1CompatText(ctx, t)),
      };
    }
    ctx.err(`reading ${base}${basePath} and ${base}/.well-known/`);
    const report = await runChecks({
      base,
      basePath,
      fetch: (url, init) => ctx.fetch(url, init),
      timeoutMs,
      schemaVersion: SCHEMA_VERSION,
      strict: v.strict === true,
      ...(readSchema ? { readSchema } : {}),
      ...(shape ? { shape } : {}),
    });
    for (const w of report.warnings) ctx.err(`warning: ${w}`);
    const exit = report.summary.fail > 0 ? 1 : 0;
    if (v.json === true) printJson(ctx, { ...report, exit, stopped: null } satisfies CheckJson);
    else {
      for (const c of report.checks)
        ctx.out(`${c.status.padEnd(4)}  ${c.id}${c.code ? ` ${c.code}` : ""}: ${c.detail}`);
      const s = report.summary;
      ctx.out(`checks: ${s.run} run, ${s.pass} pass, ${s.fail} fail, ${s.skip} skip`);
    }
    return exit;
  },
};
