#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createPostgresAdapter } from "@authtempo/adapter-postgres";
import { betterAuthSchemaStorage } from "@authtempo/compat-better-auth";
import { normalizeSlug, type StorageAdapter, StorageError } from "@authtempo/core";
import { LEGACY_FORMATS, type LegacyFormat } from "@authtempo/legacy-hashes";
import postgres from "postgres";
import { importUsers } from "./import.js";
import { type ImportBundle, PROVIDER_FILES, readSource } from "./sources.js";

// The Worker reads these from report.ts, which imports no Node.js module.
export { exitCode, summary };

import { exitCode, summary } from "./report.js";
import {
  ImportConflictError,
  type ImportOptions,
  type ImportReport,
  type ImportRole,
  type Source,
  type SourceName,
} from "./types.js";

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

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  /** Opens the target storage. Tests pass a memory adapter. */
  openStorage(
    url: string,
    betterAuth: boolean,
  ): Promise<{ storage: StorageAdapter; close(): Promise<void> }>;
}

const PROVIDERS = Object.keys(PROVIDER_FILES) as SourceName[];
const ROLES: readonly ImportRole[] = ["owner", "admin", "member"];

/**
 * The provider that each provider-specific flag belongs to. A flag given to
 * another provider is a usage error, because its reader would ignore it in
 * silence: for example a Supabase run with --firebase-rounds.
 */
const FLAG_PROVIDER = {
  "firebase-signer-key": "supabase",
  "firebase-salt-separator": "supabase",
  "firebase-rounds": "firebase",
  "firebase-mem-cost": "firebase",
  "password-column": "authjs",
  "same-passkey-rp-id": "authjs",
} as const satisfies Record<string, SourceName>;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv, io);
  } catch (e) {
    io.err((e as Error).message);
    io.err(USAGE);
    return 2;
  }
  const { bundle, values } = parsed;
  /**
   * One "stopped:" line, and the report file when --report is given. Without
   * the file, an older report from a previous run stays on disk, and a script
   * that reads it takes the old run for this one.
   */
  const stop = (reason: string, report: ImportReport | null): 2 => {
    io.err(`stopped: ${reason}`);
    if (values.report)
      io.writeFile(values.report, JSON.stringify({ stopped: reason, report }, null, 2));
    return 2;
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let source: Source;
  try {
    source = await readSource(bundle);
  } catch (e) {
    return stop(`${message(e)}; nothing was written`, null);
  }
  if (bundle.provider === "auth0" && bundle.files.hashes === undefined)
    io.out("auth0: no --hashes file; no password is imported");
  if (values["d1-bundle"]) {
    io.writeFile(values["d1-bundle"], JSON.stringify({ bundle, options: parsed.options }));
    io.out(
      `wrote ${values["d1-bundle"]}; run the D1 Worker script (packages/import/worker/README.md)`,
    );
    return 0;
  }
  let target: Awaited<ReturnType<CliIo["openStorage"]>>;
  try {
    target = await io.openStorage(values.postgres as string, values["better-auth"] === true);
  } catch (e) {
    return stop(`storage: ${message(e)}; nothing was written`, null);
  }
  try {
    const report = await importUsers(target.storage, source, parsed.options);
    for (const l of summary(report)) io.out(l);
    if (values.report) io.writeFile(values.report, JSON.stringify(report, null, 2));
    return exitCode(report);
  } catch (e) {
    if (e instanceof ImportConflictError) {
      for (const l of summary(e.report)) io.out(l);
      return stop(e.message, e.report);
    }
    // Each record commits alone, so the records before the failing one may be
    // written. A re-run finds them by import id and counts them as exists.
    // "storage:" only for a storage error; any other is the importer's own.
    const label = e instanceof StorageError ? "storage" : "import";
    return stop(`${label}: ${message(e)}; records before it may be written; run again`, null);
  } finally {
    await target.close();
  }
}

function list(v: string | undefined, flag: string): string[] | undefined {
  if (v === undefined) return undefined;
  const items = v.split(",");
  if (items.some((i) => i.length === 0)) throw new Error(`${flag}: an empty entry`);
  return items;
}

