import { describe, expect, it } from "vitest";
import { applySqliteMigrations, createSqliteAdapter } from "../src/index.js";
import { DRIVER_KINDS, openDriver } from "./support/drivers.js";

const at = new Date("2026-10-21T00:00:00.000Z");
const user = (id: string, email: string) => ({
  id,
  email,
  emailVerified: false,
  name: null,
  image: null,
  bannedAt: null,
  banReason: null,
  banUntil: null,
  createdAt: at,
  updatedAt: at,
});

describe.each(DRIVER_KINDS)("sqlite errors on %s", (kind) => {
  it("maps a unique violation to its fields on each driver", async () => {
    const d = openDriver(kind);
    try {
      await applySqliteMigrations(d.driver);
      const db = createSqliteAdapter(d.driver);
      await db.create("user", user("u1", "a@example.com"));
      await expect(db.create("user", user("u2", "a@example.com"))).rejects.toMatchObject({
        name: "StorageError",
        code: "unique_violation",
        model: "user",
        fields: ["email"],
      });
    } finally {
      d.close();
    }
  });
});
