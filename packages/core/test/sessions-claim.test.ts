import { describe, expect, it } from "vitest";
import { requestMagicLink, verifyMagicLink } from "../src/engine/magic-link.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { completeSocial, resolveSocialUser, startSocial } from "../src/engine/social.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { tokenFromMail } from "./helpers.js";
import { type FakeIdToken, fakeJwt, GOOGLE, socialAuth } from "./social-helpers.js";

const EMAIL = "ada@example.com";

/** Starts a Google flow and returns what the callback needs. */
async function started(auth: ReturnType<typeof socialAuth>) {
  const r = await startSocial(auth.config, { provider: "google", next: "/home", ip: "1.1.1.1" });
  if (!r.ok) throw new Error(`start failed: ${r.code}`);
  const url = new URL(r.value.location);
  return {
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    bindToken: r.value.bindToken,
  };
}

function googleToken(nonce: string, claims: Record<string, unknown>): FakeIdToken {
  return {
    audience: GOOGLE.clientId,
    issuer: "https://accounts.google.com",
    claims: { sub: "g-1", email: EMAIL, email_verified: true, nonce, ...claims },
  };
}

function complete(auth: ReturnType<typeof socialAuth>, s: Awaited<ReturnType<typeof started>>) {
  return completeSocial(auth.config, {
    provider: "google",
    state: s.state,
    code: "code-1",
    error: null,
    bindToken: s.bindToken,
    ip: "1.1.1.1",
    userAgent: "ua",
  });
}

async function magicLinkToken(auth: ReturnType<typeof socialAuth>): Promise<string> {
  await requestMagicLink(auth.config, { email: EMAIL, ip: null });
  return tokenFromMail(auth.mail.at(-1)?.text ?? "");
}

describe("the session is created inside the claim transaction (plan 7 input, Review Focus 1)", () => {
  it("leaves no claimant session when the claimant's callback races the owner's magic link", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    const now = auth.clock.now();
    // The claimant holds an unverified account for the owner's address, and a session on it.
    const claim = await resolveSocialUser(
      auth.storage,
      "google",
      {
        subject: "attacker",
        email: EMAIL,
        emailVerified: false,
        name: null,
        image: null,
      },
      now,
    );
    if (!claim.ok) throw new Error("no claimant");
    const userId = claim.value.id;
    await createSession(auth.config, { userId, ip: null, userAgent: null });

    // The claimant's second callback is in flight.
    const s = await started(auth);
    tokens["idtok-default"] = googleToken(s.nonce, { sub: "attacker", email_verified: false });
    const link = await magicLinkToken(auth);

    // The memory adapter runs one transaction at a time. The owner's magic
    // link verify runs in the gap after the claimant's resolution
    // transaction commits and before completeSocial returns: the gap where
    // the old order created the claimant's session after the claim.
    const original = auth.storage.transaction.bind(auth.storage);
    let armed = true;
    let owner: Awaited<ReturnType<typeof verifyMagicLink>> | null = null;
    auth.storage.transaction = async <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> => {
      const value = await original(fn);
      if (armed) {
        armed = false;
        owner = await verifyMagicLink(auth.config, { token: link, ip: null, userAgent: null });
      }
      return value;
    };

    const claimant = await complete(auth, s);
    expect(armed).toBe(false);
    expect(claimant.ok).toBe(true);
    const proved = owner as Awaited<ReturnType<typeof verifyMagicLink>> | null;
    if (!proved?.ok || !claimant.ok) throw new Error("a flow failed");
    expect(proved.value.user.id).toBe(userId);

    // Exactly the owner's session survives. Nothing older, and nothing the claimant wrote.
    const sessions = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: userId },
    ]);
    expect(sessions.map((x) => x.tokenHash)).toEqual([await sha256Hex(proved.value.token)]);
    expect(await resolveSession(auth.config, claimant.value.token)).toBeNull();
    expect(await resolveSession(auth.config, proved.value.token)).not.toBeNull();
  });

  /** Records, for each session write, whether it went through a transaction's `tx`. */
  function recordSessionWrites(storage: StorageAdapter): ("tx" | "raw")[] {
    const seen: ("tx" | "raw")[] = [];
    const rawCreate = storage.create.bind(storage);
    const rawTransaction = storage.transaction.bind(storage);
    storage.create = (m, d) => {
      if (m === "session") seen.push("raw");
      return rawCreate(m, d);
    };
    storage.transaction = <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      rawTransaction((tx) =>
        fn({
          ...tx,
          create: (m, d) => {
            if (m === "session") seen.push("tx");
            return tx.create(m, d);
          },
        }),
      );
    return seen;
  }

  it("writes the magic link session through the transaction's tx", async () => {
    const auth = socialAuth();
    const link = await magicLinkToken(auth);
    const seen = recordSessionWrites(auth.storage);
    const r = await verifyMagicLink(auth.config, { token: link, ip: null, userAgent: null });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["tx"]);
  });

  it("writes the social session through the transaction's tx", async () => {
    const tokens: Record<string, FakeIdToken> = {};
    const auth = socialAuth({}, fakeJwt(tokens));
    const s = await started(auth);
    tokens["idtok-default"] = googleToken(s.nonce, {});
    const seen = recordSessionWrites(auth.storage);
    const r = await complete(auth, s);
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["tx"]);
  });
});
