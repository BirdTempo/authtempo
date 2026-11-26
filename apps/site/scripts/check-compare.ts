import type { CompareRow } from "../src/data/compare.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/**
 * Where the code holds a feature: a route path or feature of ROUTES, an auth
 * form of a route, a config key, a command of the CLI (COMMANDS), or a
 * tracked file of this repository. Use a file only when the file is the
 * feature: a policy file, or the one module of a package entry.
 */
export type CodeHold =
  | { route: string }
  | { feature: string }
  | { auth: string }
  | { key: string }
  | { command: string }
  | { file: string };

/** One feature of the code that an authtempo cell can deny, by the words that name it. */
export interface CodeFact {
  name: string;
  /** A regex source of the words that name the feature, matched with no case. */
  term: string;
  holds: CodeHold;
}

/**
 * The features that a compare row can deny, each tied to the code (ruling 55
 * of plan 12e). The /compare/ rows of plan 11b denied ten features that plan
 * 12e shipped, and check-facts reads the age of a row, not its truth. A
 * later plan that ships a feature of this list fails check-compare until
 * its row moves. Add a fact here when a cell denies a route, a config key, a
 * command, or a file.
 *
 * The facts after "dynamic registration" came on 2026-11-25. Plans 12d to
 * 12k shipped each of them, and no plan added its fact, so /compare/ denied
 * 25 shipped features while this check passed. The rule for a plan: a row
 * that says "No ..." gets its fact here in the same change as the row.
 */
export const CODE_FACTS: readonly CodeFact[] = [
  { name: "introspection", term: "introspection", holds: { route: "/oauth/introspect" } },
  {
    name: "the device grant",
    term: "device (?:grant|code|flow|authorization)",
    holds: { feature: "oauthDevice" },
  },
  {
    name: "sign-out at the provider",
    term: "sign-out at the provider|RP-initiated|end-session",
    holds: { route: "/oauth/end-session" },
  },
  { name: "DPoP", term: "DPoP", holds: { key: "oauth.dpop" } },
  // A route that takes a client secret holds confidential clients. "Public clients only" denies them.
  {
    name: "confidential clients",
    term: "confidential|public clients?",
    holds: { auth: "clientSecretBasic" },
  },
  {
    name: "dynamic registration",
    term: "dynamic registration",
    holds: { route: "/oauth/register" },
  },
  { name: "SCIM", term: "SCIM|directory provisioning", holds: { feature: "scim" } },
  { name: "SSO", term: "SSO|SAML", holds: { feature: "sso" } },
  {
    name: "the end of sessions by an operator",
    term: "operator ends",
    holds: { route: "/operator/sessions/end-user" },
  },
  { name: "the operator user tools", term: "admin tools", holds: { route: "/operator/users" } },
  {
    name: "passkey-first sign-up",
    term: "passkey-first sign-up",
    holds: { feature: "passkeySignUp" },
  },
  { name: "passkey extensions", term: "extensions", holds: { key: "passkey.extensions" } },
  { name: "related origins", term: "related origins", holds: { feature: "passkeyRelatedOrigins" } },
  { name: "passkey hints", term: "hints", holds: { key: "passkey.hints" } },
  {
    name: "a rate limit for each token",
    term: "limit for each token",
    holds: { key: "tokens.defaultRateLimit" },
  },
  { name: "teams", term: "teams", holds: { feature: "teams" } },
  {
    name: "permission statements",
    term: "permission statements",
    holds: { key: "organizations.statements" },
  },
  { name: "custom roles", term: "custom roles", holds: { key: "organizations.roles" } },
  { name: "access control", term: "access control", holds: { key: "organizations.statements" } },
  { name: "guest sessions", term: "guest sessions?", holds: { feature: "anonymous" } },
  { name: "user name sign-in", term: "user name|username", holds: { feature: "username" } },
  { name: "phone sign-in", term: "phone sign-in", holds: { feature: "phone" } },
  { name: "Google One Tap", term: "One Tap", holds: { feature: "socialIdToken" } },
  {
    name: "several sessions",
    term: "several sessions|account switch",
    holds: { feature: "multiSession" },
  },
  { name: "the last method", term: "last method", holds: { key: "lastMethod" } },
  {
    name: "a redirect override",
    term: "redirect override",
    holds: { key: "social.google.redirectURI" },
  },
  { name: "schema output", term: "schema output", holds: { command: "generate" } },
  {
    name: "a first operator account",
    term: "first operator account",
    holds: { command: "create-admin" },
  },
  { name: "the upgrade command", term: "upgrade command", holds: { command: "upgrade" } },
  { name: "SECURITY.md", term: String.raw`SECURITY\.md`, holds: { file: "SECURITY.md" } },
  // The OTLP sink of @authtempo/observe is one module, and it sends the spans and the metrics.
  {
    name: "spans and metrics",
    term: "spans|metrics",
    holds: { file: "packages/observe/src/otlp.ts" },
  },
];

