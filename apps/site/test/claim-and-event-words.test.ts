import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// Two sentences of the reference pages state what core does. Each is held to
// the source that does it (rulings 42 d and 49 a of plan 12n). A change of
// the code fails here until the page says the new rule.

/** The text of a file with each run of white space as one space: a line wraps. */
const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");
const ENGINE = `${REPO}packages/core/src/engine/`;
const source = (file: string) => readFileSync(`${ENGINE}${file}`, "utf8");

/** The text of the errors page from the heading of `code` to the next heading. */
function errorSection(code: string): string {
  const text = flat(`${DOCS}docs/reference/errors.md`);
  const at = text.indexOf(`<h3 id="${code}">`);
  if (at < 0) throw new Error(`no entry ${code} on the errors page`);
  const end = text.indexOf("<h3 ", at + 1);
  return text.slice(at, end < 0 ? undefined : end);
}

/** The body of the function `name` of `text`, from its head to the next top-level function. */
function body(text: string, name: string): string {
  const at = text.search(new RegExp(`\\nexport (?:async )?function ${name}\\b`));
  if (at < 0) throw new Error(`no function ${name}`);
  const end = text.indexOf("\n}\n", at);
  return text.slice(at, end < 0 ? undefined : end);
}

const CONFLICT_WORDS =
  "**Meaning on D1:** A store with a query limit per invocation, such as D1, runs a [claim](/docs/concepts/claim-rule/) once. When a parallel request ends a claimant session or verifies the user first, the flow answers 409 with no claim write. A flow that spent its link, code, or provider token before the claim needs a new one. The password reset and the invitation confirm keep their link, so the same request can work again.";

describe("the conflict entry of the errors page (ruling 42 d of plan 12n)", () => {
  it("names the claim race on a store with a query limit, as claimRetry answers it", () => {
    // On such a store a lost claim answers conflict, with no retry in the invocation.
    expect(body(source("users.ts"), "claimRetry")).toContain(
      'if (storage.queryLimitPerInvocation === true) return "conflict";',
    );
    expect(errorSection("conflict")).toContain(CONFLICT_WORDS);
  });

  it("holds the spent link of the magic link, and the kept link of the reset and the invitation confirm", () => {
    // The magic link spends its row before the claim, outside the claim's transaction.
    const magic = source("magic-link.ts");
    const spent = magic.indexOf("await consumeVerification(config.storage, {");
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(magic.indexOf("await findOrCreateUserByEmail("));
    // The reset and the invitation confirm spend theirs in the claim's transaction, so the undo keeps it.
    expect(source("password.ts")).toContain(
      '(tx) => consumeVerification(tx, { purpose: "password-reset", valueHash, now })',
    );
    expect(source("user-invite.ts")).toContain("const consumed = await consumeVerification(tx, {");
  });
});

const EVENT_WORDS =
  "`userId` is the user of the session row that the request's token names, read in full or by a peek. The handler's session read sets it, and so does a refusal step of the router. So a refusal names the account of the token, a banned one too. A request with no session has no `userId`.";

describe("the userId of the request event (ruling 49 a of plan 12n)", () => {
  it("names the user of the token's row, read by a peek that checks no ban", () => {
    // The impersonation step marks the row of its peek.
    const rules = flat(`${REPO}packages/core/src/http/impersonation-rules.ts`);
    const peek = rules.indexOf("const row = await peekRequestSession(config, request);");
    expect(peek).toBeGreaterThan(0);
    expect(rules.indexOf("markRequestUser(request, row.userId);")).toBeGreaterThan(peek);
    // The peek checks that the row is live, and reads no ban of the user.
    const peekSession = body(source("sessions.ts"), "peekSession");
    expect(peekSession).toContain("sessionIsLive(config, row, config.clock.now())");
    expect(peekSession).not.toContain("bannedFor");
    const row = readFileSync(`${DOCS}docs/reference/events.md`, "utf8")
      .split("\n")
      .find((l) => l.startsWith("| `request` |"));
    expect(row).toContain(EVENT_WORDS);
  });
});
