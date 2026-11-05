import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  answer,
  BUDGET,
  CLAIMED,
  call,
  clear,
  endings,
  FLIP,
  googleIdToken,
  LEASE,
  make,
  measure,
  OLD,
  ownerLink,
  post,
  sessionsOf,
  tokenOf,
  userId,
  type World,
} from "./session-proof-world.js";

// A sign-in of the claimant that straddles the claim on D1 (decision 6 of
// plan 12p, ruling 16). The claim takes its lease, deletes every row that a
// sign-in trusts, flips the flag, and deletes the sessions last. Each
// sign-in that trusts such a row ends with a conditional update on it.
//
// Each sign-in, the password and the social one, has three scenes.
// (a) The sign-in runs after the flip. Its row is gone, so no session opens.
// (b) The sign-in runs after the lease. Its session is unproved, so at the
//     flip the door of a claimed session refuses it and ends it (ruling 13
//     of plan 12q).
// (c) The sign-in reads its row before the claim. The whole claim runs
//     before its session insert, and the guard finds no row and undoes it.
// Each scene sends real requests through `auth.handle`. The other request
// runs beside one statement, as a parallel invocation does on D1.

const INSERT_SESSION = /^INSERT INTO ta_session\b/;

beforeEach(clear);

/** A sign-in of the claimant: the password, or Google with the claimant's own identity. */
interface SignIn {
  name: string;
  /** The claimant's account and its first session, before the race. */
  start: (w: World) => Promise<void>;
  /** The request of a new sign-in, built before it runs. */
  request: (w: World) => Promise<Request>;
  /** The answer when the claim took the row that the sign-in trusts. */
  refused: string;
}

const PASSWORD: SignIn = {
  name: "the password sign-in",
  start: async (w) => {
    const up = await call(w, post("/password/sign-up", { email: CLAIMED, password: OLD }));
    expect(await answer(up)).toBe("200 ok");
  },
  request: async () => post("/password/sign-in", { email: CLAIMED, password: OLD }),
  refused: "401 invalid_credentials",
};

const SOCIAL: SignIn = {
  name: "the social sign-in",
  // Google reports the address unverified, so the account is a claim with a Google identity.
  start: async (w) => {
    const up = await call(w, await googleIdToken(w, "g-claimant", false));
    expect(await answer(up)).toBe("200 ok");
  },
  request: (w) => googleIdToken(w, "g-claimant", false),
  refused: "409 email_taken_unverified",
};

/** The rows of the claimed user after the claim: the identities, the passwords, and each session. */
async function rowsOf(id: string) {
  const ids = async (sql: string) =>
    (await env.DB.prepare(sql).bind(id).all<{ v: string }>()).results.map((r) => r.v);
  return {
    verified:
      (
        await env.DB.prepare("SELECT email_verified AS v FROM ta_user WHERE id = ?")
          .bind(id)
          .first<{ v: number }>()
      )?.v ?? -1,
    identities: await ids(
      "SELECT provider AS v FROM ta_identity WHERE user_id = ? ORDER BY provider",
    ),
    passwords: (await ids("SELECT id AS v FROM ta_password WHERE user_id = ?")).length,
    tokens: (await ids("SELECT id AS v FROM ta_api_token WHERE user_id = ?")).length,
    sessions: (await sessionsOf(id)).map((s) => s.proved),
  };
}

/** The state after a claim by the owner's magic link: a verified user, its email identity, and one proved session. */
const CLAIMED_STATE = {
  verified: 1,
  identities: ["email"],
  passwords: 0,
  tokens: 0,
  sessions: [1],
};

const HOOKS = [true, false] as const;

