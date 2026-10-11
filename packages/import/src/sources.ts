import { auth0Source } from "./readers/auth0.js";
import { authjsSource } from "./readers/authjs.js";
import { clerkSource } from "./readers/clerk.js";
import { cognitoSource } from "./readers/cognito.js";
import { firebaseSource } from "./readers/firebase.js";
import { supabaseSource } from "./readers/supabase.js";
import type { ImportRecord, Source, SourceName } from "./types.js";

/**
 * The input files of one run, by the CLI's flag name, as text. The CLI
 * and the D1 Worker script build the source from it, so both read the same
 * flags. One source for one fact.
 */
export interface ImportBundle {
  provider: SourceName;
  files: Partial<
    Record<"users" | "identities" | "csv" | "hashes" | "organizations" | "tables", string>
  >;
  firebase?: { signerKey: string; saltSeparator: string; rounds?: number; memCost?: number };
  passwordColumn?: string;
  samePasskeyRpId?: boolean;
}

/** The files each provider needs, and the ones it may take. */
export const PROVIDER_FILES: Record<SourceName, { needs: string[]; may: string[] }> = {
  supabase: { needs: ["users", "identities"], may: [] },
  clerk: { needs: ["csv", "users"], may: ["organizations"] },
  // A tenant with social sign-in only has no hash file, so it is optional. The CLI prints a line when it is absent.
  auth0: { needs: ["users"], may: ["hashes", "organizations"] },
  firebase: { needs: ["users"], may: [] },
  authjs: { needs: ["tables"], may: [] },
  cognito: { needs: ["users"], may: [] },
};

const FILE_NAMES = ["users", "identities", "csv", "hashes", "organizations", "tables"] as const;
type FileName = (typeof FILE_NAMES)[number];

function invalid(field: string, problem: string): never {
  throw new Error(`tempo-auth import: the bundle field ${field} ${problem}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Checks a bundle read from a file (the D1 Worker's input) field by field,
 * and returns it as an `ImportBundle`. The error names the field. A file
 * that the provider does not read is refused, as the CLI refuses its flag.
 */
export function bundleOf(value: unknown): ImportBundle {
  if (!isObject(value)) invalid("bundle", "is not an object");
  const { provider, files, firebase, passwordColumn, samePasskeyRpId } = value;
  if (typeof provider !== "string" || !Object.hasOwn(PROVIDER_FILES, provider))
    invalid("provider", `is not one of ${Object.keys(PROVIDER_FILES).join(", ")}`);
  const name = provider as SourceName;
  const allowed = [...PROVIDER_FILES[name].needs, ...PROVIDER_FILES[name].may];
  if (!isObject(files)) invalid("files", "is not an object");
  const out: ImportBundle["files"] = {};
  for (const [key, text] of Object.entries(files)) {
    if (!(FILE_NAMES as readonly string[]).includes(key) || !allowed.includes(key))
      invalid(`files.${key}`, `is not a ${name} file`);
    if (typeof text !== "string") invalid(`files.${key}`, "is not text");
    out[key as FileName] = text;
  }
  for (const key of PROVIDER_FILES[name].needs)
    if (out[key as FileName] === undefined) invalid(`files.${key}`, `is missing; ${name} needs it`);
  const bundle: ImportBundle = { provider: name, files: out };
  if (firebase !== undefined) {
    if (!isObject(firebase)) invalid("firebase", "is not an object");
    const { signerKey, saltSeparator, rounds, memCost } = firebase;
    if (typeof signerKey !== "string") invalid("firebase.signerKey", "is not text");
    if (typeof saltSeparator !== "string") invalid("firebase.saltSeparator", "is not text");
    if (rounds !== undefined && !Number.isInteger(rounds))
      invalid("firebase.rounds", "is not an integer");
    if (memCost !== undefined && !Number.isInteger(memCost))
      invalid("firebase.memCost", "is not an integer");
    bundle.firebase = {
      signerKey,
      saltSeparator,
      ...(rounds !== undefined ? { rounds: rounds as number } : {}),
      ...(memCost !== undefined ? { memCost: memCost as number } : {}),
    };
  }
  if (passwordColumn !== undefined) {
    if (typeof passwordColumn !== "string") invalid("passwordColumn", "is not text");
    bundle.passwordColumn = passwordColumn;
  }
  if (samePasskeyRpId !== undefined) {
    if (typeof samePasskeyRpId !== "boolean") invalid("samePasskeyRpId", "is not true or false");
    bundle.samePasskeyRpId = samePasskeyRpId;
  }
  return bundle;
}

/**
 * Reads every record before the run opens storage or writes a bundle. A
 * reader can throw on a malformed file after it yields some records (the
 * Clerk reader reads organizations after users), so without this pass the
 * importer would write those users first. The CLI and the D1 Worker script
 * both call it. The input files are in memory already, so the list costs no
 * more than the text.
 */
export async function readSource(bundle: ImportBundle): Promise<Source> {
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

function need(b: ImportBundle, name: keyof ImportBundle["files"]): string {
  const text = b.files[name];
  if (text === undefined) throw new Error(`tempo-auth import: ${b.provider} needs --${name}`);
  return text;
}

export function sourceOf(b: ImportBundle): Source {
  switch (b.provider) {
    case "supabase":
      return supabaseSource({
        users: need(b, "users"),
        identities: need(b, "identities"),
        ...(b.firebase
          ? {
              firebase: {
                signerKey: b.firebase.signerKey,
                saltSeparator: b.firebase.saltSeparator,
              },
            }
          : {}),
      });
    case "clerk":
      return clerkSource({
        csv: need(b, "csv"),
        users: need(b, "users"),
        ...(b.files.organizations !== undefined ? { organizations: b.files.organizations } : {}),
      });
    case "auth0":
      return auth0Source({
        users: need(b, "users"),
        ...(b.files.hashes !== undefined ? { hashes: b.files.hashes } : {}),
        ...(b.files.organizations !== undefined ? { organizations: b.files.organizations } : {}),
      });
    case "firebase": {
      const f = b.firebase;
      if (f?.rounds === undefined || f.memCost === undefined)
        throw new Error(
          "tempo-auth import: firebase needs --firebase-rounds and --firebase-mem-cost",
        );
      return firebaseSource({
        users: need(b, "users"),
        hashConfig: { rounds: f.rounds, memCost: f.memCost },
      });
    }
    case "authjs":
      return authjsSource({
        tables: need(b, "tables"),
        ...(b.passwordColumn !== undefined ? { passwordColumn: b.passwordColumn } : {}),
        ...(b.samePasskeyRpId ? { samePasskeyRpId: true } : {}),
      });
    case "cognito":
      return cognitoSource({ users: need(b, "users") });
    default:
      // A bundle from a file can name any text; bundleOf refuses it first.
      throw new Error(
        `tempo-auth import: unknown provider ${String((b as { provider: unknown }).provider)}`,
      );
  }
}
