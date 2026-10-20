import type { CompareRow } from "../src/data/compare.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** Where the code holds a feature: a route path or feature of ROUTES, an auth form of a route, or a config key. */
export type CodeHold = { route: string } | { feature: string } | { auth: string } | { key: string };

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
 * its row moves. Add a fact here when a cell denies a route or a config key.
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
];

/** One route of ROUTES, as this check reads it. */
export interface RouteFacts {
  readonly path: string;
  readonly feature: string;
  readonly auth: readonly string[];
}

/** A sentence that denies the feature of its row's topic: "No ...", "Not supported.", or "... only." */
const DENIES_TOPIC = /^(?:no|not supported)\b|\bonly\.?$/i;

/** The text of where the code holds a fact, or null when the code does not hold it. */
function heldBy(hold: CodeHold, routes: readonly RouteFacts[], keys: ReadonlySet<string>) {
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
 * A cell fails when it denies a fact of CODE_FACTS that ROUTES or the config
 * keys hold. A cell denies a fact with "no", "not", "never", or "without" up
 * to two words before its words. The word "only" up to two words after them
 * denies it too. A topic that names the fact is denied by a cell sentence
 * that starts with "No" or "Not supported", or ends with "only". The count
 * `held` is the number of facts that the code holds now.
 */
export function checkCompare(input: {
  rows: readonly Pick<CompareRow, "id" | "topic" | "authtempo">[];
  routes: readonly RouteFacts[];
  keys: readonly string[];
}): CheckReport {
  const keys = new Set(input.keys);
  const r: CheckReport = {
    name: "check-compare",
    counts: { rows: input.rows.length, facts: CODE_FACTS.length, held: 0 },
    failures: [],
  };
  for (const fact of CODE_FACTS) {
    const held = heldBy(fact.holds, input.routes, keys);
    if (held === null) continue;
    r.counts.held = (r.counts.held ?? 0) + 1;
    for (const row of input.rows)
      if (denies(row.topic, row.authtempo, fact.term))
        r.failures.push(`cmp-${row.id} denies ${fact.name}, and ${held}`);
  }
  return requireCounts(r, ["rows", "facts"]);
}
