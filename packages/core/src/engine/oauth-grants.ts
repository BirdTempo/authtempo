import type { ResolvedConfig } from "../config.js";
import { ok, type Result } from "../result.js";
import { findManyIn } from "../storage/batch.js";
import type { StorageAdapter } from "../storage/port.js";
import { deleteFamilies, endFamilies, type FamilyEnds, familyEnds } from "./oauth-family.js";

/**
 * The grants of a user (plan 9g final fix wave, review I-1). A grant is
 * the consent of one user for one client, with the refresh tokens that the
 * client holds for that user. An app lists them on a "connected apps" page,
 * and a person ends one there. A reset or a change of the password deletes
 * the refresh tokens and the codes, and keeps the consents (`deleteOAuthTokens`).
 */

export interface OAuthGrantSummary {
  clientId: string;
  /** The client's own claimed name, or null when it gave none. */
  clientName: string | null;
  scopes: string[];
  /** When the person first allowed the client. */
  createdAt: Date;
  /** The refresh tokens of the grant that are not spent and not expired. */
  refreshTokens: number;
}

/** Every consent of the user, newest first, with the client name and the count of live refresh tokens. */
export async function listGrants(
  config: ResolvedConfig,
  input: { userId: string },
): Promise<Result<OAuthGrantSummary[]>> {
  const { storage } = config;
  const consents = await storage.findMany(
    "oauthConsent",
    [{ field: "userId", op: "eq", value: input.userId }],
    {
      sort: [
        { field: "createdAt", dir: "desc" },
        { field: "id", dir: "desc" },
      ],
    },
  );
  if (consents.length === 0) return ok([]);
  const live = await storage.findMany("oauthToken", [
    { field: "userId", op: "eq", value: input.userId },
    { field: "usedAt", op: "eq", value: null },
    { field: "expiresAt", op: "gt", value: config.clock.now() },
  ]);
  const counts = new Map<string, number>();
  for (const t of live) counts.set(t.clientId, (counts.get(t.clientId) ?? 0) + 1);
  // In chunks: D1 binds at most 100 parameters per statement.
  const clients = await findManyIn(
    storage,
    "oauthClient",
    "id",
    consents.map((c) => c.clientId),
  );
  const names = new Map(clients.map((c) => [c.id, c.name]));
  return ok(
    consents.map((c) => ({
      clientId: c.clientId,
      clientName: names.get(c.clientId) ?? null,
      scopes: [...c.scopes],
      createdAt: c.createdAt,
      refreshTokens: counts.get(c.clientId) ?? 0,
    })),
  );
}

/**
 * Ends the grant of one client: deletes the consent, every refresh token,
 * and every decided device row of the user and the client. `{ ok: true }` also when nothing existed, so
 * the answer tells no caller which clients a user has. A code exchange
 * re-checks the consent (`exchangeCode`). A refresh in flight can still
 * see its spent row until the commit on Postgres, and write a new row. So
 * after the commit, each family of the user and the client ends with its
 * mark (`endFamilies`, ruling 43 of plan 12e). Then no refresh token outlives the call.
 */
export async function revokeGrant(
  config: ResolvedConfig,
  input: { userId: string; clientId: string },
): Promise<Result<{ ok: true }>> {
  // One transaction: a failed token delete leaves the consent in place, so
  // the grants list still shows the grant and the person can try again
  // (round 2 re-review). The consent first: a code exchange that runs
  // between the two deletes finds no consent and writes no refresh token.
  const ends = familyEnds();
  await config.storage.transaction(async (tx) => {
    await tx.delete("oauthConsent", [
      { field: "clientId", op: "eq", value: input.clientId },
      { field: "userId", op: "eq", value: input.userId },
    ]);
    await deleteFamilies(
      tx,
      [
        { field: "userId", op: "eq", value: input.userId },
        { field: "clientId", op: "eq", value: input.clientId },
      ],
      ends,
    );
    // A device row that the user decided is a code in another table (plan 12e).
    await tx.delete("oauthDevice", [
      { field: "userId", op: "eq", value: input.userId },
      { field: "clientId", op: "eq", value: input.clientId },
    ]);
  });
  await endFamilies(config, ends);
  return ok({ ok: true });
}

/**
 * Deletes every refresh token, every `oauth-code` row, and every decided
 * device row of the user, in the caller's transaction: a reset of either
 * kind and a password change (spec 8.7, the plan 9g final fix wave). A code
 * from before the reset then gives nothing. A device code that the user
 * approved is such a code (plan 12e). The consents stay, so the next authorize asks for no
 * consent, but each client must send the person through the authorize step again.
 * The caller ends `ends` after its commit (`endFamilies`, ruling 43 of plan 12e).
 */
export async function deleteOAuthTokens(
  tx: StorageAdapter,
  userId: string,
  ends: FamilyEnds,
): Promise<void> {
  await deleteFamilies(tx, [{ field: "userId", op: "eq", value: userId }], ends);
  await tx.delete("verification", [
    { field: "purpose", op: "eq", value: "oauth-code" },
    { field: "identifier", op: "eq", value: userId },
  ]);
  // A pending device row names no user yet, so it stays for the person who types its code.
  await tx.delete("oauthDevice", [{ field: "userId", op: "eq", value: userId }]);
}
