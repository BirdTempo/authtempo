import type { MailMessage, ResolvedConfig } from "../config.js";
import { isIpLiteral } from "../limiter/ip-key.js";

/**
 * The credential-change notices (plan 12a, spec 8.15; ASVS 5.0.0 6.3.7).
 * One mail goes after each change of a way in, to the user's address. For a
 * change of address, it goes to the old address. The notice is a message,
 * not a proof: it holds no link and no code. It is on by default, and
 * `account.notices: false` turns it off.
 */

export type NoticeEvent =
  | "password_changed"
  | "password_reset"
  | "email_changed"
  | "factor_enabled"
  | "factor_disabled"
  | "passkey_added"
  | "passkey_removed"
  | "identity_linked"
  | "identity_unlinked"
  | "account_deleted"
  // plan 12i: the username is a way in (spec 32 item 7).
  | "username_changed"
  // plan 12i: the phone is a way in (spec 32 item 5).
  | "phone_changed"
  // plan 12f: a platform operator opened a session on the account, for support.
  | "impersonation_started";

/** What a notice mail builder gets. Core sends the mail to `email`, whatever `to` the builder answers. */
export interface NoticeMailInput {
  event: NoticeEvent;
  /** The user's address. For `email_changed`, the old address. */
  email: string;
  appName: string;
  at: Date;
  ip: string | null;
  userAgent: string | null;
  /** The provider of `identity_linked` and `identity_unlinked`. */
  provider?: string;
  /** The new address of `email_changed`. */
  newEmail?: string;
}

/** The first line of each notice but the impersonation notice, which has its own text. */
const WHAT: Readonly<Record<Exclude<NoticeEvent, "impersonation_started">, string>> = {
  password_changed: "Your password was changed.",
  password_reset: "Your password was reset.",
  email_changed: "The email address of your account was changed.",
  factor_enabled: "A second factor was turned on for your account.",
  factor_disabled: "A second factor was turned off for your account.",
  passkey_added: "A passkey was added to your account.",
  passkey_removed: "A passkey was removed from your account.",
  identity_linked: "A sign-in provider was linked to your account.",
  identity_unlinked: "A sign-in provider was removed from your account.",
  account_deleted: "Your account was deleted.",
  username_changed: "The username of your account was changed.",
  phone_changed: "The phone number of your account was changed.",
};

/** The default notices. `account.notices.mail` replaces them. */
export function defaultNoticeMail(input: NoticeMailInput): MailMessage {
  const subject = `Security notice for your ${input.appName} account`;
  // The text of plan 12f Task 11. The operator acts for the app, so the
  // user asks the app, not a reset. It holds no IP: the operator's address
  // stays with the operator (plan 12f deviation 13).
  if (input.event === "impersonation_started")
    return {
      to: input.email,
      subject,
      text: [
        `An operator of ${input.appName} opened a session on your account at ${input.at.toISOString()}, for support.`,
        `If you did not ask for support, contact ${input.appName}.`,
      ].join("\n"),
    };
  const lines = [WHAT[input.event]];
  if (input.newEmail !== undefined) lines.push(`The new address is ${input.newEmail}.`);
  if (input.provider !== undefined) lines.push(`The provider is ${input.provider}.`);
  lines.push(`Time: ${input.at.toISOString()}.`);
  // Only an IP literal: on a host with no `clientIp` of its own, the caller
  // writes the header, and its text must not reach the owner's notice.
  if (input.ip !== null && isIpLiteral(input.ip)) lines.push(`IP address: ${input.ip}.`);
  // A person who lost the mailbox or the account cannot reset through it.
  // So these two notices name the support path (owner decision 2).
  if (input.event === "email_changed" || input.event === "account_deleted")
    lines.push(`If you did not make this change, contact the support of ${input.appName} at once.`);
  else lines.push("If this was not you, reset your password and end your other sessions.");
  return { to: input.email, subject, text: lines.join("\n") };
}

/**
 * One notice, after the commit of its change, never inside a transaction.
 * A builder or a mail port that throws writes one line with the event and
 * the filtered error name. The flow then answers its success: the change is
 * committed, and a notice must not undo it. The line holds no address and
 * no error message, because app code sets both. A user with no address
 * (plan 12i) gets no notice, and the call writes no line.
 */
export async function sendNotice(
  config: ResolvedConfig,
  input: Omit<NoticeMailInput, "appName" | "at" | "email"> & { email: string | null },
): Promise<void> {
  const notices = config.account.notices;
  const { email } = input;
  if (!notices || email === null) return;
  try {
    const message = notices.mail({
      ...input,
      email,
      appName: config.appName,
      at: config.clock.now(),
    });
    // To the user's address, whatever the builder wrote.
    await config.mail.send({ ...message, to: email });
  } catch (e) {
    config.observe.emit({ name: "notice.mail_failed", event: input.event, errorName: e });
  }
}