function parse(argv: string[], io: CliIo) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
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
    },
  });
  const provider = positionals[0] as SourceName | undefined;
  if (!provider || positionals.length !== 1 || !PROVIDERS.includes(provider))
    throw new Error(`name one provider: ${PROVIDERS.join(", ")}`);
  if (!values.postgres === !values["d1-bundle"])
    throw new Error("name exactly one target: --postgres or --d1-bundle");
  if (values["better-auth"] && !values.postgres) throw new Error("--better-auth needs --postgres");
  for (const [flag, owner] of Object.entries(FLAG_PROVIDER))
    if (values[flag as keyof typeof FLAG_PROVIDER] !== undefined && owner !== provider)
      throw new Error(`${provider} takes no --${flag}`);
  // Every flag check runs before the first file read: an export can be gigabytes,
  // and a typo in a later flag must not cost that read (review M-1).
  const spec = PROVIDER_FILES[provider];
  const paths: [keyof ImportBundle["files"], string][] = [];
  for (const name of ["users", "identities", "csv", "hashes", "organizations", "tables"] as const) {
    const path = values[name];
    if (path === undefined) continue;
    if (!spec.needs.includes(name) && !spec.may.includes(name))
      throw new Error(`${provider} takes no --${name}`);
    paths.push([name, path]);
  }
  for (const name of spec.needs)
    if (values[name as keyof typeof values] === undefined)
      throw new Error(`${provider} needs --${name}`);
  const onEmailTaken = values["on-email-taken"] ?? "skip";
  if (onEmailTaken !== "skip" && onEmailTaken !== "fail")
    throw new Error("--on-email-taken is skip or fail");
  // Spec 17.1: a hash imports only in a format the app's seam verifies. Only
  // the operator knows the seam's list, so the flag has no default: a default
  // of all five imports a format the seam refuses, and those users cannot
  // sign in, with exit 0. Cognito exports no hash, so it may leave it out.
  if (values.formats === undefined && provider !== "cognito")
    throw new Error(
      `${provider} needs --formats: the formats list of the app's createLegacyPasswordHash, or none`,
    );
  const formats =
    values.formats === undefined || values.formats === "none"
      ? []
      : (list(values.formats, "--formats") as LegacyFormat[]);
  for (const f of formats)
    if (!LEGACY_FORMATS.includes(f)) throw new Error(`--formats: unknown format ${f}`);
  // Built from entries, so a source role such as __proto__ is an own key, not the prototype.
  const pairs: [string, ImportRole][] = [];
  for (const pair of list(values["role-map"], "--role-map") ?? []) {
    const [from, to, extra] = pair.split("=");
    if (!from || !to || extra !== undefined || !ROLES.includes(to as ImportRole))
      throw new Error(`--role-map: ${pair} is not <source role>=owner|admin|member`);
    pairs.push([from, to as ImportRole]);
  }
  const roleMap: Record<string, ImportRole> = Object.fromEntries(pairs);
  // Checked here as the importer checks them, so a D1 bundle never carries a slug the Worker refuses.
  const reservedSlugs = list(values["reserved-slugs"], "--reserved-slugs");
  const platformSlug = values["platform-slug"];
  for (const s of [...(reservedSlugs ?? []), ...(platformSlug !== undefined ? [platformSlug] : [])])
    if (normalizeSlug(s) === null) throw new Error(`${s} is not a slug`);
  const int = (v: string | undefined, flag: string) => {
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) throw new Error(`${flag} must be an integer`);
    return Number(v);
  };
  const signerKey = values["firebase-signer-key"];
  const saltSeparator = values["firebase-salt-separator"];
  if ((signerKey === undefined) !== (saltSeparator === undefined))
    throw new Error("give both --firebase-signer-key and --firebase-salt-separator, or neither");
  const rounds = int(values["firebase-rounds"], "--firebase-rounds");
  const memCost = int(values["firebase-mem-cost"], "--firebase-mem-cost");
  // Before the file read, so a missing flag costs no read and prints the usage.
  if (provider === "firebase" && (rounds === undefined || memCost === undefined))
    throw new Error("firebase needs --firebase-rounds and --firebase-mem-cost");
  const files: ImportBundle["files"] = {};
  for (const [name, path] of paths) files[name] = io.readFile(path);
  const bundle: ImportBundle = {
    provider,
    files,
    ...(signerKey !== undefined ||
    saltSeparator !== undefined ||
    rounds !== undefined ||
    memCost !== undefined
      ? {
          firebase: {
            signerKey: signerKey ?? "",
            saltSeparator: saltSeparator ?? "",
            ...(rounds !== undefined ? { rounds } : {}),
            ...(memCost !== undefined ? { memCost } : {}),
          },
        }
      : {}),
    ...(values["password-column"] !== undefined
      ? { passwordColumn: values["password-column"] }
      : {}),
    ...(values["same-passkey-rp-id"] ? { samePasskeyRpId: true } : {}),
  };
  const options: ImportOptions = {
    onEmailTaken: onEmailTaken as "skip" | "fail",
    dryRun: values["dry-run"] === true,
    ...(values.repair === true ? { repair: true } : {}),
    legacyVerify: values["legacy-verify"] === true,
    roleMap,
    formats,
    ...(reservedSlugs !== undefined ? { reservedSlugs } : {}),
    ...(platformSlug !== undefined ? { platformSlug } : {}),
  };
  return { bundle, options, values };
}

/**
 * Writes a file that only its owner can read (mode 0600). The text goes to a
 * new file in the same directory and is renamed over the target, so a target
 * that exists with a wider mode never holds the new text: writeFileSync's mode
 * applies only to a file it creates (review M-2).
 */
export function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The real io: files on disk, and Postgres through postgres.js. */
const nodeIo: CliIo = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: writePrivate,
  async openStorage(url, betterAuth) {
    const sql = postgres(url, { max: 2, onnotice: () => {} });
    const storage = betterAuth
      ? betterAuthSchemaStorage({ dialect: "postgres", sql }).storage
      : createPostgresAdapter(sql);
    return { storage, close: () => sql.end({ timeout: 5 }) };
  },
};

// Run only as the program, not when a test imports this module. The bin is a symlink, so compare real paths.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  runCli(process.argv.slice(2), nodeIo).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    },
  );
}
