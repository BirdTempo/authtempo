import type { ImportUser, Source } from "../types.js";
import { asArray, asRecord, parseMillis, str } from "./common.js";

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
 */
export interface FirebaseExport {
  users: string;
  hashConfig: { rounds: number; memCost: number };
}

const PROVIDERS: Record<string, string> = { "google.com": "google", "apple.com": "apple" };

export function firebaseSource(input: FirebaseExport): Source {
  const { rounds, memCost } = input.hashConfig;
  if (!Number.isInteger(rounds) || !Number.isInteger(memCost))
    throw new Error("tempo-auth import: firebase hashConfig rounds and memCost must be integers");
  return {
    name: "firebase",
    roles: {},
    async *records() {
      const parsed = JSON.parse(input.users) as unknown;
      // The export is `{ "users": [...] }`; a bare array is accepted too.
      const list = Array.isArray(parsed) ? parsed : asArray(asRecord(parsed).users);
      for (const raw of list) {
        const u = asRecord(raw);
        const hash = str(u.passwordHash);
        const salt = str(u.salt);
        const record: ImportUser = {
          kind: "user",
          sourceId: str(u.localId) ?? "",
          email: str(u.email),
          emailVerified: u.emailVerified === true,
          name: str(u.displayName),
          image: str(u.photoUrl),
          createdAt: parseMillis(u.createdAt),
          identities: asArray(u.providerUserInfo)
            .map(asRecord)
            .map((p) => {
              const id = str(p.providerId) ?? "unknown";
              return {
                provider: PROVIDERS[id] ?? id.replace(/\.com$/, ""),
                subject: str(p.rawId) ?? "",
              };
            })
            .filter((i) => i.subject.length > 0),
          // An empty hash: the user has no password, or one in another algorithm that Firebase does not export.
          password:
            hash && salt
              ? { hash: `$firescrypt$n=${memCost},r=${rounds},p=1$${salt}$${hash}` }
              : null,
          passkeys: [],
        };
        if (u.disabled === true) record.skip = "disabled";
        yield record;
      }
    },
  };
}
