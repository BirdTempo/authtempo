import type { ResolvedConfig } from "../config.js";
import { ok, type Result } from "../result.js";
import { findManyIn } from "../storage/batch.js";
import type { StorageAdapter } from "../storage/port.js";

/**
 * The grants of a user (plan 9g final fix wave, review I-1). A grant is
 * the consent of one user for one client, with the refresh tokens that the
 * client holds for that user. An app lists them on a "connected apps" page,
 * and a person ends one there. A reset or a change of the password deletes
 * the refresh tokens and keeps the consents (`deleteRefreshTokens`).
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
 * Ends the grant of one client: deletes the consent and every refresh token
 * of the user and the client. `{ ok: true }` also when nothing existed, so
 * the answer tells no caller which clients a user has. A refresh in flight
 * re-reads its spent row after its write and fails, and a code exchange
 * re-checks the consent (`exchangeCode`), so no new token outlives the call.
 */
export async function revokeGrant(
  config: ResolvedConfig,
  input: { userId: string; clientId: string },
): Promise<Result<{ ok: true }>> {
  // The consent first: a code exchange that runs between the two deletes
  // then finds no consent and writes no refresh token.
  await config.storage.delete("oauthConsent", [
    { field: "clientId", op: "eq", value: input.clientId },
    { field: "userId", op: "eq", value: input.userId },
  ]);
  await config.storage.delete("oauthToken", [
    { field: "userId", op: "eq", value: input.userId },
    { field: "clientId", op: "eq", value: input.clientId },
  ]);
  return ok({ ok: true });
}

/**
 * Deletes every refresh token of the user, in the caller's transaction: a
 * reset of either kind and a password change (spec 8.7, the plan 9g final
 * fix wave). The consents stay, so the next authorize asks for no consent,
 * but each client must send the person through the authorize step again.
 */
export async function deleteRefreshTokens(tx: StorageAdapter, userId: string): Promise<void> {
  await tx.delete("oauthToken", [{ field: "userId", op: "eq", value: userId }]);
}
