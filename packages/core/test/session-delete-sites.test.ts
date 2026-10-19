import { describe, expect, it } from "vitest";

/**
 * Each place in core that deletes a session row (plan 12e Task 16). A
 * session that a client got an ID token in has a client link. Its end must
 * write the back-channel outbox in the same transaction, or delete the link
 * with no logout for a stated reason. A new site fails this test until a
 * person names its kind and its reason here.
 */

/**
 * The node:fs read of the source. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck.
 */
interface SourceFs {
  readdirSync(
    dir: URL,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";
const SRC = new URL("../src/", import.meta.url);

type Kind =
  /** `endSessions` writes the outbox rows of the user's links in the flow's transaction. */
  | "endSessions"
  /** One session by id: `endSessionById` writes the outbox rows, then deletes. */
  | "by id"
  /** The flow created this session in this transaction: no link can exist yet. */
  | "undo"
  /** Expired sessions: the links go with no logout, as at the sweep. */
  | "expired"
  /** A call of `destroySession`, which is a "by id" site; the caller delivers after it. */
  | "sign-out";

interface Site {
  file: string;
  /** The nearest `function` name before the site. */
  fn: string;
  call: "endSessions" | "destroySession" | 'delete("session"';
  count: number;
  kind: Kind;
  reason: string;
}

const SITES: Site[] = [
  {
    file: "create-auth.ts",
    fn: "createAuth",
    call: "destroySession",
    count: 1,
    kind: "sign-out",
    reason: "api.signOut, then deliverLogouts",
  },
  {
    file: "http/routes/sessions.ts",
    fn: "clearSessionCookies",
    call: "destroySession",
    count: 1,
    kind: "sign-out",
    reason: "the legacy cookie of the cookie move, then deliverLogouts",
  },
  {
    file: "http/routes/sessions.ts",
    fn: "sessionRoutes",
    call: "destroySession",
    count: 1,
    kind: "sign-out",
    reason: "POST /sign-out, then deliverLogouts",
  },
  {
    file: "engine/account-delete.ts",
    fn: "deleteAccountRows",
    call: "endSessions",
    count: 1,
    kind: "endSessions",
    reason: "the account delete; the outbox rows stay and are due now",
  },
  {
    file: "engine/password.ts",
    fn: "applyReset",
    call: "endSessions",
    count: 1,
    kind: "endSessions",
    reason: "the password reset of a verified user",
  },
  {
    file: "engine/second-factor.ts",
    fn: "addMethod",
    call: "endSessions",
    count: 1,
    kind: "endSessions",
    reason: "the first second-factor enable ends the other sessions",
  },
  {
    file: "engine/session-list.ts",
    fn: "endOtherSessions",
    call: "endSessions",
    count: 1,
    kind: "endSessions",
    reason: "the revoke of the other sessions, the password change, the email change",
  },
  {
    file: "engine/users.ts",
    fn: "claimEmail",
    call: "endSessions",
    count: 1,
    kind: "endSessions",
    reason: "a claim; authorize refuses an unverified user, so no link is reachable",
  },
  {
    file: "engine/sessions.ts",
    fn: "endSessions",
    call: 'delete("session"',
    count: 2,
    kind: "endSessions",
    reason: "the deletes of endSessions itself, after its outbox write",
  },
  {
    file: "engine/oauth-outbox.ts",
    fn: "endSessionById",
    call: 'delete("session"',
    count: 1,
    kind: "by id",
    reason:
      "the sign-out, the revoke of one session, an expired row that a request presents, and RP-initiated logout",
  },
  {
    file: "engine/sessions.ts",
    fn: "deleteEndedSessions",
    call: 'delete("session"',
    count: 2,
    kind: "expired",
    reason: "the revoke of the other sessions; endSessions after it deletes the dead links",
  },
  {
    file: "engine/sweep.ts",
    fn: "sweepSessions",
    call: 'delete("session"',
    count: 1,
    kind: "expired",
    reason: "the sweep deletes the links of each page first",
  },
  {
    file: "engine/password.ts",
    fn: "insertSignUp",
    call: 'delete("session"',
    count: 1,
    kind: "undo",
    reason: "the sign-up drops its own new session",
  },
  {
    file: "engine/password.ts",
    fn: "passwordSignIn",
    call: 'delete("session"',
    count: 1,
    kind: "undo",
    reason: "the sign-in drops its own new session after a password race",
  },
  {
    file: "engine/social.ts",
    fn: "resolveSocialUser",
    call: 'delete("session"',
    count: 1,
    kind: "undo",
    reason: "the social sign-in drops its own new session after a claim",
  },
  {
    file: "engine/totp.ts",
    fn: "verifyTwoFactor",
    call: 'delete("session"',
    count: 1,
    kind: "undo",
    reason: "the second-factor verify drops its own new session after a spent challenge",
  },
];

const CALL_RE = /\b(endSessions|destroySession)\(|\.delete\(\s*"session"/g;

/** Comments become spaces, so a line number stays and a comment names no site. */
function code(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^\s*\/\/.*$/gm, blank);
}

/** Each `.ts` file under `dir`, as a URL. */
function sourceFiles(fs: SourceFs, dir: URL): URL[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(fs, new URL(`${entry.name}/`, dir));
    return entry.name.endsWith(".ts") ? [new URL(entry.name, dir)] : [];
  });
}

/** Each site of core as `file|fn|call`, with its count. */
async function foundSites(): Promise<Map<string, number>> {
  const fs: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
  const found = new Map<string, number>();
  for (const file of sourceFiles(fs, SRC)) {
    const text = code(fs.readFileSync(file, "utf8"));
    for (const m of text.matchAll(CALL_RE)) {
      const before = text.slice(0, m.index);
      // The definition of a function is no site.
      if (/function\s+$/.test(before)) continue;
      const fn = [...before.matchAll(/function\s+(\w+)/g)].at(-1)?.[1] ?? "(top)";
      const key = `${file.href.slice(SRC.href.length)}|${fn}|${m[1] ?? 'delete("session"'}`;
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  return found;
}

describe("the session delete sites (plan 12e Task 16)", () => {
  it("holds the list of session delete sites", async () => {
    const found = await foundSites();
    const named = new Map(SITES.map((s) => [`${s.file}|${s.fn}|${s.call}`, s.count]));
    // Each site in the code has a row, and each row names a site, with the same count.
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(named));
    for (const site of SITES) expect(site.reason.length, site.fn).toBeGreaterThan(0);
  });
});
