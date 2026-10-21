import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createSweepAuth, sweepHandler } from "./sweep.ts";

describe("delete expired rows", () => {
  it("deletes an expired link and answers every count", async () => {
    let now = new Date("2026-10-14T00:00:00.000Z");
    const auth = createSweepAuth(harness(), { now: () => now });
    await call(auth, "POST", "/auth/magic-link/request", { email: "ada@example.com" });
    now = new Date(now.getTime() + 16 * 60_000);
    const counts = await auth.api.sweepExpired();
    expect(counts.verificationExpired).toBe(1);
    expect(Object.keys(counts).sort()).toEqual([
      "apiTokens",
      "invitations",
      "jwks",
      "limits",
      "oauthClientSecrets",
      "oauthClients",
      "oauthDevices",
      "oauthLogouts",
      "oauthSessionLinks",
      "oauthTokens",
      "organizationTokens",
      "pendingSessions",
      "scimTokens",
      "sessions",
      "ssoDomains",
      "ssoPendingDomains",
      "totpSetups",
      "trustedDevices",
      "verificationConsumed",
      "verificationExpired",
    ]);
  });

  it("runs from the scheduled handler", async () => {
    const pending: Promise<unknown>[] = [];
    await sweepHandler(() => createSweepAuth(harness())).scheduled(
      {},
      {},
      { waitUntil: (p) => pending.push(p) },
    );
    // The handler hands the sweep to waitUntil, so the run outlives the event.
    expect(pending).toHaveLength(1);
    await expect(Promise.all(pending)).resolves.toHaveLength(1);
  });
});
