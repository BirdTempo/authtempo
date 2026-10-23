import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The Postgres half of "measures a list with no filter" (plan 12d Task 12,
// open point 8). A SCIM list with no filter reads every scimUser row of the
// organization for totalResults, because the storage port has no count.
// The test asserts the answer, not a time: the number is evidence for the
// docs, not a gate. Run vitest with --silent=false to see the line.

const API = "https://api.example.com";
const APP = { kind: "app", name: "measure" } as const;
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const ROWS = 10_000;
/** The creates in flight at once: the pool of freshDatabase has 4 connections. */
const IN_FLIGHT = 4;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

function world(storage: StorageAdapter) {
  const sent: MailMessage[] = [];
  const txt: Record<string, string[]> = {};
  const dns = (name: string) => ({ name, txt: async (asked: string) => txt[asked] ?? [] });
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    password: { requireVerified: false, uniformSignUp: false },
    organizations: {},
    sso: { dns: [dns("a"), dns("b")] },
    scim: {},
  });
  /** A verified user and its session, by a magic link. */
  async function signIn(email: string) {
    must(await auth.api.requestMagicLink({ email, ip: null }));
    const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const r = must(await auth.api.verifyMagicLink({ token, ip: null, userAgent: null }));
    if (!("token" in r)) throw new Error("a challenge");
    return r;
  }
  return { auth, txt, signIn };
}

function must<T>(r: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

describe("the SCIM list with no filter on Postgres (plan 12d Task 12)", () => {
  it("measures a list with no filter", { timeout: 600_000 }, async () => {
    const { auth, txt, signIn } = world(createPostgresAdapter(db.sql));
    const sso = auth.api.sso;
    const scim = auth.api.scim;
    if (!sso || !scim) throw new Error("no sso or scim api");
    const owner = await signIn("owner@acme.example");
    const organizationId = must(
      await auth.api.createOrganization({ user: owner.user, slug: "acme", name: "Acme" }),
    ).organization.id;
    const added = must(
      await sso.domains.add({ actor: APP, organizationId, domain: "acme.example" }),
    );
    if (added.record === null) throw new Error("no record");
    txt[added.record.name] = [added.record.value];
    must(await sso.domains.verify({ actor: APP, id: added.id }));
    const token = must(await scim.tokens.create({ actor: APP, organizationId, name: "dir" })).token;

    // The creates go through api.scim.users.create, the product path with the app as actor.
    const seeded = performance.now();
    for (let start = 0; start < ROWS; start += IN_FLIGHT) {
      const batch = Array.from({ length: Math.min(IN_FLIGHT, ROWS - start) }, (_, k) => start + k);
      const answers = await Promise.all(
        batch.map((i) =>
          scim.users.create({
            actor: APP,
            organizationId,
            body: { schemas: [USER_URN], userName: `u${String(i).padStart(5, "0")}@acme.example` },
          }),
        ),
      );
      for (const a of answers) if (a.status !== 201) expect(a.status).toBe(201);
    }
    const seedMs = performance.now() - seeded;

    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const res = await auth.handle(
        new Request(`${API}/auth/scim/v2/Users?count=100`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      const body = (await res.json()) as {
        totalResults: number;
        itemsPerPage: number;
        Resources: unknown[];
      };
      times.push(performance.now() - started);
      expect([res.status, body.totalResults, body.itemsPerPage, body.Resources.length]).toEqual([
        200,
        ROWS,
        100,
        100,
      ]);
    }
    console.log(
      `scim-list-measure store=postgres rows=${ROWS} runs=10 median_ms=${median(times).toFixed(2)} max_ms=${Math.max(...times).toFixed(2)} seed_ms=${seedMs.toFixed(0)}`,
    );
  });
});
