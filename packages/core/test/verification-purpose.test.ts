import { describe, expect, it } from "vitest";
import { consumeVerification } from "../src/engine/verification.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { socialAuth, startGoogle, stateRow } from "./social-helpers.js";

// GHSA-965c-763c-88jm: Better Auth accepted the state of an OAuth sign-in as
// a magic link token. Core reads a verification row by its hash and its
// purpose, so a row of one purpose never answers the consume of another.
describe("consumeVerification and the purpose", () => {
  it("does not consume the state of a social sign-in as a magic link (GHSA-965c-763c-88jm)", async () => {
    const auth = socialAuth();
    const { state } = await startGoogle(auth);
    const valueHash = await sha256Hex(state);
    const now = auth.config.clock.now();
    expect(await stateRow(auth.storage, state)).toMatchObject({
      purpose: "oauth-state",
      consumedAt: null,
    });

    const r = await consumeVerification(auth.storage, { purpose: "magic-link", valueHash, now });
    expect(r).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await stateRow(auth.storage, state)).toMatchObject({
      purpose: "oauth-state",
      consumedAt: null,
    });

    // The same hash with its own purpose consumes the row, so the call above read the right row.
    const own = await consumeVerification(auth.storage, { purpose: "oauth-state", valueHash, now });
    expect(own.ok).toBe(true);
    expect((await stateRow(auth.storage, state))?.consumedAt).toEqual(now);
  });
});
