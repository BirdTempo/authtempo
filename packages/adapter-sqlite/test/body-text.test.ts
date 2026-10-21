import { DatabaseSync } from "node:sqlite";
import { createAuth, createPbkdf2PasswordHash } from "@authtempo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySqliteMigrations, createSqliteAdapter } from "../src/index.js";
import { nodeSqlite } from "../src/node.js";

// A NUL or a lone surrogate in a JSON body answers invalid_body on node:sqlite
// (plan 12g fix wave, m1). Before the fix, the where check of the port threw,
// and the route answered 500 internal. Core holds the memory test
// (packages/core/test/body-text.test.ts).

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const open: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of open.splice(0)) db.close();
});

async function signedIn() {
  const db = new DatabaseSync(":memory:");
  open.push(db);
  const driver = nodeSqlite(db);
  await applySqliteMigrations(driver);
  const mail: string[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createSqliteAdapter(driver),
    mail: {
      send: async (m) => {
        mail.push(m.text);
      },
    },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE] },
  });
  await auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  const cookie = `__Host-tempo_session=${r.value.token}`;
  return (text: string) =>
    auth.handle(
      new Request(`${BASE}/auth/passkeys/rename`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN, cookie },
        body: text,
      }),
    );
}

/** Each body text holds its fault as a JSON escape, as a client sends it. */
const REFUSED: [string, string][] = [
  ["a lone high surrogate in the id", '{"id":"\\ud800","name":"Phone"}'],
  ["a lone low surrogate in the id", '{"id":"\\udc00","name":"Phone"}'],
  ["a NUL in the id", '{"id":"a\\u0000b","name":"Phone"}'],
];

describe("the JSON body reader refuses a NUL and a lone surrogate on node:sqlite", () => {
  it.each(REFUSED)("answers 400 invalid_body for %s", async (_, text) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const rename = await signedIn();
    const res = await rename(text);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(errors).not.toHaveBeenCalled();
  });

  it("reads a surrogate pair as text, so the rename answers not_found", async () => {
    const rename = await signedIn();
    const res = await rename('{"id":"\\ud83d\\ude00","name":"Phone"}');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
