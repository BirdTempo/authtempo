import { firescryptParamsValid, SCRYPT_MAX_N_TIMES_R } from "@authtempo/legacy-hashes";
import type { ImportUser, Source } from "../types.js";
import { asArray, asRecord, noSourceIdUser, parseJson, parseMillis, str } from "./common.js";

/**
 * Firebase Auth: `firebase auth:export users.json --format=json`, and the
 * project's hash parameters from the console (Authentication, Users, the
 * three-dot menu, "Password hash parameters"). Fields: firebase-tools
 * src/accountExporter.ts, read 2026-10-11. The export writes the hash and
 * the salt in standard base64. `rounds` is scrypt's r and `mem_cost` is
 * log2 N (plan 9b research, item 4).
 * Unverified, checked by owner runbook item 5: the JSON type of `createdAt`
 * (this reader takes a number or a digit string) and the `{ "users": [...] }`
 * wrapper (this reader also takes a bare array).
 * This reader cannot detect a hash made with another project's parameters:
 * the export carries no project parameters to compare, and the signer key
 * and the salt separator live only in the app's seam. A wrong value makes
 * every first sign-in refuse the password (it fails closed) with no report
 * line, so the owner runbook signs in once with a known user before the
 * cut-over (Task 20).
 */
export interface FirebaseExport {
  users: string;
  hashConfig: { rounds: number; memCost: number };
}

// `github.com` becomes `github` by the `.com` rule below (plan 9b2). Firebase
// has no built-in LinkedIn provider; a custom OIDC provider has the id
// `oidc.<name>`, which the importer drops and lists.
const PROVIDERS: Record<string, string> = { "google.com": "google", "apple.com": "apple" };

function provider(id: string): string {
  return Object.hasOwn(PROVIDERS, id) ? (PROVIDERS[id] as string) : id.replace(/\.com$/, "");
}

export function firebaseSource(input: FirebaseExport): Source {
  const { rounds, memCost } = input.hashConfig;
  // The grammar's own bound (legacy-hashes), checked once before any read:
  // out of it, every hash would be refused one by one. memCost is the
  // grammar's n (log2 N) and rounds its r, so one function holds both bounds.
  if (!firescryptParamsValid(memCost, rounds))
    throw new Error(
      `authtempo import: firebase hashConfig rounds and memCost must be integers of 1 to 99 with 2^memCost * rounds at most ${SCRYPT_MAX_N_TIMES_R}`,
    );
  return {
    name: "firebase",
    roles: {},
    async *records() {
      const parsed = parseJson(input.users, "firebase users");
      // The export is `{ "users": [...] }`; a bare array is accepted too.
      const wrapped = asRecord(parsed).users;
      if (!Array.isArray(parsed) && !Array.isArray(wrapped))
        throw new Error("authtempo import: the firebase export has no users array");
      const list = Array.isArray(parsed) ? parsed : asArray(wrapped);
      for (const [n, raw] of list.entries()) {
        const u = asRecord(raw);
        const id = str(u.localId);
        // No localId: no import key. Listed, never imported (plan 9b2).
        if (id === null) {
          yield noSourceIdUser(`users item ${n + 1}`);
          continue;
        }
        const hash = str(u.passwordHash);
        const salt = str(u.salt);
        const dropped: string[] = [];
        const identities: ImportUser["identities"] = [];
        for (const p of asArray(u.providerUserInfo).map(asRecord)) {
          const name = provider(str(p.providerId) ?? "unknown");
          const subject = str(p.rawId);
          if (subject === null) dropped.push(`identity:${name}:no_subject`);
          else identities.push({ provider: name, subject });
        }
        let password: ImportUser["password"] = null;
        if (hash && salt)
          password = { hash: `$firescrypt$n=${memCost},r=${rounds},p=1$${salt}$${hash}` };
        // One of the two alone is a cut or edited file, never "no password".
        else if (hash) password = { refused: "firescrypt (no salt)" };
        else if (salt) password = { refused: "firescrypt (no hash)" };
        const record: ImportUser = {
          kind: "user",
          sourceId: id,
          email: str(u.email),
          emailVerified: u.emailVerified === true,
          name: str(u.displayName),
          image: str(u.photoUrl),
          createdAt: parseMillis(u.createdAt),
          identities,
          // Both empty: the user has no password, or one in another algorithm that Firebase does not export.
          password,
          passkeys: [],
          dropped,
        };
        // Fail closed: any value but `false` or absent skips the user.
        if (u.disabled !== undefined && u.disabled !== false) record.skip = "disabled";
        yield record;
      }
    },
  };
}
