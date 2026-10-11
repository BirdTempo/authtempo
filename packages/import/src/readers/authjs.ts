import type { ImportPasskey, ImportUser, Source } from "../types.js";
import { asArray, asRecord, str, toBase64Url } from "./common.js";

/**
 * Auth.js (NextAuth): the adapter tables User, Account, and Authenticator,
 * as one JSON object made with the README's SQL. Column names: the Prisma
 * and Drizzle schemas of nextauthjs/next-auth main, read 2026-10-11. The
 * tables have no created date and no password column.
 */
export interface AuthjsExport {
  /** `{ "users": [...], "accounts": [...], "authenticators": [...] }`. */
  tables: string;
  /** The app's own column of User that holds a password hash, when the app added Credentials sign-in. */
  passwordColumn?: string;
  /**
   * True only when the new app keeps the old relying party id. A passkey binds
   * to it, so under another id it can never sign in. Default false: the
   * passkeys are dropped and listed.
   */
  samePasskeyRpId?: boolean;
}

export function authjsSource(input: AuthjsExport): Source {
  return {
    name: "authjs",
    roles: {},
    async *records() {
      const t = asRecord(JSON.parse(input.tables));
      const accounts = asArray(t.accounts).map(asRecord);
      const keys = asArray(t.authenticators).map(asRecord);
      for (const raw of asArray(t.users)) {
        const u = asRecord(raw);
        const id = str(u.id) ?? "";
        const dropped: string[] = [];
        const passkeys: ImportPasskey[] = [];
        for (const k of keys.filter((k) => str(k.userId) === id)) {
          if (!input.samePasskeyRpId) {
            dropped.push("passkey:rp_id_not_confirmed");
            continue;
          }
          passkeys.push({
            // Auth.js stores both in standard base64 (webauthn-utils.ts); core stores base64url.
            credentialId: toBase64Url(str(k.credentialID) ?? ""),
            publicKey: toBase64Url(str(k.credentialPublicKey) ?? ""),
            counter: typeof k.counter === "number" ? k.counter : 0,
            transports: str(k.transports),
            deviceType: str(k.credentialDeviceType) ?? "singleDevice",
            backedUp: k.credentialBackedUp === true,
            name: null,
          });
        }
        const hash = input.passwordColumn ? str(u[input.passwordColumn]) : null;
        yield {
          kind: "user",
          sourceId: id,
          email: str(u.email),
          // A date of the first email sign-in, or null (adapters.ts).
          emailVerified: str(u.emailVerified) !== null,
          name: str(u.name),
          image: str(u.image),
          createdAt: null,
          identities: accounts
            .filter((a) => str(a.userId) === id && (a.type === "oauth" || a.type === "oidc"))
            .map((a) => ({
              provider: str(a.provider) ?? "unknown",
              subject: str(a.providerAccountId) ?? "",
            }))
            .filter((i) => i.subject.length > 0),
          password: hash ? { hash } : null,
          passkeys,
          dropped,
        } satisfies ImportUser;
      }
    },
  };
}
