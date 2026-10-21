import { type AuthConfig, type MailMessage, resolveConfig } from "../src/config.js";
import { type VerifySteps, verifySteps } from "../src/engine/create-steps.js";
import type { UserVerifyVia } from "../src/engine/hooks.js";
import { createDefaultObserver } from "../src/observe/observer.js";
import { systemClock } from "../src/primitives/clock.js";
import { newId } from "../src/primitives/ids.js";
import type { UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

export const BASE_URL = "https://api.example.com";

/** The hook that the event recorder sets (plan 12h Task 12). With no recorder, a call does nothing. */
type RecordHook = (kind: "credential" | "address", value: string) => void;
const record = (): RecordHook | undefined =>
  (globalThis as { __authtempoRecord?: RecordHook }).__authtempoRecord;

/**
 * Puts a token, a code, or a password that a helper mints on the deny list
 * of the event check. No event of the suite may hold it. Answers the value.
 */
export function recordCredential(value: string): string {
  record()?.("credential", value);
  return value;
}

/**
 * Puts an email, an IP, or a user agent of a request on the address list of
 * the event check. No event may hold it under the default include. Answers
 * the value.
 */
export function recordAddress(value: string): string {
  record()?.("address", value);
  return value;
}

/** The addresses of a request that a helper builds: the IP and agent headers, and a body email. */
function recordRequest(headers: Record<string, string>, body?: unknown): void {
  for (const name of ["cf-connecting-ip", "x-forwarded-for", "user-agent"]) {
    const value = headers[name];
    if (value !== undefined) recordAddress(value);
  }
  if (typeof body === "object" && body !== null) {
    const email: unknown = (body as { email?: unknown }).email;
    if (typeof email === "string") recordAddress(email);
  }
}
export const APP_ORIGIN = "https://app.example.com";

/**
 * The time limit of a core test that makes hundreds of rows or calls (review
 * m3 of plan 12d Task 4b). The default of 5 s is too short under load. The
 * test "keeps at most 500 discovery entries" took 288 ms alone. It timed out
 * at 5 s in 2 of 3 core runs while other lanes ran their tests. The demo
 * pool tests use the same limit (apps/demo/test/test-time.ts).
 */
export const LONG_TEST_MS = 20_000;

export function makeAuth(overrides: Partial<AuthConfig> = {}) {
  let current = new Date("2026-01-01T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const sent: MailMessage[] = [];
  const storage = createMemoryAdapter();
  const config = resolveConfig({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    clock,
    ...overrides,
  });
  async function seedUser(email: string): Promise<UserRow> {
    recordAddress(email);
    const now = clock.now();
    return storage.create("user", {
      id: newId(now),
      email,
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { config, storage, mail: sent, clock, seedUser };
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  recordRequest(headers, body);
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

export function get(path: string, headers: Record<string, string> = {}): Request {
  recordRequest(headers);
  return new Request(`${BASE_URL}${path}`, { headers });
}

/** The token from a magic link the fake mail port recorded. */
export function tokenFromMail(text: string): string {
  const m = /token=([A-Za-z0-9_%-]+)/.exec(text);
  if (!m?.[1]) throw new Error("no token in mail");
  return recordCredential(decodeURIComponent(m[1]));
}

export function platformAuth() {
  return makeAuth({
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
  });
}

/** The platform slug is reserved, so the app seeds the organization and root's membership through storage, as a migration would. */
export async function seedPlatform(auth: ReturnType<typeof makeAuth>) {
  const root = await auth.seedUser("root@example.com");
  const now = auth.clock.now();
  const platformOrg = await auth.storage.create("organization", {
    id: "org-platform",
    slug: "platform-co",
    name: "Platform",
    metadata: null,
    createdAt: now,
    updatedAt: now,
  });
  await auth.storage.create("member", {
    id: "m-root",
    organizationId: platformOrg.id,
    userId: root.id,
    role: "owner,operator",
    createdAt: now,
    updatedAt: now,
  });
  return { root, platformOrg };
}

/**
 * The verify steps of a flow with no hook set (plan 12a, Task 18), for a
 * test that calls a resolver directly. The resolver runs `before` itself.
 */
export function noVerifyHooks(via: UserVerifyVia): VerifySteps {
  return verifySteps(
    {
      hooks: { organization: {}, session: {}, user: {}, identity: {}, operator: {} },
      observe: DEFAULT_OBSERVE,
    },
    via,
  );
}

/**
 * The observer of a config with no `observe` (plan 12h). A test that calls an
 * engine part directly uses it. It writes the log lines of today.
 */
export const DEFAULT_OBSERVE = createDefaultObserver({ clock: systemClock, secrets: new Set() });
