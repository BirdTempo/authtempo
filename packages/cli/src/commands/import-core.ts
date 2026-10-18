import { normalizeSlug, type StorageAdapter, StorageError } from "@authtempo/core";
import {
  exitCode,
  type ImportBundle,
  ImportConflictError,
  type ImportOptions,
  type ImportReport,
  type ImportRole,
  importUsers,
  PROVIDER_FILES,
  readSource,
  type Source,
  type SourceName,
  summary,
} from "@authtempo/import";
import { LEGACY_FORMATS, type LegacyFormat } from "@authtempo/legacy-hashes";
import { storageFailure } from "../seams/postgres.js";

// The parse checks and the run of the import CLI, moved from
// packages/import/src/cli.ts by plan 11c with no change of behavior. The
// alias (import-alias.ts) and `authtempo import` (import.ts) both call them.

/** The io of the import. Tests pass a memory adapter through openStorage. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  openStorage(
    url: string,
    betterAuth: boolean,
  ): Promise<{ storage: StorageAdapter; close(): Promise<void> }>;
  /** An empty store for `--target memory`: a plan with no database (plan 11e). */
  openMemory(): Promise<{ storage: StorageAdapter; close(): Promise<void> }>;
}

export const PROVIDERS = Object.keys(PROVIDER_FILES) as SourceName[];
const ROLES: readonly ImportRole[] = ["owner", "admin", "member"];

/** Neither exports a hash (spec 17.3 and 23 item 3), so --formats may be left out. */
export const NO_HASH_PROVIDERS: ReadonlySet<SourceName> = new Set<SourceName>([
  "cognito",
  "workos",
]);

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

/** The values of the import flags by their old names: the alias's parser writes them as they are. */
export interface ImportValues {
  users?: string | undefined;
  identities?: string | undefined;
  csv?: string | undefined;
  hashes?: string | undefined;
  organizations?: string | undefined;
  /** `authtempo import workos` only: the organization memberships file (plan 11f). */
  memberships?: string | undefined;
  tables?: string | undefined;
  "firebase-signer-key"?: string | undefined;
  "firebase-salt-separator"?: string | undefined;
  "firebase-rounds"?: string | undefined;
  "firebase-mem-cost"?: string | undefined;
  "password-column"?: string | undefined;
  "same-passkey-rp-id"?: boolean | undefined;
  postgres?: string | undefined;
  "better-auth"?: boolean | undefined;
  "d1-bundle"?: string | undefined;
  /** `authtempo import --target memory` only: the alias has no such flag. */
  memory?: boolean | undefined;
  "dry-run"?: boolean | undefined;
  repair?: boolean | undefined;
  "on-email-taken"?: string | undefined;
  formats?: string | undefined;
  "legacy-verify"?: boolean | undefined;
  "role-map"?: string | undefined;
  "reserved-slugs"?: string | undefined;
  "platform-slug"?: string | undefined;
  report?: string | undefined;
}

export interface ParsedImport {
  bundle: ImportBundle;
  options: ImportOptions;
  values: ImportValues;
}

function list(v: string | undefined, flag: string): string[] | undefined {
  if (v === undefined) return undefined;
  const items = v.split(",");
  if (items.some((i) => i.length === 0)) throw new Error(`${flag}: an empty entry`);
  return items;
}

/**
 * Every check of the import flags, then the read of the input files. A
 * message names a flag through `display`, so `authtempo import` names its
 * own flags (`--authjs-tables` for `tables`); the alias passes none.
 */
