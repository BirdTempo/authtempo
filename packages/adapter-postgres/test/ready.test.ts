import { createAuth } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { oldDatabase } from "./db.js";

describe("GET /ready on Postgres (plan 12h Task 8)", () => {
  it("answers not_ready schema for an old schema", async () => {
    const db = await oldDatabase();
    try {
      const auth = createAuth({
        baseURL: "https://api.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [],
        storage: createPostgresAdapter(db.sql),
        mail: { send: async () => {} },
        observe: { sink: { write: () => {} }, readiness: true },
      });
      const res = await auth.handle(new Request("https://api.example.com/auth/ready"));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "not_ready", reason: "schema" });
      // The health route reads no storage, so it answers 200 with the same old schema.
      expect((await auth.handle(new Request("https://api.example.com/auth/health"))).status).toBe(
        200,
      );
    } finally {
      await db.close();
    }
  });
});
