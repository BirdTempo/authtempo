import { describe, expect, it } from "vitest";
import { call, harness, signIn } from "../support/harness.ts";
import { auditLog, createHooksAuth } from "./hooks.ts";

describe("run your code at a hook point", () => {
  it("refuses with the app's message, and records the after events", async () => {
    auditLog.length = 0;
    const h = harness();
    const auth = createHooksAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");

    const refused = await call(
      auth,
      "POST",
      "/auth/organizations/create",
      { slug: "acme-x", name: "X" },
      { cookie: ada },
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "hook_refused",
      message: "Choose another name.",
    });

    const made = await call(
      auth,
      "POST",
      "/auth/organizations/create",
      { slug: "team", name: "Team" },
      { cookie: ada },
    );
    expect(made.status).toBe(200);
    expect(
      auditLog.some((line) => line.startsWith("member.added ") && line.endsWith(" create")),
    ).toBe(true);

    await call(auth, "POST", "/auth/sign-out", {}, { cookie: ada });
    expect(
      auditLog.some((line) => line.startsWith("session.ended ") && line.endsWith(" sign_out")),
    ).toBe(true);
  });
});
