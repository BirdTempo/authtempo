import { createMemoryAdapter } from "@tempo-auth/core";
import { describe, expect, it } from "vitest";
import { importUsers } from "../../src/import.js";
import { authjsSource } from "../../src/readers/authjs.js";
import { all, now } from "./all.js";

describe("authjsSource", () => {
  // Columns: the Prisma schema of nextauthjs/next-auth main, read 2026-10-11.
  const TABLES = JSON.stringify({
    users: [
      {
        id: "cuid1",
        name: "Ida",
        email: "ida@example.com",
        emailVerified: "2024-01-01T00:00:00.000Z",
        image: null,
        passwordHash: "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga",
      },
      { id: "cuid2", name: null, email: "jo@example.com", emailVerified: null, image: null },
    ],
    accounts: [
      { userId: "cuid1", type: "oidc", provider: "google", providerAccountId: "g-1" },
      { userId: "cuid1", type: "email", provider: "resend", providerAccountId: "ida@example.com" },
      { userId: "cuid2", type: "oauth", provider: "github", providerAccountId: "gh-2" },
    ],
    authenticators: [
      {
        credentialID: "AQID+/8=",
        userId: "cuid1",
        providerAccountId: "x",
        credentialPublicKey: "pQECAyYg+/==",
        counter: 4,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        transports: "internal,hybrid",
      },
    ],
  });

  it("maps the tables, takes the password column the operator names, and keeps passkeys only under the same rp id", async () => {
    const strict = await all(authjsSource({ tables: TABLES, passwordColumn: "passwordHash" }));
    expect(strict[0]).toMatchObject({
      emailVerified: true,
      identities: [{ provider: "google", subject: "g-1" }],
      password: { hash: "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga" },
      passkeys: [],
      dropped: ["passkey:rp_id_not_confirmed"],
    });
    expect(strict[1]).toMatchObject({ emailVerified: false, createdAt: null, password: null });
    const same = await all(authjsSource({ tables: TABLES, samePasskeyRpId: true }));
    expect(same[0]).toMatchObject({
      password: null,
      passkeys: [
        {
          credentialId: "AQID-_8",
          publicKey: "pQECAyYg-_",
          counter: 4,
          transports: "internal,hybrid",
          deviceType: "multiDevice",
          backedUp: true,
          name: null,
        },
      ],
    });
  });

  it("writes the email identity and the passkey only for the verified user", async () => {
    const db = createMemoryAdapter();
    const report = await importUsers(
      db,
      authjsSource({ tables: TABLES, passwordColumn: "passwordHash", samePasskeyRpId: true }),
      { now },
    );
    expect(
      (await db.findMany("identity", [])).map((i) => `${i.provider}:${i.subject}`).sort(),
    ).toEqual(["email:ida@example.com", "google:g-1"]);
    expect((await db.findMany("passkey", [])).map((p) => p.credentialId)).toEqual(["AQID-_8"]);
    expect(report.created).toMatchObject({ user: 2, password: 1, passkey: 1 });
    expect(report.dropped).toContainEqual({ sourceId: "cuid2", item: "identity:github" });
  });
});
