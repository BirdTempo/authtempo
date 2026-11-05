import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// Two sentences of the reference pages state what core does. Each is held to
// the source that does it (rulings 42 d, 49 a, and 58 a of plan 12n). A
// change of the code fails here until the page says the new rule.

/** The text of a file with each run of white space as one space: a line wraps. */
const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");
const ENGINE = `${REPO}packages/core/src/engine/`;
// The changeset of the final proof (plan 12o). The version branch deletes it, so its fact skips there.
const PROOF_FINAL_CHANGESET = `${REPO}.changeset/core-proof-final.md`;
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
  const at = text.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\b`));
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
  });

  // The version branch deletes each changeset. There the summary counts a skip (ruling 70 of plan 12j).
  it.skipIf(!existsSync(PROOF_FINAL_CHANGESET))(
    "holds the two answers of the lost verify link in the changeset of plan 12o (ruling 26)",
    () => {
      expect(flat(PROOF_FINAL_CHANGESET)).toContain(JSON_WORDS);
    },
  );

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
    // A claim throws ClaimLostError at its first statement or at a lost flip (ruling 24 of plan 12p).
    // The flip of claimEmail throws it once. takeClaim throws it at the hold and at a held lease.
    const users = source("users.ts");
    expect(body(users, "claimEmail").match(/new ClaimLostError\(/g)).toEqual([
      "new ClaimLostError(",
    ]);
    expect(body(users, "claimEmail")).toContain("throw new ClaimLostError();");
    const take = body(users, "takeClaim");
    expect(take.match(/new ClaimLostError\(/g)).toHaveLength(2);
    expect(take).toContain("throw new ClaimLostError();");
    expect(take).toContain('throw new ClaimLostError("held");');
    expect(page("concepts/claim-rule.md")).toContain(
      "The first step decides a race of two claims of one user, so a claim that loses there writes nothing. A claim that loses at the mark undoes its deletes.",
    );
  });
});

/** The page and the section that the fact of the session proof holds (plan 12p). */
const PROOF_PAGE = 'concepts/claim-rule.md, the section "The session proof"';
// The changeset of the session proof (plan 12p). The version branch deletes it, so its fact skips there.
const SESSION_PROOF_CHANGESET = `${REPO}.changeset/core-session-proof.md`;

/** The steps of the claim on the page, in the order of claimEmail. */
const ORDER_WORDS = [
  "1. It takes the claim. On Postgres and MySQL, this step holds the user row. On D1 and SQLite, it writes a lease row that lives 60 seconds.",
  "2. It deletes the other identities of the user.",
  "3. It deletes the password row, except the row that a verify link confirms.",
  "4. It deletes the passkeys, the pending passkey challenges, and the pending handoff codes.",
  "5. It marks the address verified.",
  "6. It deletes every session, as its last step.",
];

/** The value of `proved` at the creation of a session (ruling 20 of plan 12p), and the one later change. */
const CREATION_WORDS = [
  "Each session row holds a flag, `proved`. Core sets it once, at the creation of the session:",
  "- It is false for an anonymous user. - For a user with an address, it is the verified flag of that address. - For any other user, it is true, because a user with no address has nothing to claim. - A handoff copies the flag of its browser session, and an impersonation takes the state of its target.",
  "Only the confirm of a change of address changes the flag later, to true on the session that it keeps. A `session.beforeCreate` hook cannot set it.",
];

/** The terms of the user row at the gates (ruling 14 of plan 12p), each read with the session flag. */
const GATE_WORDS = [
  "Each verified-only action reads the flag of the caller's session with the user row.",
  "- An API token, a username, a phone add, a profile change, and a change of address need a verified address. A user with no address needs a phone or a passkey that signs in.",
  "- A passkey registration, TOTP and the passkey method of the second factor, a password change, and an OAuth grant need a verified address. A user with no address needs an account that is not anonymous.",
  "- An organization, a team, an invitation, an organization token, SSO, the operator tools, and the start of a social link need a verified address. The email method of the second factor needs one too.",
  "An in-process call that passes a user and no session keeps the rule of the user row.",
];

/** The session JWT of a claimant (decision 8 of plan 12p): it outlives the claim, and its claim reads the flag. */
const JWT_WORDS =
  "A claimant's session JWT lives to its `exp`, [as every session JWT does](/docs/concepts/threat-model/#what-stays-open), with `email_verified` false and the owner's account as `sub`.";

const CLOSURE_WORDS = [
  "The claimant keeps none of the rows that the claim deletes. The owner holds the account. [The session proof](#the-session-proof) tells why no session of the claimant gains a power from the claim.",
  "- An API token needs a proved session at its creation. A session of a claimant is never proved, so a claimant cannot mint one.",
  "- A passkey needs a proved session at its registration, for the same reason. The claim deletes the passkeys before it marks the address verified.",
  "- An OAuth authorize request and a device approval need a proved session. So a claimant gets no grant that outlives the claim.",
  "So a session that came before the proof of its address never gains verified powers. On D1 and SQLite each statement of a claim lands at once.",
  "On Postgres and MySQL a request can read the session before the claim's commit and the user after it. The flag refuses that request too.",
  "The claim deletes every row that a sign-in trusts before it marks the address verified. A sign-in that reads the user after that mark finds its row gone, and its guard deletes its own session.",
];

/** The engine functions of the five forms that take the session (decision 4 of plan 12p), by file. */
const FIVE = [
  ["createApiToken", "tokens.ts"],
  ["passkeyRegistrationOptions", "passkeys.ts"],
  ["verifyPasskeyRegistration", "passkeys.ts"],
  ["setupTotp", "totp.ts"],
  ["createOrganizationToken", "organization-tokens.ts"],
] as const;

/**
 * The app API form that takes `type`, as `api.<member>.<method>`. Both names
 * come from create-auth.ts. The method is the one whose input is `type`. The
 * member is the one of `AuthApi` that holds the interface of that method.
 */
function appForm(api: string, type: string): string {
  const m = new RegExp(`(\\w+)\\(\\s*input: ${type}\\b`).exec(api);
  if (!m) throw new Error(`no app form takes ${type}`);
  const owner = [...api.slice(0, m.index).matchAll(/\nexport interface (\w+)/g)].at(-1)?.[1];
  if (owner === "AuthApi") return `api.${m[1]}`;
  const member = new RegExp(`\\n\\s+(\\w+)\\??: ${owner};`).exec(api)?.[1];
  if (!member) throw new Error(`no member of AuthApi holds ${owner}`);
  return `api.${member}.${m[1]}`;
}

/** The five app API forms that take the session, each name read from the code. */
function fiveForms(): string[] {
  const api = readFileSync(`${REPO}packages/core/src/create-auth.ts`, "utf8");
  return FIVE.map(([fn, file]) => {
    const text = source(file);
    const type = new RegExp(
      `export (?:async )?function ${fn}\\(\\s*config: ResolvedConfig,\\s*input: (\\w+),`,
    ).exec(text)?.[1];
    if (!type) throw new Error(`${fn} takes no named input type`);
    // The input holds the resolved session, and no bare user or user id.
    const at = text.indexOf(`export interface ${type} {`);
    expect(at, `${fn}: ${type}`).toBeGreaterThan(0);
    const members = text.slice(at, text.indexOf("\n}\n", at));
    expect(members, `${fn}: ${type}`).toContain("\n  session: ResolvedSession;");
    expect(members, `${fn}: ${type}`).not.toMatch(/\n {2}(?:user|userId)\??:/);
    return appForm(api, type);
  });
}

/** A list of names as the pages write it: `a`, `b`, and `c`. */
const listOf = (names: string[]) =>
  `${names
    .slice(0, -1)
    .map((n) => `\`${n}\``)
    .join(", ")}, and \`${names.at(-1)}\``;

// The session proof closes the window of plan 12o (decisions 3 to 5 and
// rulings 14, 16, and 20 of plan 12p). The page states the order of the
// claim, the flag at creation, and the gates' terms. A change of the code
// fails here and names the page.
describe("the session proof of the claim-rule page (plan 12p)", () => {
  it("holds the order of claimEmail: the hold or the lease, the trusted rows, the flip, and the sessions last", () => {
    const claim = body(source("users.ts"), "claimEmail");
    // The first statement is the hold or the lease.
    const first = claim.search(/await (?:tx\.\w+|takeClaim)\(/);
    expect(claim.slice(first), PROOF_PAGE).toMatch(
      /^await takeClaim\(tx, userId, now, verified\.clock\);/,
    );
    const take = body(source("users.ts"), "takeClaim");
    expect(take).toMatch(
      /if \(tx\.isolated\) \{\s+if \(await userStillUnverified\(tx, userId, now\)\) return;/,
    );
    expect(take).toContain('purpose: "claim-lease",');
    // The page says that the lease lives 60 seconds: from the clock at its write (ruling 35 of plan 12p).
    expect(take).toContain("new Date(clock.now().getTime() + CLAIM_LEASE_MS)");
    expect(source("users.ts")).toContain("export const CLAIM_LEASE_MS = 60_000;");
    // Then the trusted rows, the flip, and the sessions, each once and in this order.
    const steps = [
      "await takeClaim(tx, userId, now, verified.clock);",
      'await tx.delete("identity", where);',
      'await tx.delete("password", passwords);',
      'await tx.delete("passkey", [{ field: "userId", op: "eq", value: userId }]);',
      '{ field: "purpose", op: "eq", value: "passkey-challenge" },',
      '{ field: "purpose", op: "eq", value: "handoff-code" },',
      "? { emailVerified: true, phone: null, updatedAt: now }",
      "await endSessions(",
    ];
    const at = steps.map((step) => {
      expect(claim.split(step), `${PROOF_PAGE}: claimEmail holds ${step} once`).toHaveLength(2);
      return claim.indexOf(step);
    });
    expect(at, PROOF_PAGE).toEqual([...at].sort((a, b) => a - b));
    const text = page("concepts/claim-rule.md");
    const where = ORDER_WORDS.map((words) => {
      expect(text, PROOF_PAGE).toContain(words);
      return text.indexOf(words);
    });
    expect(where, PROOF_PAGE).toEqual([...where].sort((a, b) => a - b));
    // The SQLite adapter runs the D1 code, so each statement lands at once there too.
    expect(readFileSync(`${REPO}packages/adapter-sqlite/src/adapter.ts`, "utf8")).toContain(
      "return createD1AdapterOn(driver.db, {",
    );
    for (const words of CLOSURE_WORDS) expect(text, PROOF_PAGE).toContain(words);
  });

  it("holds the flag at creation and the proved read of address.ts at each verified-only helper", () => {
    const open = body(source("sessions.ts"), "provedAtOpen");
    expect(open).toContain("if (input.carriedProved !== undefined) return input.carriedProved;");
    expect(open).toContain("if (input.user.isAnonymous) return false;");
    expect(open).toContain("return hasAddress(input.user) ? input.user.emailVerified : true;");
    const address = source("address.ts");
    expect(body(address, "sessionProved")).toContain(
      "return caller.session == null || caller.session.proved;",
    );
    for (const helper of ["handleProved", "provedAccount", "provedAddress"])
      expect(body(address, helper), `${PROOF_PAGE}: ${helper}`).toContain("sessionProved(caller)");
    expect(body(address, "handleProved")).toContain(
      "return hasAddress(user) ? user.emailVerified : verifiedHandle(config, storage, user);",
    );
    expect(body(address, "provedAccount")).toContain(
      "return hasAddress(user) ? user.emailVerified : !user.isAnonymous;",
    );
    expect(body(address, "provedAddress")).toContain(
      "return sessionProved(caller) && caller.user.emailVerified;",
    );
    // A handle that signs in: a phone of the config, or a passkey of the user.
    expect(body(address, "verifiedHandle")).toContain(
      "if (phoneSignsIn(config, user)) return true;",
    );
    const text = page("concepts/claim-rule.md");
    for (const words of [...CREATION_WORDS, ...GATE_WORDS])
      expect(text, PROOF_PAGE).toContain(words);
    // The session JWT reads the flag, so a claimant's JWT says false. The threat model names its life.
    expect(source("jwt.ts")).toContain(
      "{ email: user.email, email_verified: session.proved && user.emailVerified }",
    );
    expect(page("concepts/threat-model.md")).toContain(
      "A session JWT and an OAuth access token live to their `exp`. A sign-out does not end them.",
    );
    expect(text, PROOF_PAGE).toContain(JWT_WORDS);
  });

  it("names the five forms that take the session, each name read from the code", () => {
    const forms = fiveForms();
    expect(page("concepts/claim-rule.md"), PROOF_PAGE).toContain(
      `${listOf(forms)} take the session for this reason.`,
    );
  });

  // The version branch deletes each changeset. There the summary counts a skip (ruling 70 of plan 12j).
  it.skipIf(!existsSync(SESSION_PROOF_CHANGESET))(
    "names the five forms in the Breaking line of the changeset, and what to pass",
    () => {
      const forms = fiveForms();
      expect(flat(SESSION_PROOF_CHANGESET)).toContain(
        `Breaking: ${listOf(forms)} take \`session\` in place of \`user\` or \`userId\`. Pass the answer of \`api.getSession\` or \`auth.session\`.`,
      );
    },
  );
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

// The undo guard of a claim (decision 6 of plan 12q). D1 can apply the mark
// of the address and lose its answer, so the undo of the claim's deletes
// must not put back the claimant's rows. The claim calls the guard right
// after its lease, and the pages say so. A change of the call fails here.
describe("the undo guard of a claim on the claim-rule, races, and storage-port pages (plan 12q)", () => {
  it("holds the call after the lease and before the deletes, the wider condition at a lost flip, and the words", () => {
    const claim = body(source("users.ts"), "claimEmail");
    const steps = [
      "await takeClaim(tx, userId, now, verified.clock);",
      'await tx.undoOnlyWhile?.("user", [byId, { field: "emailVerified", op: "eq", value: false }]);',
      'await tx.delete("identity", where);',
      'await tx.undoOnlyWhile?.("user", [byId]);',
      "throw new ClaimLostError();",
    ];
    const at = steps.map((step) => {
      expect(claim.split(step), `claimEmail holds ${step} once`).toHaveLength(2);
      return claim.indexOf(step);
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(flat(`${STORAGE}port.ts`)).toContain(
      "undoOnlyWhile?<M extends ModelName>(model: M, where: Where<M>[]): Promise<void>;",
    );
    expect(page("concepts/claim-rule.md")).toContain(
      "The undo of each delete of a claim puts the row back only while the user is unverified. When the mark stays, no row of the claimant comes back.",
    );
    expect(page("concepts/races.md")).toContain(
      "A claim calls `undoOnlyWhile` after its lease, so the undo puts a deleted row back only while the user is unverified.",
    );
    expect(page("concepts/storage-port.md")).toContain(
      "| `undoOnlyWhile` | Inside a transaction, the undo of each later delete puts its rows back only while a row of the model matches the where.",
    );
  });
});