for (const signIn of [PASSWORD, SOCIAL])
  describe(`${signIn.name} of the claimant that straddles the claim on D1 (plan 12p decision 6)`, () => {
    for (const hook of HOOKS) {
      it(`(a) runs after the flip, finds its row gone, and opens no session (afterEnd hook ${hook})`, async () => {
        const other = make({ counted: false, hook });
        await signIn.start(other);
        const id = await userId(CLAIMED);
        const first = (await sessionsOf(id)).map((s) => s.id);
        const verify = await ownerLink(other);
        let seen: string | null = null;
        const owner = make({
          counted: true,
          hook,
          after: async (sql) => {
            if (seen !== null || !FLIP.test(sql)) return;
            seen = "";
            seen = await answer(await call(other, await signIn.request(other)));
          },
        });
        const proved = await measure(owner, verify);
        expect(await answer(proved.res)).toBe("200 ok");
        expect(proved.queries).toBeLessThanOrEqual(BUDGET);
        expect(seen).toBe(signIn.refused);
        expect(await rowsOf(id)).toEqual(CLAIMED_STATE);
        expect([...endings].sort()).toEqual(hook ? first.map((s) => `claim:${s}`).sort() : []);
      });

      it(`(b) runs after the lease, opens an unproved session, and the door ends it at the flip (afterEnd hook ${hook}, ruling 13 of plan 12q)`, async () => {
        const other = make({ counted: false, hook });
        await signIn.start(other);
        const id = await userId(CLAIMED);
        const first = (await sessionsOf(id)).map((s) => s.id);
        const verify = await ownerLink(other);
        const request = await signIn.request(other);
        let stage: "armed" | "signed in" | "done" = "armed";
        let straddle: {
          answer: string;
          token: string | null;
          ids: string[];
          proved: number[];
        } | null = null;
        let atFlip: string | null = null;
        const owner = make({
          counted: true,
          hook,
          after: async (sql) => {
            if (stage === "armed" && LEASE.test(sql)) {
              const lease = await env.DB.prepare(
                "SELECT count(*) AS n FROM ta_verification WHERE purpose = 'claim-lease'",
              ).first("n");
              if (Number(lease) !== 1) return;
              stage = "signed in";
              const res = await call(other, request);
              const token = tokenOf(res);
              const made = (await sessionsOf(id)).filter((s) => !first.includes(s.id));
              straddle = {
                answer: await answer(res),
                token,
                ids: made.map((s) => s.id),
                proved: made.map((s) => s.proved),
              };
            } else if (stage === "signed in" && FLIP.test(sql)) {
              stage = "done";
              const token = (straddle as { token: string | null } | null)?.token ?? null;
              atFlip = await answer(await call(other, post("/tokens", { name: "kept" }, token)));
            }
          },
        });
        const proved = await measure(owner, verify);
        expect(await answer(proved.res)).toBe("200 ok");
        expect(proved.queries).toBeLessThanOrEqual(BUDGET);
        expect(stage).toBe("done");
        // The sign-in read the user before the flip: its session is live and unproved.
        expect(straddle).toMatchObject({ answer: "200 ok", proved: [0] });
        expect(atFlip).toBe("401 unauthorized");
        expect(await rowsOf(id)).toEqual(CLAIMED_STATE);
        // The door ends the straddle's session with the reason claimed, and the
        // claim ends the first ones with the reason claim. The hook sees each end once.
        const ids = (straddle as { ids: string[] } | null)?.ids ?? [];
        expect(ids).toHaveLength(1);
        expect([...endings].sort()).toEqual(
          hook ? [...first.map((s) => `claim:${s}`), ...ids.map((s) => `claimed:${s}`)].sort() : [],
        );
      });

      it(`(c) reads its row before the claim, inserts after it, and its guard undoes the session (afterEnd hook ${hook})`, async () => {
        const other = make({ counted: false, hook });
        await signIn.start(other);
        const id = await userId(CLAIMED);
        const first = (await sessionsOf(id)).map((s) => s.id);
        const verify = await ownerLink(other);
        const request = await signIn.request(other);
        let claimed: string | null = null;
        const claimant = make({
          counted: true,
          hook,
          // The whole claim lands after the sign-in's reads and before its session insert.
          before: async (sql) => {
            if (claimed !== null || !INSERT_SESSION.test(sql)) return;
            claimed = "";
            claimed = await answer(await call(other, verify));
          },
        });
        const signedIn = await measure(claimant, request);
        expect(claimed).toBe("200 ok");
        expect(await answer(signedIn.res)).toBe(signIn.refused);
        expect(tokenOf(signedIn.res)).toBeNull();
        expect(signedIn.queries).toBeLessThanOrEqual(BUDGET);
        expect(await rowsOf(id)).toEqual(CLAIMED_STATE);
        // The guard deletes the session that it wrote: the hook sees only the claim's ends.
        expect([...endings].sort()).toEqual(hook ? first.map((s) => `claim:${s}`).sort() : []);
      });
    }
  });
