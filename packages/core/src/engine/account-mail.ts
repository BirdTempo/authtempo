import type { MailMessage, ResolvedConfig } from "../config.js";
import { minutesText } from "./email-otp-mail.js";

/**
 * What the proof mail builder of a settings page gets (plan 12a). Core sends
 * each mail to `email`, whatever `to` the builder answers.
 */
export type AccountMailInput =
  | { kind: "reauth_code"; email: string; code: string; ttlMinutes: number; appName: string }
  | { kind: "email_change_link"; email: string; link: string; ttlMinutes: number; appName: string }
  | { kind: "email_change_code"; email: string; code: string; ttlMinutes: number; appName: string }
  | { kind: "email_change_taken"; email: string; appName: string }
  | { kind: "delete_confirm"; email: string; link: string; ttlMinutes: number; appName: string }
  /** The invitation of a user that an operator created (plan 12f2 Task 3). */
  | { kind: "user_invite"; email: string; link: string; ttlHours: number; appName: string };

/** A proof mail to its own address, whatever `to` the builder answers. */
export async function sendAccountMail(
  config: ResolvedConfig,
  input: AccountMailInput,
): Promise<void> {
  const message = config.account.mail(input);
  await config.mail.send({ ...message, to: input.email });
}

/** The default proof mails. `account.mail` replaces them. */
export function defaultAccountMail(input: AccountMailInput): MailMessage {
  switch (input.kind) {
    case "reauth_code":
      return {
        to: input.email,
        subject: `Your confirmation code for ${input.appName}`,
        text: `Your code is ${input.code}. It is valid for ${minutesText(input.ttlMinutes)}. Enter it to confirm that it is you. If you did not ask for it, change your password.`,
      };
    case "email_change_link":
      return {
        to: input.email,
        subject: `Confirm your new email address for ${input.appName}`,
        text: `Open this link to use this address for your ${input.appName} account. It is valid for ${minutesText(input.ttlMinutes)}.\n\n${input.link}\n\nIf you did not ask for it, ignore this message.`,
      };
    case "email_change_code":
      return {
        to: input.email,
        subject: `Confirm your new email address for ${input.appName}`,
        text: `Your code is ${input.code}. It is valid for ${minutesText(input.ttlMinutes)}. Enter it to use this address for your ${input.appName} account. If you did not ask for it, ignore this message.`,
      };
    case "email_change_taken":
      return {
        to: input.email,
        subject: `An account uses this address on ${input.appName}`,
        text: `Someone asked to move an account of ${input.appName} to this address. An account already uses this address, so nothing changed. To use that account, sign in to it. If you did not ask for it, ignore this message.`,
      };
    case "delete_confirm":
      return {
        to: input.email,
        subject: `Confirm the delete of your ${input.appName} account`,
        text: `Open this link to delete your ${input.appName} account. You must be signed in on that device. It is valid for ${minutesText(input.ttlMinutes)}.\n\n${input.link}\n\nThe delete cannot be undone. If you did not ask for it, ignore this message and change your password.`,
      };
    // Core passes no operator name and no IP: the mail names the app only (plan 12f2).
    case "user_invite":
      return {
        to: input.email,
        subject: `You have an account on ${input.appName}`,
        text: `An account on ${input.appName} was made for this address. Open this link to sign in. It is valid for ${input.ttlHours === 1 ? "1 hour" : `${input.ttlHours} hours`} and works once.\n\n${input.link}\n\nIf you did not expect this mail, ignore it and contact the support of ${input.appName}.`,
      };
  }
}
