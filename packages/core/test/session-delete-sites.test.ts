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
/** The compat package stores core's rows too: the Step 1 grep of the brief reads it (review L3). */
const COMPAT = new URL("../../compat-better-auth/src/", import.meta.url);

type Kind =
  /** `endSessions` writes the outbox rows of the user's links in the flow's transaction. */
  | "endSessions"
  /** One session by id: `endSessionById` writes the outbox rows, then deletes. */
  | "by id"
  /** A list of sessions of any users: the outbox rows of their links, then the deletes by id, in one transaction. */
  | "by id list"
  /** The flow created this session in this transaction: no link can exist yet. */
  | "undo"
  /** Expired sessions: a later step makes each link with no session a logout (ruling 49). */
  | "expired"
  /** A call of `destroySession`, which is a "by id" site; the caller delivers after it. */
  | "sign-out"
  /** Sessions that a sign-in wrote after the read of the flow: a later step makes each link with no session a logout (ruling 49). */
  | "late";

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
  // Plan 12i Task 6: the anonymous delete of the route, and the page of the sweep.
  {
    file: "engine/anonymous.ts",
    fn: "endSessionsOf",
    call: "endSessions",
    count: 1,
    kind: "endSessions",
    reason: "the anonymous delete of the route; the outbox rows stay and are due now",
  },
  {
    file: "engine/anonymous.ts",
    fn: "deleteSessionsOf",
    call: 'delete("session"',
    count: 1,
    kind: "expired",
    reason:
      "the anonymous users of a sweep page, each with no live session; the link step makes each link with no session a logout",
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
    fn: "endAccess",
    call: "endSessions",
    count: 1,
    kind: "endSessions",
    reason:
      "endOtherSessions (the revoke of the other sessions, the password change, the email change) and endAllAccess (the ban, the end of one user's sessions by an operator)",
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
    count: 3,
    kind: "endSessions",
    reason:
      "the deletes of endSessions itself, after its outbox write; the first deletes each impersonation session by id with its stop row (ruling 43 of plan 12f)",
  },
  {
    file: "engine/oauth-outbox.ts",
    fn: "endSessionById",
    call: 'delete("session"',
    count: 1,
    kind: "by id",
    reason:
      "the sign-out, the revoke of one session, an expired row or a row of a banned user that a request presents, and RP-initiated logout",
  },
  {
    file: "engine/sessions.ts",
    fn: "deleteEndedSessions",
    call: 'delete("session"',
    count: 2,
    kind: "expired",
    reason:
      "the revoke of the other sessions, the ban, and the end of one user's sessions by an operator; endSessions after it, or the sweep, makes the dead links logouts",
  },
  {
    file: "engine/operator/sessions.ts",
    fn: "endSessionPage",
    call: 'delete("session"',
    count: 2,
    kind: "by id list",
    reason:
      "the end of all sessions, and of one user's sessions, by an operator, and the impersonation sessions of an operator at a ban, a revoke, an account delete, or a role loss (ruling 63): one delete per row with a hook, one per chunk of ids without; the outbox rows of the links that fit come first and are due now, and the sweep makes the rest",
  },
  {
    file: "engine/operator/sessions.ts",
    fn: "endUserSessions",
    call: 'delete("session"',
    count: 1,
    kind: "late",
    reason:
      "the last page of the end of one user's sessions: a session that a sign-in wrote after the read; the sweep makes its links logouts",
  },
  {
    file: "engine/operator/access-end.ts",
    fn: "endAllAccessPage",
    call: 'delete("session"',
    count: 1,
    kind: "late",
    reason:
      "the ban and the revoke of the platform role, when no session stays for the sweep: a session that a sign-in wrote after the read; the sweep makes its links logouts",
  },
  {
    file: "engine/sweep.ts",
    fn: "sweepExpired",
    call: 'delete("session"',
    count: 2,
    kind: "expired",
    reason:
      "the sweep, in a transaction after lockInOrder on an adapter with row locks, else in one statement; its link step makes each link of a gone session a logout",
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
    // The body of verifyTwoFactor, which emits the challenge event around it (plan 12h Task 5).
    fn: "answerChallenge",
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
  const files = [...sourceFiles(fs, SRC), ...sourceFiles(fs, COMPAT)];
  expect(files.some((f) => f.href.startsWith(COMPAT.href))).toBe(true);
  for (const file of files) {
    const text = code(fs.readFileSync(file, "utf8"));
    for (const m of text.matchAll(CALL_RE)) {
      const before = text.slice(0, m.index);
      // The definition of a function is no site.
      if (/function\s+$/.test(before)) continue;
      const fn = [...before.matchAll(/function\s+(\w+)/g)].at(-1)?.[1] ?? "(top)";
      const name = file.href.startsWith(COMPAT.href)
        ? `compat-better-auth/${file.href.slice(COMPAT.href.length)}`
        : file.href.slice(SRC.href.length);
      const key = `${name}|${fn}|${m[1] ?? 'delete("session"'}`;
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
