import { newId } from "../primitives/ids.js";
import type { UserRow } from "../schema.js";
import type { StorageAdapter } from "../storage/port.js";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

/** Lowercase, trimmed, and shaped like an address, or null. The shape check is loose on purpose: the magic link proves the address. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export async function findOrCreateUserByEmail(
  storage: StorageAdapter,
  email: string,
  now: Date,
): Promise<{ user: UserRow; created: boolean }> {
  return storage.transaction(async (tx) => {
    const existing = await tx.findOne("user", [{ field: "email", op: "eq", value: email }]);
    if (existing) {
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
