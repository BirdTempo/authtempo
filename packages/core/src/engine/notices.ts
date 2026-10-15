import type { MailMessage, ResolvedConfig } from "../config.js";
import { isIpLiteral } from "../limiter/ip-key.js";
import { appErrorName } from "../primitives/app-error.js";

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
  | "account_deleted";

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

const WHAT: Readonly<Record<NoticeEvent, string>> = {
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
};

/** The default notices. `account.notices.mail` replaces them. */
export function defaultNoticeMail(input: NoticeMailInput): MailMessage {
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
  return {
    to: input.email,
    subject: `Security notice for your ${input.appName} account`,
    text: lines.join("\n"),
  };
}

/**
 * One notice, after the commit of its change, never inside a transaction.
 * A builder or a mail port that throws writes one line with the event and
 * the filtered error name. The flow then answers its success: the change is
 * committed, and a notice must not undo it. The line holds no address and
 * no error message, because app code sets both.
 */
export async function sendNotice(
  config: ResolvedConfig,
  input: Omit<NoticeMailInput, "appName" | "at">,
): Promise<void> {
  const notices = config.account.notices;
  if (!notices) return;
  try {
    const message = notices.mail({ ...input, appName: config.appName, at: config.clock.now() });
    // To the user's address, whatever the builder wrote.
    await config.mail.send({ ...message, to: input.email });
  } catch (e) {
    console.error("authtempo: notice mail failed", input.event, appErrorName(e));
  }
}
