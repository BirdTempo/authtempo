import { LEGACY_VERIFY_HASH } from "@tempo-auth/core";
import type { ImportUser, Source } from "../types.js";
import { asArray, asRecord, str } from "./common.js";

/**
 * Amazon Cognito: `aws cognito-idp list-users --user-pool-id <id> --output
 * json` (the AWS CLI follows the pagination token and prints one
 * `{ "Users": [...] }`). Fields: ListUsers API reference, read 2026-10-11.
 * Cognito exports no password hash, so a user with a password gets
 * `LEGACY_VERIFY_HASH`, and core asks Cognito at the first sign-in through
 * `password.legacyVerify` (spec 17.4).
 * Unverified, checked by owner runbook item 6: that no export gives the
 * hash (the reference shows none), and the shape of the `identities`
 * attribute (an unreadable one is dropped and listed).
 */
export interface CognitoExport {
  users: string;
}

const PROVIDERS: Record<string, string> = { google: "google", signinwithapple: "apple" };

export function cognitoSource(input: CognitoExport): Source {
  return {
    name: "cognito",
    roles: {},
    async *records() {
      for (const raw of asArray(asRecord(JSON.parse(input.users)).Users)) {
        const u = asRecord(raw);
        const attr = new Map(
          asArray(u.Attributes)
            .map(asRecord)
            .map((a) => [str(a.Name) ?? "", str(a.Value) ?? ""] as const),
        );
        const created = u.UserCreateDate;
        // The API sends epoch seconds; the AWS CLI prints ISO 8601 by default.
        const createdAt =
          typeof created === "number"
            ? new Date(created * 1000)
            : typeof created === "string"
              ? new Date(created)
              : null;
        const federated = str(u.UserStatus) === "EXTERNAL_PROVIDER";
        const dropped: string[] = [];
        let identities: ImportUser["identities"] = [];
        if (federated) {
          // The `identities` attribute is JSON text; its shape is not in the API reference (README step).
          try {
            identities = asArray(JSON.parse(attr.get("identities") ?? "[]"))
              .map(asRecord)
              .map((i) => {
                const p = (str(i.providerName) ?? "unknown").toLowerCase();
                return { provider: PROVIDERS[p] ?? p, subject: str(i.userId) ?? "" };
              })
              .filter((i) => i.subject.length > 0);
          } catch {
            dropped.push("identity:unreadable");
          }
        }
        const record: ImportUser = {
          kind: "user",
          sourceId: attr.get("sub") || (str(u.Username) ?? ""),
          email: attr.get("email") || null,
          emailVerified: attr.get("email_verified") === "true",
          name: attr.get("name") || null,
          image: attr.get("picture") || null,
          createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
          identities,
          password: federated ? null : { hash: LEGACY_VERIFY_HASH },
          passkeys: [],
          dropped,
        };
        if (u.Enabled === false) record.skip = "disabled";
        yield record;
      }
    },
  };
}
