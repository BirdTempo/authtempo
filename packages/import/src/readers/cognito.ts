import { LEGACY_VERIFY_HASH } from "@authtempo/core";
import type { ImportUser, SkipReason, Source } from "../types.js";
import { asArray, asRecord, parseJson, parseTime, str } from "./common.js";

/**
 * Amazon Cognito: `aws cognito-idp list-users --user-pool-id <id> --output
 * json` (the AWS CLI follows the pagination token and prints one
 * `{ "Users": [...] }`). Fields: ListUsers API reference, read 2026-10-11.
 * Cognito exports no password hash, so a user with a password gets
 * `LEGACY_VERIFY_HASH`, and core asks Cognito at the first sign-in through
 * `password.legacyVerify` (spec 17.4).
 * Only a `CONFIRMED` user gets the marker; a federated user gets none, and
 * every other status skips the user. Unverified, checked by owner runbook
 * item 6: that no export gives the hash (the reference shows none), and the
 * shape of the `identities` attribute, also on a native user an admin
 * linked to a provider (every entry it cannot read is dropped and listed).
 */
export interface CognitoExport {
  users: string;
}

/** Cognito's built-in provider names, matched exactly. A custom provider never maps to google or apple. */
const PROVIDERS: Record<string, string> = { Google: "google", SignInWithApple: "apple" };

/**
 * The skip for a user whose `UserStatus` is not `CONFIRMED` or
 * `EXTERNAL_PROVIDER`: the marker would not sign in (UNCONFIRMED,
 * FORCE_CHANGE_PASSWORD, RESET_REQUIRED), or the export says not to trust
 * the password (COMPROMISED, ARCHIVED). Any other or missing value is
 * `status_unknown`.
 */
const STATUS_SKIP: Readonly<Record<string, SkipReason>> = {
  UNCONFIRMED: "status_unconfirmed",
  FORCE_CHANGE_PASSWORD: "status_force_change_password",
  RESET_REQUIRED: "status_reset_required",
  COMPROMISED: "status_compromised",
  ARCHIVED: "status_archived",
};

function statusSkip(status: string | null): SkipReason {
  return status !== null && Object.hasOwn(STATUS_SKIP, status)
    ? (STATUS_SKIP[status] as SkipReason)
    : "status_unknown";
}

/** The `identities` attribute: JSON text of `[{ providerName, userId }]`. Every entry it cannot read is listed. */
function readIdentities(text: string | undefined, dropped: string[]): ImportUser["identities"] {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    dropped.push("identity:unreadable");
    return [];
  }
  if (!Array.isArray(parsed)) {
    dropped.push("identity:unreadable");
    return [];
  }
  const out: ImportUser["identities"] = [];
  for (const i of parsed.map(asRecord)) {
    const name = str(i.providerName);
    const subject = str(i.userId);
    if (name === null || subject === null) {
      dropped.push("identity:unreadable");
      continue;
    }
    // Any other name goes to a provider the importer drops and lists.
    out.push({
      provider: Object.hasOwn(PROVIDERS, name) ? (PROVIDERS[name] as string) : `cognito:${name}`,
      subject,
    });
  }
  return out;
}

export function cognitoSource(input: CognitoExport): Source {
  return {
    name: "cognito",
    roles: {},
    async *records() {
      // A misshaped top level is an error, never an empty list. `aws
      // cognito-idp list-users --query Users` prints a bare array, and that
      // run would import nothing and exit 0.
      const top = parseJson(input.users, "Cognito users");
      const users = asRecord(top).Users;
      if (Array.isArray(top) || !Array.isArray(users))
        throw new Error(
          'authtempo import: the Cognito users input has no Users array (save the whole list-users output, as { "Users": [...] })',
        );
      const list = users.map(asRecord);
      const attrs = list.map(
        (u) =>
          new Map(
            asArray(u.Attributes)
              .map(asRecord)
              .map((a) => [str(a.Name) ?? "", str(a.Value) ?? ""] as const),
          ),
      );
      // A sub on two records has no known owner: neither imports.
      const subCount = new Map<string, number>();
      for (const a of attrs) {
        const sub = a.get("sub");
        if (sub) subCount.set(sub, (subCount.get(sub) ?? 0) + 1);
      }
      for (const [n, u] of list.entries()) {
        const attr = attrs[n] as Map<string, string>;
        const sub = attr.get("sub") || null;
        const created = u.UserCreateDate;
        // The API sends epoch seconds; the AWS CLI prints ISO 8601 by default.
        const createdAt =
          typeof created === "number" && Number.isFinite(created)
            ? new Date(created * 1000)
            : typeof created === "string"
              ? parseTime(created)
              : null;
        const status = str(u.UserStatus);
        const federated = status === "EXTERNAL_PROVIDER";
        const dropped: string[] = [];
        if (federated && !attr.has("identities")) dropped.push("identity:unreadable");
        // Parsed for every user: an admin can link a provider to a native user.
        const identities = readIdentities(attr.get("identities"), dropped);
        const record: ImportUser = {
          kind: "user",
          // Never the username: a record with no sub is skipped (below).
          sourceId: sub ?? `username:${str(u.Username) ?? "(none)"}`,
          email: attr.get("email") || null,
          emailVerified: attr.get("email_verified") === "true",
          name: attr.get("name") || null,
          image: attr.get("picture") || null,
          createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
          identities,
          // The marker only for a user Cognito would sign in with a password now.
          password: status === "CONFIRMED" ? { hash: LEGACY_VERIFY_HASH } : null,
          passkeys: [],
          dropped,
        };
        // The skips are set from the weakest to the strongest reason, and the last one
        // set is kept: a status reason (status_compromised is a conflict) wins over
        // disabled, and no_source_id or duplicate_row wins over both, so a disabled
        // compromised user still makes the CLI exit 1.
        // Fail closed: only the boolean true is an enabled user.
        if (u.Enabled !== true) record.skip = "disabled";
        if (!federated && status !== "CONFIRMED") {
          record.skip = statusSkip(status);
          // The reason alone does not say which value Cognito sent.
          if (record.skip === "status_unknown")
            dropped.push(
              `status:${typeof u.UserStatus === "string" ? u.UserStatus : (JSON.stringify(u.UserStatus) ?? "(none)")}`,
            );
        }
        // No sub: no import key.
        if (sub === null) record.skip = "no_source_id";
        else if ((subCount.get(sub) ?? 0) > 1) record.skip = "duplicate_row";
        yield record;
      }
    },
  };
}
