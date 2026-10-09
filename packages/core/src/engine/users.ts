import { newId } from "../primitives/ids.js";
import type { UserRow } from "../schema.js";
import { type StorageAdapter, StorageError } from "../storage/port.js";

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
        await tx.update("user", [{ field: "id", op: "eq", value: existing.id }], {
          emailVerified: true,
          updatedAt: now,
        });
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
