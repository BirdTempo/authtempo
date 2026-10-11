import { auth0Source } from "./readers/auth0.js";
import { authjsSource } from "./readers/authjs.js";
import { clerkSource } from "./readers/clerk.js";
import { cognitoSource } from "./readers/cognito.js";
import { firebaseSource } from "./readers/firebase.js";
import { supabaseSource } from "./readers/supabase.js";
import type { Source, SourceName } from "./types.js";

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
  }
}
