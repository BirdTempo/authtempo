import { StorageError } from "@tempo-auth/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNames } from "../src/storage/names.js";
import { compatStatements } from "../src/storage/statements.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const row = (createdAt: unknown, updatedAt: unknown) => ({
  id: "u1",
  email: "a@example.com",
  emailVerified: 1,
  name: "",
  image: null,
  createdAt,
  updatedAt,
});

describe("a Better Auth date in SQLite's space form (plan 9b2)", () => {
  it("reads as UTC in any time zone of the process", () => {
    // Node reads "2024-01-15 10:30:00" as local time (probe, 2026-10-12). Auckland is never UTC.
    vi.stubEnv("TZ", "Pacific/Auckland");
    const st = compatStatements("sqlite", resolveNames());
    const user = st.decode("user", row("2024-01-15 10:30:00", "2024-01-15 10:30:00.5")) as {
      createdAt: Date;
      updatedAt: Date;
    };
    expect(user.createdAt).toEqual(new Date("2024-01-15T10:30:00.000Z"));
    expect(user.updatedAt).toEqual(new Date("2024-01-15T10:30:00.500Z"));
  });

  it("reads ISO text as before, and refuses text that is not a date with schema_mismatch", () => {
    const st = compatStatements("sqlite", resolveNames());
    const user = st.decode("user", row("2026-10-12T08:00:00.000Z", "2026-10-12T08:00:00.000Z")) as {
      createdAt: Date;
    };
    expect(user.createdAt).toEqual(new Date("2026-10-12T08:00:00.000Z"));
    let thrown: unknown;
    try {
      st.decode("user", row("2026-10-12T08:00:00.000Z", "yesterday"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(StorageError);
    expect(thrown).toMatchObject({ code: "schema_mismatch", model: "user", fields: ["updatedAt"] });
  });
});
