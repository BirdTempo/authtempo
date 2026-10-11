#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createPostgresAdapter } from "@tempo-auth/adapter-postgres";
import { betterAuthSchemaStorage } from "@tempo-auth/compat-better-auth";
import { normalizeSlug, type StorageAdapter } from "@tempo-auth/core";
import { LEGACY_FORMATS, type LegacyFormat } from "@tempo-auth/legacy-hashes";
import postgres from "postgres";
import { importUsers } from "./import.js";
import { type ImportBundle, PROVIDER_FILES, sourceOf } from "./sources.js";
import {
  CONFLICT_REASONS,
  ImportConflictError,
  type ImportOptions,
  type ImportRecord,
  type ImportReport,
  type ImportRole,
  type Source,
  type SourceName,
} from "./types.js";

export const USAGE = `tempo-auth-import <provider> [files] (--postgres <url> | --d1-bundle <file>) [options]

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
  --on-email-taken <m>    skip (default) or fail
  --formats <list>        the hash formats the app verifies, comma-separated (default: all five)
  --legacy-verify         the app sets password.legacyVerify (needed for cognito)
  --role-map <list>       source role to core role, for example billing=member,lead=admin
  --reserved-slugs <list> the app's organizations.reservedSlugs, comma-separated (core's defaults stay reserved)
  --platform-slug <slug>  the app's organizations.platformOrganization slug; no import takes it
  --report <file>         also write the report as JSON

exit status: 0 clean; 1 a hash was refused, a record was refused (invalid_ or reserved_),
a record needs a person (a conflict), or a record is partial; 2 a usage error, a malformed
input file, or a stop.`;

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

/**
 * The CLI's exit status for a finished report: 1 when a person must look.
 * That is a refused hash, a refusal (`report.refusals`, the skips that
 * `isRefusal` names), a conflict (`CONFLICT_REASONS`), or a partial record.
 * A policy skip that the export states (deleted, banned) does not count.
 */
export function exitCode(report: ImportReport): 0 | 1 {
  return report.refusedHashes.length > 0 ||
    report.refusals > 0 ||
    report.partial.length > 0 ||
    report.skipped.some((s) => CONFLICT_REASONS.has(s.reason))
    ? 1
    : 0;
}

export function summary(r: ImportReport): string[] {
  const lines = [
    `${r.source}${r.dryRun ? " (dry run, nothing written)" : ""}`,
    `created: ${Object.entries(r.created)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
    `exists: user ${r.exists.user}, organization ${r.exists.organization}`,
    `refusals: ${r.refusals}`,
  ];
  for (const s of r.skipped) lines.push(`skipped ${s.kind} ${s.sourceId}: ${s.reason}`);
  for (const h of r.refusedHashes) lines.push(`refused hash ${h.sourceId}: ${h.format}`);
  for (const p of r.partial)
    lines.push(`partial ${p.kind} ${p.sourceId}: missing ${p.missing.join(", ")}`);
  for (const d of r.dropped) lines.push(`dropped ${d.sourceId}: ${d.item}`);
  return lines;
}

/**
 * Reads every record before the run opens storage or writes a bundle. A
 * reader can throw on a malformed file after it yields some records (the
 * Clerk reader reads organizations after users), so without this pass the
 * importer would write those users first. The input files are in memory
 * already, so the list costs no more than the text.
 */
async function readFirst(bundle: ImportBundle): Promise<Source> {
  const source = sourceOf(bundle);
  const list: ImportRecord[] = [];
  for await (const r of source.records()) list.push(r);
  return {
    name: source.name,
    roles: source.roles,
    async *records() {
      yield* list;
    },
  };
}

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
  let source: Source;
  try {
    source = await readFirst(bundle);
  } catch (e) {
    io.err((e as Error).message);
    io.err("the run stopped before any write");
    return 2;
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
  const target = await io.openStorage(values.postgres as string, values["better-auth"] === true);
  try {
    const report = await importUsers(target.storage, source, parsed.options);
    for (const l of summary(report)) io.out(l);
    if (values.report) io.writeFile(values.report, JSON.stringify(report, null, 2));
    return exitCode(report);
  } catch (e) {
    if (e instanceof ImportConflictError) {
      for (const l of summary(e.report)) io.out(l);
      io.err(e.message);
      return 2;
    }
    throw e;
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
  const spec = PROVIDER_FILES[provider];
  const files: ImportBundle["files"] = {};
  for (const name of ["users", "identities", "csv", "hashes", "organizations", "tables"] as const) {
    const path = values[name];
    if (path === undefined) continue;
    if (!spec.needs.includes(name) && !spec.may.includes(name))
      throw new Error(`${provider} takes no --${name}`);
    files[name] = io.readFile(path);
  }
  for (const name of spec.needs)
    if (files[name as keyof typeof files] === undefined)
      throw new Error(`${provider} needs --${name}`);
  const onEmailTaken = values["on-email-taken"] ?? "skip";
  if (onEmailTaken !== "skip" && onEmailTaken !== "fail")
    throw new Error("--on-email-taken is skip or fail");
  const formats = list(values.formats, "--formats") as LegacyFormat[] | undefined;
  for (const f of formats ?? [])
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
    legacyVerify: values["legacy-verify"] === true,
    roleMap,
    ...(formats !== undefined ? { formats } : {}),
    ...(reservedSlugs !== undefined ? { reservedSlugs } : {}),
    ...(platformSlug !== undefined ? { platformSlug } : {}),
  };
  return { bundle, options, values };
}

/** The real io: files on disk, and Postgres through postgres.js. */
const nodeIo: CliIo = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, t) => writeFileSync(p, t),
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
