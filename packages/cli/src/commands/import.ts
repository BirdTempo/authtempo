import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createMemoryAdapter } from "@authtempo/core";
import { COMMON_OPTIONS, oneOf, parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { UsageError } from "../errors.js";
import { IMPORT_HELP } from "../help/import.js";
import type { ImportJson } from "../json.js";
import { describeUrl, printJson, sayer } from "../output.js";
import { importGate, readableVersion } from "../schema-version.js";
import { openPostgres } from "../seams/postgres.js";
import { DEFAULT_URL_ENV, readSecret } from "../secrets.js";
import {
  type CliIo,
  type ImportValues,
  type ParsedImport,
  PROVIDERS,
  parseImportValues,
  runParsed,
} from "./import-core.js";
import { checkVerifyFlags, splitVerify } from "./import-verify.js";

const OPTIONS = {
  ...COMMON_OPTIONS,
  users: { type: "string" },
  identities: { type: "string" },
  csv: { type: "string" },
  hashes: { type: "string" },
  organizations: { type: "string" },
  memberships: { type: "string" },
  "authjs-tables": { type: "string" },
  "firebase-signer-key-env": { type: "string" },
  "firebase-signer-key-file": { type: "string" },
  "firebase-salt-separator": { type: "string" },
  "firebase-rounds": { type: "string" },
  "firebase-mem-cost": { type: "string" },
  "password-column": { type: "string" },
  "same-passkey-rp-id": { type: "boolean" },
  target: { type: "string" },
  tables: { type: "string" },
  "url-env": { type: "string" },
  "url-file": { type: "string" },
  out: { type: "string" },
  "dry-run": { type: "boolean", short: "n" },
  repair: { type: "boolean" },
  "on-email-taken": { type: "string" },
  formats: { type: "string" },
  "legacy-verify": { type: "boolean" },
  "role-map": { type: "string" },
  "reserved-slugs": { type: "string" },
  "platform-slug": { type: "string" },
  report: { type: "string" },
} as const;

/** The old flags of the alias, each with its new form (spec 19, the flag map). */
const RENAMED: Readonly<Record<string, string>> = {
  "--postgres":
    "use --target postgres with --url-env <NAME> or --url-file <path>, so the connection string stays out of the command line",
  "--better-auth": "use --tables compat",
  "--d1-bundle": "use --target d1-bundle --out <file>",
  "--firebase-signer-key":
    "use --firebase-signer-key-env <NAME> or --firebase-signer-key-file <path>",
};

/** The old name of a flag, as the new command names it in a message. */
const NEW_NAMES: Readonly<Record<string, string>> = {
  tables: "authjs-tables",
  "firebase-signer-key": "firebase-signer-key-env",
};

/**
 * `authtempo import <provider>` (spec 19): the import CLI under the new name,
 * with the target and the table set as closed flags, and every secret read
 * by the no-secret rule. It maps its flags onto the old names and calls the
 * same checks and the same run as the alias.
 */
export const importCommand: Command = {
  help: IMPORT_HELP,
  options: OPTIONS,
  async run(argv, ctx) {
    for (const arg of argv) {
      // After --, parseArgs reads each argument as a positional, not as a flag.
      if (arg === "--") break;
      const flag = arg.split("=")[0] ?? arg;
      const hint = Object.hasOwn(RENAMED, flag) ? RENAMED[flag] : undefined;
      if (hint !== undefined) throw new UsageError(`authtempo import takes no ${flag}: ${hint}`);
    }
    const { values: v, positionals } = parseOrUsage(
      () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
      Object.keys(OPTIONS),
    );
    if (
      v.tables !== undefined &&
      v.tables !== "core" &&
      v.tables !== "compat" &&
      v.tables.endsWith(".json")
    )
      throw new UsageError(
        "--tables names the table set, core or compat; an Auth.js export is --authjs-tables <file>",
      );
    // `import verify` (owner decision 3): the provider first, as the plain
    // command names it, then the flags that a read-only run refuses.
    const { verify, rest } = splitVerify(positionals);
    if (verify) {
      if (rest.length === 0) throw new UsageError(`name one provider: ${PROVIDERS.join(", ")}`);
      checkVerifyFlags(v);
    }
    const target = oneOf("target", v.target, ["postgres", "d1-bundle", "memory"] as const);
    if (target === undefined)
      throw new UsageError(
        "name a target: --target postgres, --target d1-bundle, or --target memory",
      );
    const tables = oneOf("tables", v.tables, ["core", "compat"] as const) ?? "core";
    if (target === "d1-bundle") {
      if (v.out === undefined) throw new UsageError("--target d1-bundle needs --out <file>");
      if (tables === "compat")
        throw new UsageError(
          "--tables compat needs --target postgres; on D1, set TARGET=compat on the import Worker",
        );
    } else if (v.out !== undefined) throw new UsageError("--out needs --target d1-bundle");
    // The secrets come first: a missing variable must not cost the read of a large export.
    const url =
      target === "postgres"
        ? readSecret(ctx, {
            envFlag: "url-env",
            fileFlag: "url-file",
            env: v["url-env"],
            file: v["url-file"],
            defaultEnv: DEFAULT_URL_ENV,
            what: "the connection string",
          })
        : undefined;
    const signerKey =
      v["firebase-signer-key-env"] !== undefined || v["firebase-signer-key-file"] !== undefined
        ? readSecret(ctx, {
            envFlag: "firebase-signer-key-env",
            fileFlag: "firebase-signer-key-file",
            env: v["firebase-signer-key-env"],
            file: v["firebase-signer-key-file"],
            defaultEnv: "",
            what: "the Firebase signer key",
          })
        : undefined;
    const values: ImportValues = {
      users: v.users,
      identities: v.identities,
      csv: v.csv,
      hashes: v.hashes,
      organizations: v.organizations,
      memberships: v.memberships,
      tables: v["authjs-tables"],
      "firebase-signer-key": signerKey,
      "firebase-salt-separator": v["firebase-salt-separator"],
      "firebase-rounds": v["firebase-rounds"],
      "firebase-mem-cost": v["firebase-mem-cost"],
      "password-column": v["password-column"],
      "same-passkey-rp-id": v["same-passkey-rp-id"],
      postgres: url,
      "better-auth": tables === "compat" ? true : undefined,
      "d1-bundle": target === "d1-bundle" ? v.out : undefined,
      memory: target === "memory" ? true : undefined,
      verify: verify ? true : undefined,
      "dry-run": verify ? true : v["dry-run"],
      repair: v.repair,
      "on-email-taken": v["on-email-taken"],
      formats: v.formats,
      "legacy-verify": v["legacy-verify"],
      "role-map": v["role-map"],
      "reserved-slugs": v["reserved-slugs"],
      "platform-slug": v["platform-slug"],
      report: v.report,
    };
    const json = v.json === true;
    const io: CliIo = {
      out: sayer(ctx, json),
      err: (line) => ctx.err(line),
      readFile: (p) => {
        const abs = resolve(ctx.cwd, p);
        // An export holds addresses and can hold hashes (spec 23 item 6). A
        // warning, not a stop: the file is the operator's.
        if ((ctx.fileMode(abs) & 0o077) !== 0)
          ctx.err(
            `warning: ${p} is readable by other users of this machine; an export holds addresses and can hold password hashes`,
          );
        return ctx.readFile(abs);
      },
      writeFile: (p, t) => ctx.writePrivate(resolve(ctx.cwd, p), t),
      async openStorage(u, betterAuth) {
        ctx.err(`connecting to ${describeUrl(u)}`);
        const pg = openPostgres(u, 2);
        // A refused connection stops here, as "storage: ...; nothing was written".
        try {
          await pg.ping();
          // Before the first row read or write: a database at another version
          // stops the run with nothing written (spec 23 item 4).
          const appliedCore = (await pg.appliedCore()).length;
          importGate(
            readableVersion(await pg.schemaVersionText(), appliedCore),
            betterAuth ? "compat" : "core",
            { appliedCore, compatVersion: await pg.compatVersion() },
          );
        } catch (e) {
          await pg.close();
          throw e;
        }
        return {
          storage: betterAuth ? pg.compatStorage() : pg.coreStorage(),
          close: () => pg.close(),
        };
      },
      // An empty store: the plan shows no conflict with rows of a database (plan 11e).
      openMemory: async () => ({ storage: createMemoryAdapter(), close: async () => {} }),
    };
    let parsed: ParsedImport;
    try {
      parsed = parseImportValues(rest, values, io, (n) =>
        Object.hasOwn(NEW_NAMES, n) ? (NEW_NAMES[n] ?? n) : n,
      );
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e));
    }
    const outcome = await runParsed(parsed, io);
    if (json)
      printJson(ctx, {
        report: outcome.report,
        stopped: outcome.stopped,
        bundle: outcome.bundle,
        verify: outcome.verify,
        exit: outcome.code,
      } satisfies ImportJson);
    return outcome.code;
  },
};
