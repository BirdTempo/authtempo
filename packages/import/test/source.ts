import { createPbkdf2PasswordHash, type StorageAdapter } from "@authtempo/core";
import type { ImportOrganization, ImportRecord, ImportUser, Source } from "../src/types.js";

export const AT = new Date("2026-10-11T00:00:00.000Z");
export const BCRYPT = "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga"; // "allmine", Go x/crypto/bcrypt test

export function user(sourceId: string, over: Partial<ImportUser> = {}): ImportUser {
  return {
    kind: "user",
    sourceId,
    email: `${sourceId}@example.com`,
    emailVerified: true,
    name: null,
    image: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    identities: [],
    password: null,
    passkeys: [],
    ...over,
  };
}

export function org(
  sourceId: string,
  members: ImportOrganization["members"],
  over: Partial<ImportOrganization> = {},
): ImportOrganization {
  return {
    kind: "organization",
    sourceId,
    name: `Org ${sourceId}`,
    slug: null,
    createdAt: null,
    members,
    ...over,
  };
}

/** A Source over a fixed list, with the supabase name, so ids are stable across tests. */
export function listSource(records: ImportRecord[], roles: Source["roles"] = {}): Source {
  return {
    name: "supabase",
    roles,
    async *records() {
      yield* records;
    },
  };
}

/**
 * The rows a core flow writes for a user of the app, so a test seeds no state
 * core cannot reach. A verified user has its `email` identity (a magic link,
 * or a social sign-in with a verified address, writes it), plus each social
 * identity given. An unverified user is a password sign-up: the user row and
 * its password row.
 */
export async function appUser(
  db: StorageAdapter,
  id: string,
  email: string,
  verified: boolean,
  social: { provider: string; subject: string }[] = [],
): Promise<void> {
  await db.create("user", {
    id,
    email,
    emailVerified: verified,
    name: null,
    image: null,
    bannedAt: null,
    banReason: null,
    banUntil: null,
    createdAt: AT,
    updatedAt: AT,
  });
  const identities = verified ? [...social, { provider: "email", subject: email }] : social;
  for (const [n, i] of identities.entries()) {
    await db.create("identity", {
      id: `${id}-identity-${n}`,
      userId: id,
      provider: i.provider,
      subject: i.subject,
      linkedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    });
  }
  if (!verified) {
    await db.create("password", {
      id: `${id}-password`,
      userId: id,
      hash: await createPbkdf2PasswordHash().hash("an app password"),
      createdAt: AT,
      updatedAt: AT,
    });
  }
}