/** One route of ROUTES, as this check reads it. */
export interface RouteFacts {
  readonly path: string;
  readonly feature: string;
  readonly auth: readonly string[];
}

/** A sentence that denies the feature of its row's topic: "No ...", "Not supported.", or "... only." */
const DENIES_TOPIC = /^(?:no|not supported)\b|\bonly\.?$/i;

/** The code that the facts read: the routes, the config keys, the commands, and the tracked files. */
interface Code {
  routes: readonly RouteFacts[];
  keys: ReadonlySet<string>;
  commands: ReadonlySet<string>;
  files: ReadonlySet<string>;
}

/** The text of where the code holds a fact, or null when the code does not hold it. */
function heldBy(hold: CodeHold, { routes, keys, commands, files }: Code) {
  if ("route" in hold)
    return routes.some((r) => r.path === hold.route) ? `ROUTES has ${hold.route}` : null;
  if ("feature" in hold)
    return routes.some((r) => r.feature === hold.feature)
      ? `ROUTES has the feature ${hold.feature}`
      : null;
  if ("auth" in hold)
    return routes.some((r) => r.auth.includes(hold.auth))
      ? `a route of ROUTES takes ${hold.auth}`
      : null;
  if ("command" in hold)
    return commands.has(hold.command) ? `the CLI has the command ${hold.command}` : null;
  if ("file" in hold) return files.has(hold.file) ? `the repository has ${hold.file}` : null;
  return keys.has(hold.key) ? `the config has the key ${hold.key}` : null;
}

/** True when a sentence of `cell`, or the topic with the cell, denies the words of `term`. */
export function denies(topic: string, cell: string, term: string): boolean {
  const before = new RegExp(
    String.raw`\b(?:no|not|never|without)\s+(?:[\w-]+\s+){0,2}(?:${term})\b`,
    "i",
  );
  const after = new RegExp(String.raw`\b(?:${term})\s+(?:[\w-]+\s+){0,2}only\b`, "i");
  const sentences = cell.split(/(?<=\.)\s+/);
  if (sentences.some((s) => before.test(s) || after.test(s))) return true;
  return (
    new RegExp(String.raw`\b(?:${term})\b`, "i").test(topic) &&
    sentences.some((s) => DENIES_TOPIC.test(s.trim()))
  );
}

/**
 * The authtempo cells of /compare/ against the code (ruling 55 of plan 12e).
 * A cell fails when it denies a fact of CODE_FACTS that ROUTES, the config
 * keys, the commands, or the tracked files hold. A cell denies a fact with "no", "not", "never", or "without" up
 * to two words before its words. The word "only" up to two words after them
 * denies it too. A topic that names the fact is denied by a cell sentence
 * that starts with "No" or "Not supported", or ends with "only". The count
 * `held` is the number of facts that the code holds now. With no list of
 * tracked files, the check fails once with the reason: a file fact that is
 * not read must not pass.
 */
export function checkCompare(input: {
  rows: readonly Pick<CompareRow, "id" | "topic" | "authtempo">[];
  routes: readonly RouteFacts[];
  keys: readonly string[];
  /** The names of COMMANDS of @authtempo/cli. */
  commands: readonly string[];
  /** The files that git tracks, or the error of git ls-files (lib/tracked.ts). */
  tracked: { files: ReadonlySet<string> } | { error: string };
}): CheckReport {
  const code: Code = {
    routes: input.routes,
    keys: new Set(input.keys),
    commands: new Set(input.commands),
    files: "files" in input.tracked ? input.tracked.files : new Set<string>(),
  };
  const r: CheckReport = {
    name: "check-compare",
    counts: { rows: input.rows.length, facts: CODE_FACTS.length, held: 0 },
    failures: [],
  };
  if ("error" in input.tracked)
    r.failures.push(`the file facts are not checked: ${input.tracked.error}`);
  for (const fact of CODE_FACTS) {
    const held = heldBy(fact.holds, code);
    if (held === null) continue;
    r.counts.held = (r.counts.held ?? 0) + 1;
    for (const row of input.rows)
      if (denies(row.topic, row.authtempo, fact.term))
        r.failures.push(`cmp-${row.id} denies ${fact.name}, and ${held}`);
  }
  return requireCounts(r, ["rows", "facts"]);
}
