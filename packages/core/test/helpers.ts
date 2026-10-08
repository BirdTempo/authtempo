import { type AuthConfig, type MailMessage, resolveConfig } from "../src/config.js";
import { newId } from "../src/primitives/ids.js";
import type { UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

export const BASE_URL = "https://api.example.com";
export const APP_ORIGIN = "https://app.example.com";

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
    const now = clock.now();
    return storage.create("user", {
      id: newId(now),
      email,
      emailVerified: true,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { config, storage, mail: sent, clock, seedUser };
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

export function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE_URL}${path}`, { headers });
}

/** The token from a magic link the fake mail port recorded. */
export function tokenFromMail(text: string): string {
  const m = /token=([A-Za-z0-9_%-]+)/.exec(text);
  if (!m?.[1]) throw new Error("no token in mail");
  return decodeURIComponent(m[1]);
}
