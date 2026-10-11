import { decodeBase64, encodeBase64 } from "@tempo-auth/legacy-hashes";
import type { ImportPasskey, ImportUser, Source } from "../types.js";
import { asArray, asRecord, parseTime, str, toBase64Url } from "./common.js";

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

/**
 * Standard base64 (Auth.js webauthn-utils.ts) to core's base64url, only when
 * the value is non-empty and canonical: it decodes strictly and encodes back
 * to the same text. A hex id, a stray space, or non-zero trailing bits give
 * null, because core looks a credential up by its exact base64url text.
 */
function canonicalBase64Url(v: unknown): string | null {
  const text = str(v);
  if (text === null) return null;
  const bytes = decodeBase64(text);
  if (bytes === null || bytes.length === 0) return null;
  if (encodeBase64(bytes).replace(/=+$/, "") !== text.replace(/=+$/, "")) return null;
  return toBase64Url(text);
}

const DEVICE_TYPES = new Set(["singleDevice", "multiDevice"]);
/** WebAuthn's signCount is an unsigned 32-bit integer (WebAuthn Level 3, authenticator data). */
const SIGN_COUNT_MAX = 4_294_967_295;

export function authjsSource(input: AuthjsExport): Source {
  return {
    name: "authjs",
    roles: {},
    async *records() {
      // A misshaped top level is an error, never an empty list: the run would
      // import nothing and exit 0.
      const top = JSON.parse(input.tables) as unknown;
      if (typeof top !== "object" || top === null || Array.isArray(top))
        throw new Error("tempo-auth import: the Auth.js tables input is not a JSON object");
      const t = top as Record<string, unknown>;
      if (!Array.isArray(t.users))
        throw new Error("tempo-auth import: the Auth.js tables input has no users array");
      for (const table of ["accounts", "authenticators"] as const)
        if (t[table] !== undefined && !Array.isArray(t[table]))
          throw new Error(
            `tempo-auth import: the Auth.js tables input field ${table} is not an array`,
          );
      const accounts = asArray(t.accounts).map(asRecord);
      const keys = asArray(t.authenticators).map(asRecord);
      const users = t.users.map(asRecord);
      const column = input.passwordColumn;
      // A column name that no row has is a typo, not "no passwords".
      if (column !== undefined && users.length > 0 && !users.some((u) => Object.hasOwn(u, column)))
        throw new Error(
          `tempo-auth import: no Auth.js user row has the password column "${column}"`,
        );
      // A credential id on two rows has no known owner: neither row imports.
      // The count is by the base64url form core stores, so `AQ==` and `AQ`
      // are one credential. A value that does not decode counts by its raw text.
      const idKey = (v: unknown): string | null => {
        const cid = str(v);
        if (cid === null) return null;
        return canonicalBase64Url(cid) ?? `raw:${cid}`;
      };
      const idCount = new Map<string, number>();
      for (const k of keys) {
        const cid = idKey(k.credentialID);
        if (cid !== null) idCount.set(cid, (idCount.get(cid) ?? 0) + 1);
      }
      for (const u of users) {
        const id = str(u.id) ?? "";
        const dropped: string[] = [];
        const passkeys: ImportPasskey[] = [];
        for (const k of keys.filter((k) => str(k.userId) === id)) {
          if (!input.samePasskeyRpId) {
            dropped.push("passkey:rp_id_not_confirmed");
            continue;
          }
          if ((idCount.get(idKey(k.credentialID) ?? "") ?? 0) > 1) {
            dropped.push("passkey:duplicate_credential_id");
            continue;
          }
          const credentialId = canonicalBase64Url(k.credentialID);
          const publicKey = canonicalBase64Url(k.credentialPublicKey);
          const counter = k.counter;
          const deviceType = str(k.credentialDeviceType);
          if (credentialId === null) dropped.push("passkey:invalid_credential_id");
          else if (publicKey === null) dropped.push("passkey:invalid_public_key");
          // The counter is the only clone signal: never a default. WebAuthn's
          // signCount is 32 bits, so a value above 2^32 - 1 is not one.
          else if (
            typeof counter !== "number" ||
            !Number.isSafeInteger(counter) ||
            counter < 0 ||
            counter > SIGN_COUNT_MAX
          )
            dropped.push("passkey:invalid_counter");
          else if (
            deviceType === null ||
            !DEVICE_TYPES.has(deviceType) ||
            typeof k.credentialBackedUp !== "boolean"
          )
            dropped.push("passkey:invalid_device");
          else
            passkeys.push({
              credentialId,
              publicKey,
              counter,
              transports: str(k.transports),
              deviceType,
              backedUp: k.credentialBackedUp,
              name: null,
            });
        }
        for (const a of accounts.filter((a) => str(a.userId) === id))
          if (a.type !== "oauth" && a.type !== "oidc")
            dropped.push(`account:${str(a.type) ?? "unknown"}`);
        // A date of the first email sign-in, or null (adapters.ts). Any other value is not a proof.
        const verifiedAt = u.emailVerified;
        const emailVerified = typeof verifiedAt === "string" && parseTime(verifiedAt) !== null;
        if (verifiedAt !== null && verifiedAt !== undefined && !emailVerified)
          dropped.push("email_verified:unreadable");
        const hash = column !== undefined ? str(u[column]) : null;
        yield {
          kind: "user",
          sourceId: id,
          email: str(u.email),
          emailVerified,
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
