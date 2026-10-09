import { newId } from "../primitives/ids.js";
import type { UserRow } from "../schema.js";
import { type StorageAdapter, StorageError, type Where } from "../storage/port.js";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

/**
 * Lowercase, trimmed, and shaped like an address, or null. The shape check
 * is loose on purpose: the magic link proves the address. A control
 * character is never part of an address, and storage rejects U+0000.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  for (const ch of email) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return email;
}

/**
 * A user created through an unverified email is a claim, not proof. When a
 * sign-in proves the address, every identity that came in before (except
 * the one that carries the proof, and the `email` identity), every
 * session, every passkey, every pending passkey challenge, and every
 * unredeemed handoff code are deleted, so a claimant cannot keep access to the account.
 * Runs inside the caller's transaction.
 */
export async function claimEmail(
  tx: StorageAdapter,
  userId: string,
  keepIdentityId: string | null,
  now: Date,
): Promise<void> {
  const where: Where<"identity">[] = [
    { field: "userId", op: "eq", value: userId },
    { field: "provider", op: "ne", value: "email" },
  ];
  if (keepIdentityId) where.push({ field: "id", op: "ne", value: keepIdentityId });
  await tx.delete("identity", where);
  await tx.delete("session", [{ field: "userId", op: "eq", value: userId }]);
  // A claimant's passkeys would keep the account open after the claim.
  // Registration already needs a verified email; this closes any other path.
  await tx.delete("passkey", [{ field: "userId", op: "eq", value: userId }]);
  await tx.delete("verification", [
    { field: "purpose", op: "eq", value: "passkey-challenge" },
    { field: "identifier", op: "eq", value: userId },
  ]);
  // A handoff code minted for the claimant would trade for a session after the claim.
  await tx.delete("verification", [
    { field: "purpose", op: "eq", value: "handoff-code" },
    { field: "identifier", op: "eq", value: userId },
  ]);
  await tx.update("user", [{ field: "id", op: "eq", value: userId }], {
    emailVerified: true,
    updatedAt: now,
  });
}

export async function findOrCreateUserByEmail(
  storage: StorageAdapter,
  email: string,
  now: Date,
): Promise<{ user: UserRow; created: boolean }> {
  try {
    return await createOrFindInTransaction(storage, email, now);
  } catch (err) {
    // A concurrent call created the user between our read and our create.
    // Return that row. Any other failure, or a missing row, is a real error.
    if (
      err instanceof StorageError &&
      err.code === "unique_violation" &&
      (err.model === "user" || err.model === "identity")
    ) {
      const winner = await storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
      if (winner) return { user: winner, created: false };
    }
    throw err;
  }
}

function createOrFindInTransaction(
  storage: StorageAdapter,
  email: string,
  now: Date,
): Promise<{ user: UserRow; created: boolean }> {
  return storage.transaction(async (tx) => {
    const existing = await tx.findOne("user", [{ field: "email", op: "eq", value: email }]);
    if (existing) {
      // An isolate that died between the user create and the identity
      // create left a user with no email identity. Repair it here. A
      // concurrent repair fails unique_violation, which the caller catches
      // outside this transaction.
      const identity = await tx.findOne("identity", [
        { field: "provider", op: "eq", value: "email" },
        { field: "subject", op: "eq", value: email },
      ]);
      if (!identity) {
        await tx.create("identity", {
          id: newId(now),
          userId: existing.id,
          provider: "email",
          subject: email,
          linkedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (!existing.emailVerified) {
        await claimEmail(tx, existing.id, null, now);
        return { user: { ...existing, emailVerified: true, updatedAt: now }, created: false };
      }
      return { user: existing, created: false };
    }
    const user = await tx.create("user", {
      id: newId(now),
      email,
      emailVerified: true,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    await tx.create("identity", {
      id: newId(now),
      userId: user.id,
      provider: "email",
      subject: email,
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { user, created: true };
  });
}
