import { createMemoryAdapter, createMemoryLimiter, systemClock } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import type { CompatDatabase } from "../src/types.js";
import { adminApp, PASSWORD } from "./admin-helpers.js";

// Core's cap of the sessions of one user under the shim (plan 12q). Better
// Auth has no cap. `authtempo.sessionMaxPerUser` is core's
// `session.maxPerUser`, 1 to 1000, and core's default of 100 holds without
// it. A sign-in past the cap ends the oldest session of the user.

const BASE = "https://api.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";

function memoryDatabase(): CompatDatabase {
  return {
    kind: "authtempo-compat-database",
    dialect: "postgres",
    storage: createMemoryAdapter(),
    limiter: createMemoryLimiter(systemClock),
  };
}

describe("authtempo.sessionMaxPerUser (plan 12q)", () => {
  it("maps to core's session.maxPerUser, and leaves core's default without it", () => {
    const options = { baseURL: BASE, secret: SECRET, database: memoryDatabase() };
    expect(
      mapOptions({ ...options, authtempo: { sessionMaxPerUser: 5 } }).config.session?.maxPerUser,
    ).toBe(5);
    expect(mapOptions(options).config.session?.maxPerUser).toBeUndefined();
    expect(checkOptions({ ...options, authtempo: { sessionMaxPerUser: 1000 } }).refusals).toEqual(
      [],
    );
    // A string is what a JavaScript caller can pass, so this value leaves the type on purpose.
    for (const sessionMaxPerUser of [0, 1001, 2.5, "3" as unknown as number])
      expect(checkOptions({ ...options, authtempo: { sessionMaxPerUser } }).refusals).toEqual([
        "authtempo.sessionMaxPerUser: core takes 1 to 1000",
      ]);
  });

  it("ends the oldest session of the user past the cap at a sign-in", async () => {
    const database = { ...memoryDatabase(), limiter: { allow: async () => true } };
    const a = await adminApp(database, { sessionMaxPerUser: 2 });
    // The verify and the first sign-in open two sessions: the cap.
    const ann = await a.user("ann@example.com");
    const byAnn = () =>
      database.storage.findMany("session", [{ field: "userId", op: "eq", value: ann.id }], {
        sort: { field: "id", dir: "asc" },
      });
    const [oldest, kept] = await byAnn();
    expect(kept).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 3));
    const signIn = await a.call("/password/sign-in", {
      email: "ann@example.com",
      password: PASSWORD,
    });
    expect(signIn.status).toBe(200);
    const now = await byAnn();
    expect(now.length).toBe(2);
    expect(now.map((s) => s.id)).not.toContain(oldest?.id);
    expect(now[0]?.id).toBe(kept?.id);
  });
});
