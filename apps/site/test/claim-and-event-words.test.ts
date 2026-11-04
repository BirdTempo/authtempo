import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// Two sentences of the reference pages state what core does. Each is held to
// the source that does it (rulings 42 d, 49 a, and 58 a of plan 12n). A
// change of the code fails here until the page says the new rule.

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
  "**Meaning on D1:** A store with a query limit per invocation, such as D1, runs a [claim](/docs/concepts/claim-rule/) once. When another proof verifies the user first, the flow answers 409 with no claim write. The magic link and the email code spent their proof before the claim. So the flow mails a new one of its kind. That mail counts on the mail limit of its kind for the address. A failure of that mail leaves the 409 and emits the event `claim.mail_failed`. The verify link mails nothing, because the address is now verified. Its answer has a `detail` that says to sign in. A social sign-in needs a new sign-in at the provider. The password reset and the invitation confirm keep their link, so the same request can work again.";

describe("the conflict entry of the errors page (ruling 42 d of plan 12n, decision 11 of plan 12o)", () => {
  it("names the claim race on a store with a query limit, as claimRetry answers it", () => {
    // On such a store a lost claim answers conflict, with no retry in the invocation.
    expect(body(source("users.ts"), "claimRetry")).toContain(
      'if (storage.queryLimitPerInvocation === true) return "conflict";',
    );
    expect(errorSection("conflict")).toContain(CONFLICT_WORDS);
  });

  it("holds the new mail of the magic link and the email code, each under the limit of its kind, and the detail of the verify link", () => {
    // The verify link mails nothing after a lost flip. Its 409 carries the sentence (ruling 23 of plan 12o).
    const password = source("password.ts");
    expect(password).not.toContain("resendProofAfterLostClaim");
    expect(password).toContain(
      'export const CONFIRM_LOST_DETAIL = "Another proof verified this address first. Sign in.";',
    );
    expect(password).toContain("detail: CONFIRM_LOST_DETAIL,");
    // The magic link and the email code send on the conflict of a lost flip, and only then.
    expect(source("magic-link.ts")).toContain(
      "if (verified.lostFlip()) await resendProofAfterLostClaim(config, row.identifier, next);",
    );
    expect(source("magic-link.ts")).toContain(
      'if (!(await limit(config, "magic-link:email", email, PER_EMAIL))) return;',
    );
    expect(source("email-otp.ts")).toContain(
      "if (verified.lostFlip()) await resendProofAfterLostClaim(config, consumed.value.identifier);",
    );
    expect(source("email-otp.ts")).toContain(
      'if (!(await limit(config, "otp:email", email, REQUEST_PER_EMAIL))) return;',
    );
    // A throw of the mail port emits the event, and the answer stays 409.
    expect(source("magic-link.ts")).toContain(
      'config.observe.emit({ name: "claim.mail_failed", method: "magic_link", errorName: e });',
    );
    expect(source("email-otp.ts")).toContain(
      'config.observe.emit({ name: "claim.mail_failed", method: "email_otp", errorName: e });',
    );
    // Social, the ID token, and SSO send none: their proof is the provider's.
    expect(source("social.ts")).not.toContain("resendProofAfterLostClaim");
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
  "`userId` is the user of the session row that the request's token names, read in full or by a peek. The handler's session read sets it, and so does a refusal step of the router. So a refusal of a router step names the account of the token, a banned one too. A refusal of the handler's full read sets no `userId`, as for a banned user's row. A request with no session has no `userId`.";

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

  it("sets no userId for a refusal of the handler's full read (ruling 58 of plan 12n)", () => {
    // The full read answers null for a banned user's row, and only a resolved session marks the request.
    const sessions = source("sessions.ts");
    expect(body(sessions, "resolveSession")).toContain("if (bannedFor(user, session.createdAt)) {");
    expect(body(sessions, "sessionFromRequest")).toContain(
      "if (resolved) markRequestUser(request, resolved.user.id);",
    );
  });
});

/** The text of a docs page with each run of white space as one space. */
const page = (path: string) => flat(`${DOCS}docs/${path}`);
const STORAGE = `${REPO}packages/core/src/storage/`;

const HOOK_WORDS = [
  "A claim is final once its last write is done. When the flow fails after that point, the claim stays. Before its error answer, the flow runs `user.afterVerify`, `session.afterEnd` with reason `claim`, and `operator.afterAction` for each stop row. On Postgres and MySQL such a failure undoes the whole claim, so no after point runs.",
  "A sign-out of a claimant session during a claim fires `session.afterEnd` once, with `sign_out`. The claim fires no second `afterEnd` for that session, and goes on.",
];

const CLAIM_RULE_WORDS = [
  "The claim is final once its last write is done. When the sign-in fails after that point, the address stays verified, and the claimant still holds nothing. The flow answers an error and opens no session. On Postgres and MySQL such a failure undoes the whole claim.",
  "Two proofs of one address can arrive at the same time. One claims the user. On D1 the other answers 409 [`conflict`](/docs/reference/errors/#conflict). The flow of a magic link or an email code then mails a new proof of its kind to the address. The verify link mails nothing, because the address is now verified. Its answer says to sign in.",
];

describe("the final claim of the hooks guide and the claim-rule page (decisions 8 and 10 of plan 12o)", () => {
  it("states the after points of a kept claim on an error answer, as keptClaimEnded fires them", () => {
    const steps = source("create-steps.ts");
    const kept = body(steps, "keptClaimEnded");
    expect(kept).toContain("await verified.after(user);");
    expect(kept).toContain(
      'await sessionsEnded(config, ended, "claim", verified.stops, verified.endedCount());',
    );
    // A store that undoes the whole transaction keeps nothing, so no after point runs.
    expect(steps).toContain("if (await tx.keep()) kept = user;");
    expect(readFileSync(`${REPO}packages/adapter-postgres/src/adapter.ts`, "utf8")).toContain(
      "return !ctx.inTransaction;",
    );
    expect(readFileSync(`${REPO}packages/adapter-mysql/src/adapter.ts`, "utf8")).toContain(
      "return ctx.conn === null;",
    );
    for (const words of HOOK_WORDS) expect(page("guides/hooks.mdx")).toContain(words);
    for (const words of CLAIM_RULE_WORDS) expect(page("concepts/claim-rule.md")).toContain(words);
  });

  it("states the exact session end of a claim, as endSessions ends each chunk by deleteRows", () => {
    const end = body(source("sessions.ts"), "endSessions");
    expect(end).toContain('await tx.deleteRows("session", [...where, ids])');
    expect(end).not.toContain("raced");
    // A claim throws ClaimLostError at a lost flip only.
    expect(body(source("users.ts"), "claimEmail").match(/new ClaimLostError\(\)/g)).toHaveLength(1);
  });
});

const PORT_ROWS = [
  "| `deleteRows` | Deletes every row that matches, and answers the rows that it removed. A row that another caller removed first is not in the answer. D1, SQLite, and Postgres run one `DELETE … RETURNING`. MySQL reads the ids, reads the rows under their locks by id, and deletes them by id, in one transaction. |",
  "| `keep` | Inside a transaction, makes the writes so far final: a later throw undoes only the writes after it. D1, SQLite, and memory drop their undo entries so far, and answer true. Postgres and MySQL do nothing and answer false: they isolate the open transaction, so a throw still undoes all of it. |",
];

describe("the two port calls of the storage-port page (decisions 7 and 9 of plan 12o)", () => {
  it("lists deleteRows and keep as the port declares them, and the suite that holds them", () => {
    const port = flat(`${STORAGE}port.ts`);
    expect(port).toContain(
      "deleteRows<M extends ModelName>(model: M, where: Where<M>[]): Promise<Models[M][]>;",
    );
    expect(port).toContain("keep(): Promise<boolean>;");
    const suite = readFileSync(`${STORAGE}conformance.ts`, "utf8");
    expect(suite).toContain("deleteRowsStatements?: number;");
    expect(suite).toContain("keep makes the writes so far final");
    expect(readFileSync(`${REPO}packages/adapter-mysql/test/suites.ts`, "utf8")).toContain(
      "deleteRowsStatements: 3,",
    );
    for (const row of PORT_ROWS) expect(page("concepts/storage-port.md")).toContain(row);
  });
});