export function parseImportValues(
  positionals: readonly string[],
  values: ImportValues,
  io: Pick<CliIo, "readFile">,
  display: (flag: string) => string = (flag) => flag,
): ParsedImport {
  const provider = positionals[0] as SourceName | undefined;
  if (!provider || positionals.length !== 1 || !PROVIDERS.includes(provider))
    throw new Error(`name one provider: ${PROVIDERS.join(", ")}`);
  const targets = [values.postgres, values["d1-bundle"], values.memory].filter(Boolean).length;
  if (targets !== 1)
    // The alias has no memory target, so its message stays as it was.
    throw new Error(
      values.memory
        ? "name exactly one target: postgres, d1-bundle, or memory"
        : "name exactly one target: --postgres or --d1-bundle",
    );
  // A memory store is empty, so a real run there writes rows that nobody reads.
  if (values.memory && values["dry-run"] !== true)
    throw new Error("--target memory needs --dry-run");
  if (values.memory && values["better-auth"])
    throw new Error("--tables compat needs --target postgres");
  if (values["better-auth"] && !values.postgres) throw new Error("--better-auth needs --postgres");
  for (const [flag, owner] of Object.entries(FLAG_PROVIDER))
    if (values[flag as keyof typeof FLAG_PROVIDER] !== undefined && owner !== provider)
      throw new Error(`${provider} takes no --${display(flag)}`);
  // No hash moves from WorkOS (owner decision 1 of 2026-10-14), so the marker
  // of --legacy-verify would mark no user. Before the file read, as each flag check.
  if (provider === "workos" && values["legacy-verify"])
    throw new Error("workos takes no --legacy-verify: WorkOS exports no password hash");
  // Every flag check runs before the first file read: an export can be gigabytes,
  // and a typo in a later flag must not cost that read (review M-1).
  const spec = PROVIDER_FILES[provider];
  const paths: [keyof ImportBundle["files"], string][] = [];
  for (const name of [
    "users",
    "identities",
    "csv",
    "hashes",
    "organizations",
    "memberships",
    "tables",
  ] as const) {
    const path = values[name];
    if (path === undefined) continue;
    if (!spec.needs.includes(name) && !spec.may.includes(name))
      throw new Error(`${provider} takes no --${display(name)}`);
    paths.push([name, path]);
  }
  for (const name of spec.needs)
    if (values[name as keyof ImportValues] === undefined)
      throw new Error(`${provider} needs --${display(name)}`);
  const onEmailTaken = values["on-email-taken"] ?? "skip";
  if (onEmailTaken !== "skip" && onEmailTaken !== "fail")
    throw new Error("--on-email-taken is skip or fail");
  // Spec 17.1: a hash imports only in a format the app's seam verifies. Only
  // the operator knows the seam's list, so the flag has no default: a default
  // of all five imports a format the seam refuses, and those users cannot
  // sign in, with exit 0. A provider that exports no hash may leave it out.
  if (values.formats === undefined && !NO_HASH_PROVIDERS.has(provider))
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
    throw new Error(
      `give both --${display("firebase-signer-key")} and --firebase-salt-separator, or neither`,
    );
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

/** How a run ended: the exit code, the report, the reason of a stop, and the bundle path. */
export interface ImportOutcome {
  code: number;
  report: ImportReport | null;
  stopped: string | null;
  bundle: string | null;
}

/** The run of a parsed import, as the import CLI ran it (exit codes 0, 1, 2; one `stopped:` line). */
export async function runParsed(parsed: ParsedImport, io: CliIo): Promise<ImportOutcome> {
  const { bundle, values } = parsed;
  /**
   * One "stopped:" line, and the report file when --report is given. Without
   * the file, an older report from a previous run stays on disk, and a script
   * that reads it takes the old run for this one.
   */
  const stop = (reason: string, report: ImportReport | null): ImportOutcome => {
    io.err(`stopped: ${reason}`);
    if (values.report)
      io.writeFile(values.report, JSON.stringify({ stopped: reason, report }, null, 2));
    return { code: 2, report, stopped: reason, bundle: null };
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
  // Warnings go to stderr (spec 19), so a script that reads stdout reads the report only.
  if (bundle.provider === "workos") {
    io.err(
      "workos: WorkOS exports no password hash; each user signs in by a magic link or sets a new password",
    );
    if (bundle.files.identities === undefined)
      io.err("workos: no --identities file; no social identity is imported");
    if (bundle.files.organizations === undefined)
      io.err("workos: no --organizations file; no organization is imported");
  }
  const d1 = values["d1-bundle"];
  if (d1) {
    io.writeFile(d1, JSON.stringify({ bundle, options: parsed.options }));
    io.out(`wrote ${d1}; run the D1 Worker script (packages/import/worker/README.md)`);
    return { code: 0, report: null, stopped: null, bundle: d1 };
  }
  let target: Awaited<ReturnType<CliIo["openStorage"]>>;
  try {
    target = values.memory
      ? await io.openMemory()
      : await io.openStorage(values.postgres as string, values["better-auth"] === true);
  } catch (e) {
    return stop(`${storageFailure(e, values.postgres as string)}; nothing was written`, null);
  }
  try {
    const report = await importUsers(target.storage, source, parsed.options);
    for (const l of summary(report)) io.out(l);
    if (values.report) io.writeFile(values.report, JSON.stringify(report, null, 2));
    return { code: exitCode(report), report, stopped: null, bundle: null };
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
