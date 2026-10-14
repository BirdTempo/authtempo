import { join } from "node:path";
import { parseArgs } from "node:util";
import { COMMON_OPTIONS, oneOf, parseOrUsage } from "../args.js";
import { runChecks } from "../checks.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { CHECK_HELP } from "../help/check.js";
import type { CheckJson } from "../json.js";
import { baseOf, basePathOf, timeoutOf } from "../net.js";
import { describeUrl, printJson } from "../output.js";
import { readableVersion, readD1Version } from "../schema-version.js";
import { findWranglerConfig, readD1Project, wranglerOf } from "../seams/d1.js";
import { openPostgres } from "../seams/postgres.js";
import { readSecret } from "../secrets.js";
import { SCHEMA_VERSION } from "../version.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  "base-path": { type: "string" },
  timeout: { type: "string" },
  strict: { type: "boolean" },
  target: { type: "string" },
  "url-env": { type: "string" },
  "url-file": { type: "string" },
  database: { type: "string" },
  config: { type: "string" },
  remote: { type: "boolean" },
} as const;

const POSTGRES_FLAGS = ["url-env", "url-file"] as const;
const D1_FLAGS = ["database", "config", "remote"] as const;

/**
 * `authtempo check <base url>` (spec 19). It runs `runChecks` over the
 * network, with the schema check on the database that `--target` names.
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
    const target = oneOf("target", v.target, ["d1", "postgres"] as const);
    for (const flag of POSTGRES_FLAGS)
      if (v[flag] !== undefined && target !== "postgres")
        throw new UsageError(`--${flag} needs --target postgres`);
    for (const flag of D1_FLAGS)
      if (v[flag] !== undefined && target !== "d1")
        throw new UsageError(`--${flag} needs --target d1`);
    let readSchema: (() => Promise<number | null>) | undefined;
    if (target === "postgres") {
      const url = readSecret(ctx, {
        envFlag: "url-env",
        fileFlag: "url-file",
        env: v["url-env"],
        file: v["url-file"],
        defaultEnv: "DATABASE_URL",
        what: "the connection string",
      });
      readSchema = async () => {
        ctx.err(`connecting to ${describeUrl(url)}`);
        const pg = openPostgres(url, 1);
        try {
          // The rule of migrate: a version that is no whole number, or no version row over
          // applied migrations, stops the run (exit 2), because this CLI cannot place the database.
          const applied = await pg.appliedCore();
          return readableVersion(await pg.schemaVersionText(), applied.length);
        } finally {
          await pg.close();
        }
      };
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
    });
    for (const w of report.warnings) ctx.err(`warning: ${w}`);
    if (v.json === true) printJson(ctx, report satisfies CheckJson);
    else {
      for (const c of report.checks)
        ctx.out(`${c.status.padEnd(4)}  ${c.id}${c.code ? ` ${c.code}` : ""}: ${c.detail}`);
      const s = report.summary;
      ctx.out(`checks: ${s.run} run, ${s.pass} pass, ${s.fail} fail, ${s.skip} skip`);
    }
    return report.summary.fail > 0 ? 1 : 0;
  },
};
