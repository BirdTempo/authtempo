import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { writePrivate } from "../io.js";
import { scrub, secretParts } from "../output.js";
import { openPostgres } from "../seams/postgres.js";
import { type CliIo, type ParsedImport, parseImportValues, runParsed } from "./import-core.js";

// `authtempo-import`, the old binary, for one release (owner decision 4).
// Its flags, its usage text, and its exit codes are those of the import CLI
// before plan 11c, so the moved suite test/import-alias.test.ts holds them.

export { exitCode, summary } from "@authtempo/import";
export type { CliIo } from "./import-core.js";
export { writePrivate };

export const USAGE = `authtempo-import <provider> [files] (--postgres <url> | --d1-bundle <file>) [options]

providers and files:
  supabase  --users users.csv --identities identities.csv [--firebase-signer-key k --firebase-salt-separator s]
  clerk     --csv export.csv --users users.json [--organizations organizations.json]
  auth0     --users users.ndjson [--hashes hashes.ndjson] [--organizations organizations.json]
  firebase  --users users.json --firebase-rounds 8 --firebase-mem-cost 14
  authjs    --tables tables.json [--password-column name] [--same-passkey-rp-id]
  cognito   --users users.json

target:
  --postgres <url>        write into core's tables (adapter-postgres)
  --better-auth           with --postgres: write into the Better Auth 1.7 tables (plan 9 mapping)
  --d1-bundle <file>      write the input as JSON for the D1 Worker script (packages/import/worker), and stop

options:
  --dry-run               read only; print the report a real run would print
  --repair                write the rows a partial record lacks; check each such user in the app first
  --on-email-taken <m>    skip (default) or fail
  --formats <list>        required, except for cognito: the formats list of the app's
                          createLegacyPasswordHash, comma-separated, or none; no default
  --legacy-verify         the app sets password.legacyVerify (needed for cognito)
  --role-map <list>       source role to core role, for example billing=member,lead=admin
  --reserved-slugs <list> the app's organizations.reservedSlugs, comma-separated (core's defaults stay reserved)
  --platform-slug <slug>  the app's organizations.platformOrganization slug; no import takes it
  --report <file>         also write the report as JSON

exit status: 0 clean; 1 a hash was refused, a record was refused (invalid_ or reserved_),
a record needs a person (a conflict), or a record is partial; 2 a usage error, a malformed
input file, or a stop.

The D1 bundle and the report file are written with mode 0600. The bundle holds every
password hash and, for supabase, the Firebase signer key: delete it after the Worker run.`;

/** The deprecation lines of the alias's bin file (spec 19). */
export const ALIAS_LINES = {
  renamed:
    "authtempo-import is renamed authtempo import; this alias goes in the next release (https://authtempo.com/docs/reference/cli/import/)",
  postgres:
    "--postgres takes a connection string on the command line; use authtempo import --target postgres --url-env <NAME>",
} as const;

/** The flags of the import CLI before plan 11c, word for word. */
const OLD_OPTIONS = {
  users: { type: "string" },
  identities: { type: "string" },
  csv: { type: "string" },
  hashes: { type: "string" },
  organizations: { type: "string" },
  tables: { type: "string" },
  "firebase-signer-key": { type: "string" },
  "firebase-salt-separator": { type: "string" },
  "firebase-rounds": { type: "string" },
  "firebase-mem-cost": { type: "string" },
  "password-column": { type: "string" },
  "same-passkey-rp-id": { type: "boolean" },
  postgres: { type: "string" },
  "better-auth": { type: "boolean" },
  "d1-bundle": { type: "string" },
  "dry-run": { type: "boolean" },
  repair: { type: "boolean" },
  "on-email-taken": { type: "string" },
  formats: { type: "string" },
  "legacy-verify": { type: "boolean" },
  "role-map": { type: "string" },
  "reserved-slugs": { type: "string" },
  "platform-slug": { type: "string" },
  report: { type: "string" },
} as const;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: ParsedImport;
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: OLD_OPTIONS,
    });
    parsed = parseImportValues(positionals, values, io);
  } catch (e) {
    io.err((e as Error).message);
    io.err(USAGE);
    return 2;
  }
  return (await runParsed(parsed, io)).code;
}

/**
 * The io of the alias with the scrub of spec 19: the value of `--postgres`,
 * its password, and its user and password pair leave no line. The alias
 * takes the connection string on the command line, so a driver error can
 * echo it; the bin file wraps `nodeImportIo` with this.
 */
export function scrubbedIo(argv: readonly string[], io: CliIo): CliIo {
  const secrets = new Set<string>();
  argv.forEach((a, i) => {
    const url = a.startsWith("--postgres=")
      ? a.slice("--postgres=".length)
      : a === "--postgres"
        ? argv[i + 1]
        : undefined;
    if (url) for (const p of secretParts(url)) secrets.add(p);
  });
  return { ...io, out: (l) => io.out(scrub(l, secrets)), err: (l) => io.err(scrub(l, secrets)) };
}

/** The real io of the alias: files on disk, and Postgres through the seam. */
export const nodeImportIo: CliIo = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: writePrivate,
  async openStorage(url, betterAuth) {
    const pg = openPostgres(url, 2);
    // A failed connection or sign-in stops here, as `storage: <code> at <host>`
    // (storageFailure in import-core), and not inside the import with the driver's text.
    try {
      await pg.ping();
    } catch (e) {
      await pg.close();
      throw e;
    }
    return { storage: betterAuth ? pg.compatStorage() : pg.coreStorage(), close: () => pg.close() };
  },
  // The alias parses no memory flag, so no run of the alias reaches this member (plan 11e).
  openMemory: async () => {
    throw new Error("the alias has no memory target");
  },
};
