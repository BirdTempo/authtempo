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

/** The two answers of a lost verify link (L2 of the Task 3 fix review of plan 12o). */
const JSON_WORDS =
  "A JSON caller gets the 409 with a `detail` that says to sign in. The form post of the mail link gets a redirect to the app with `auth_error=conflict`.";

const CONFLICT_WORDS =
  "**Meaning on D1:** A store with a query limit per invocation, such as D1, runs a [claim](/docs/concepts/claim-rule/) once. When another proof verifies the user first, the flow answers 409 with no claim write. The magic link and the email code spent their proof before the claim. So the flow mails a new one of its kind. That mail counts on the mail limit of its kind for the address. A failure of that mail leaves the 409 and emits the event `claim.mail_failed`. The verify link mails nothing, because the address is now verified. A JSON caller gets the 409 with a `detail` that says to sign in. The form post of the mail link gets a redirect to the app with `auth_error=conflict`. A social sign-in needs a new sign-in at the provider. The password reset and the invitation confirm keep their link, so the same request can work again.";

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

  it("names each step of the new proof that emits claim.mail_failed in the observability row (ruling 26 of plan 12o)", () => {
    // The try block of each fallback holds the limit calls and the mail step.
    // The mail step calls the storage, the app's builder, and the mail port.
    const local = (text: string, name: string) => {
      const at = text.indexOf(`\nasync function ${name}(`);
      if (at < 0) throw new Error(`no function ${name}`);
      return text.slice(at, text.indexOf("\n}\n", at));
    };
    const magic = local(source("magic-link.ts"), "mailMagicLink");
    expect(magic).toContain('await config.storage.create("verification", {');
    expect(magic).toContain("const link = config.magicLink.linkBuilder(token, next);");
    expect(magic).toContain("await config.mail.send({");
    const code = local(source("email-otp.ts"), "mailCode");
    expect(code).toContain("const code = await issueCode(config, otp, purpose, email, data);");
    expect(code).toContain('const build = purpose === "email-otp" ? otp.mail : otp.resetMail;');
    expect(code).toContain("await config.mail.send({ ...message, to: email });");
    for (const [file, call] of [
      ["magic-link.ts", "await mailMagicLink(config, email, next, {});"],
      ["email-otp.ts", 'await mailCode(config, otp, "email-otp", email, {});'],
    ] as const) {
      const text = source(file);
      const fallback = text.slice(text.indexOf("async function resendProofAfterLostClaim("));
      const steps = fallback.slice(fallback.indexOf("try {"), fallback.indexOf("} catch (e) {"));
      expect(steps).toContain("if (!(await limit(config, ");
      expect(steps).toContain(call);
    }
    const row = readFileSync(`${DOCS}docs/operations/observability.mdx`, "utf8")
      .split("\n")
      .find((l) => l.startsWith("| `authtempo: claim mail failed` |"));
    expect(row).toContain(
      "A step of the new proof of a lost claim threw. The step is the limiter, a storage call of the new link or code, the app's link or mail builder, or the mail port.",
    );
  });

  it("holds the two answers of the lost verify link: the 409 with the detail to a JSON caller, the redirect with the code to the form (ruling 26 of plan 12o)", () => {
    const http = (file: string) => readFileSync(`${REPO}packages/core/src/http/${file}`, "utf8");
    // The mail link opens a page with a plain form, and a form post is no JSON caller.
    expect(body(http("password-pages.ts"), "defaultPasswordVerifyPage")).toMatch(
      /<form method="post" action="\$\{escapeHtml\(input\.action\)\}">/,
    );
    expect(body(http("body.ts"), "isJsonRequest")).toContain('return type === "application/json";');
    // The route answers a JSON caller with the result, and the form with the failure redirect.
    const routes = http("routes/password.ts");
    const verify = routes.slice(routes.indexOf('key: "POST /password/verify",'));
    expect(verify).toMatch(
      /^key: "POST \/password\/verify",[\s\S]*?const jsonCaller = isJsonRequest\(ctx\.request\);[\s\S]*?if \(!r\.ok\) return jsonCaller \? respond\(r\) : failed\(ctx, r\.code\);/,
    );
    expect(routes).toContain(
      "const failed = (ctx: RouteContext, code: string) => authErrorRedirect(ctx.config, code);",
    );
    // `respond` writes the detail. The failure redirect goes to the app with the code and no body.
    expect(body(http("json.ts"), "respond")).toContain(
      "if (result.detail !== undefined) body.detail = result.detail;",
    );
    const redirects = http("redirect.ts");
    expect(redirects).toContain('export const AUTH_ERROR_PARAM = "auth_error";');
    expect(body(redirects, "authErrorRedirect")).toMatch(
      /const res = redirect\(`\$\{config\.appURL\}\/\?\$\{AUTH_ERROR_PARAM\}=\$\{code\}`\);/,
    );
    expect(body(redirects, "redirect")).toContain("return new Response(null, {");
    for (const words of [errorSection("conflict"), page("concepts/claim-rule.md")])
      expect(words).toContain(JSON_WORDS);
    expect(flat(`${REPO}.changeset/core-proof-final.md`)).toContain(JSON_WORDS);
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
  "The claim is final once its last write is done. When the sign-in fails after that point, the address stays verified, and the rows that the claim deleted stay deleted. The flow answers an error and opens no session. On Postgres and MySQL such a failure undoes the whole claim.",
  "Two proofs of one address can arrive at the same time. One claims the user. On D1 the other answers 409 [`conflict`](/docs/reference/errors/#conflict). The flow of a magic link or an email code then mails a new proof of its kind to the address. The verify link mails nothing, because the address is now verified. A JSON caller gets the 409 with a `detail` that says to sign in. The form post of the mail link gets a redirect to the app with `auth_error=conflict`.",
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

/** The page and the section that the fact of the window holds (ruling 29 of plan 12o). */
const WINDOW_PAGE = 'concepts/claim-rule.md, the section "The window"';

const WINDOW_WORDS = [
  "The claimant keeps none of the rows that the claim deletes. The owner holds the account. [The window](#the-window) tells what a claimant can still get.",
  "- An API token needs a verified address at its creation. Outside [the window](#the-window), a claimant cannot mint one.",
  "- A passkey needs a verified address at its registration. The claim deletes the passkeys after it ends the sessions.",
  "- An OAuth authorize request refuses an unverified user. A grant that a claimant gets in [the window](#the-window) can outlive the claim.",
  "## The window The claim marks the address verified in its first write. It ends the sessions in a later write. On D1 and the SQLite adapter, each write lands at once.",
  "A request of a claimant's session that reaches the engine between those writes acts as a verified user. It can mint an API token, start a change of address, or authorize an OAuth client. The claim deletes none of those rows, so they stay after it. Of the proofs, only a password reset deletes the OAuth codes and refresh tokens of the user, in a step after its claim. The confirm of the change of address by link needs no session, so the claimant can still confirm it after the claim. The account then has the claimant's address.",
  "This is an open gap of the engine, and the next planned change closes it.",
];

// The claim flips the flag first and ends the sessions later (rr-final M1 of
// plan 12o). It deletes no API token, no change of address, and no OAuth row.
// A change that closes the window fails here and names the page.
describe("the window of the claim-rule page (ruling 29 of plan 12o)", () => {
  it("holds the window to claimEmail: the flip is its first write, before endSessions, and it deletes no API token, no change of address, and no OAuth row", () => {
    const claim = body(source("users.ts"), "claimEmail");
    // The first write of the claim is the flip of the flag, and the session end comes later.
    const first = claim.search(/await tx\.(?:create|update|delete|deleteRows)\(/);
    expect(claim.slice(first), WINDOW_PAGE).toMatch(
      /^await tx\.update\(\s*"user",[\s\S]*?\? \{ emailVerified: true,/,
    );
    expect(claim.indexOf("emailVerified: true"), WINDOW_PAGE).toBeGreaterThan(0);
    expect(claim.indexOf("await endSessions("), WINDOW_PAGE).toBeGreaterThan(
      claim.indexOf("emailVerified: true"),
    );
    // The names come from the code that writes each row.
    const tokens = body(source("tokens.ts"), "createApiToken");
    const tokenModel = /await tx\.create\("(\w+)", row\);/.exec(tokens)?.[1];
    const change = source("email-change.ts");
    const changePurposes =
      /const CHANGE_PURPOSES: readonly VerificationPurpose\[\] = \[([^\]]+)\];/
        .exec(change)?.[1]
        ?.match(/"[\w-]+"/g) ?? [];
    const grants = source("oauth-grants.ts");
    const codePurpose = /\{ field: "purpose", op: "eq", value: ("[\w-]+") \}/.exec(
      body(grants, "deleteOAuthCodes"),
    )?.[1];
    const consentModel = /config\.storage\.create\("(\w+)", \{/.exec(
      body(source("oauth-authorize.ts"), "grantConsent"),
    )?.[1];
    expect([
      typeof tokenModel,
      changePurposes.length,
      typeof codePurpose,
      typeof consentModel,
    ]).toEqual(["string", 2, "string", "string"]);
    expect(body(grants, "deleteOAuthTokens")).toContain("await deleteOAuthCodes(tx, userId);");
    for (const name of [
      `"${tokenModel}"`,
      ...changePurposes,
      "CHANGE_PURPOSES",
      `${codePurpose}`,
      `"${consentModel}"`,
      "deleteOAuthTokens(",
      "deleteOAuthCodes(",
    ])
      expect(claim, `${WINDOW_PAGE}: claimEmail names ${name}`).not.toContain(name);
    // Each of the three writes acts on the user of the request's session, with no guard on its session row.
    expect(tokens).toContain("if (!(await handleProved(config, config.storage, user)))");
    expect(tokens, WINDOW_PAGE).not.toContain('"session"');
    const request = body(change, "requestEmailChange");
    expect(request).toContain("hasAddress(user) ? !user.emailVerified");
    expect(request, WINDOW_PAGE).not.toContain('"session"');
    expect(body(source("oauth-authorize.ts"), "decideAuthorize")).toContain(
      "!provedAccount(input.session.user)",
    );
    // The code exchange and the confirm by link need no session.
    expect(body(source("oauth-token.ts"), "exchangeCode"), WINDOW_PAGE).not.toContain('"session"');
    expect(change, WINDOW_PAGE).toMatch(
      /export async function confirmEmailChange\(\s*config: ResolvedConfig,\s*input: \{ token: string; ip: string \| null; userAgent: string \| null \},/,
    );
    // The reset deletes the OAuth rows after its claim. No other proof deletes them.
    const reset = source("password.ts");
    const claimed = reset.indexOf(
      "await claimEmail(tx, user.id, { passwordId }, now, verify, ended.claim);",
    );
    expect(claimed).toBeGreaterThan(0);
    expect(
      reset.indexOf("await deleteOAuthTokens(tx, user.id, families);", claimed),
    ).toBeGreaterThan(claimed);
    // The verify link of password.ts claims too: the one call of the file is the reset's.
    expect(reset.match(/deleteOAuthTokens\(/g), WINDOW_PAGE).toHaveLength(1);
    for (const file of [
      "magic-link.ts",
      "email-otp.ts",
      "social.ts",
      "user-invite.ts",
      "scim/users.ts",
      "users.ts",
    ])
      expect(source(file), `${WINDOW_PAGE}: ${file}`).not.toMatch(/deleteOAuth(?:Tokens|Codes)\(/);
    // The SQLite adapter runs the D1 code, so each write lands at once there too.
    expect(readFileSync(`${REPO}packages/adapter-sqlite/src/adapter.ts`, "utf8")).toContain(
      "return createD1AdapterOn(driver.db, {",
    );
    for (const words of WINDOW_WORDS)
      expect(page("concepts/claim-rule.md"), WINDOW_PAGE).toContain(words);
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

  it("counts the required methods of StorageAdapter on each page that counts them (ruling 25 of plan 12o)", () => {
    // A member with no `?` is required: an adapter must write it.
    const port = readFileSync(`${STORAGE}port.ts`, "utf8");
    const at = port.indexOf("export interface StorageAdapter {");
    expect(at).toBeGreaterThan(0);
    const block = port.slice(at, port.indexOf("\n}\n", at));
    const methods = [...block.matchAll(/^ {2}([a-zA-Z]+)[<(]/gm)].map((m) => m[1] ?? "");
    const word = [
      "",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
    ][methods.length];
    if (word === undefined) throw new Error(`no word for ${methods.length} methods`);
    const Word = `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    expect(methods).toContain("deleteRows");
    expect(methods).toContain("keep");
    const listed = methods.map((m) => `\`${m}\``);
    const sentence = `${listed.slice(0, -1).join(", ")}, and ${listed.at(-1)}`;
    expect(page("concepts/storage-port.md")).toContain(
      `description: The ${word} storage methods that core calls,`,
    );
    for (const m of listed) expect(page("concepts/storage-port.md")).toContain(`| ${m} |`);
    expect(page("concepts/architecture.md")).toContain(
      `| The storage port | \`@authtempo/core\` | ${Word} storage methods on model and field names. |`,
    );
    expect(page("reference/glossary.md")).toContain(
      `| storage port | The ${word} storage methods that core calls. | |`,
    );
    expect(page("guides/adapter.mdx")).toContain(
      `**What it does:** you write the ${word} methods of the storage port,`,
    );
    expect(page("guides/adapter.mdx")).toContain(
      `1. Write an object with ${sentence}, of the type \`StorageAdapter\`.`,
    );
    expect(flat(`${REPO}packages/core/README.md`)).toContain(
      `${Word} methods: ${listed.join(", ")}.`,
    );
  });
});
