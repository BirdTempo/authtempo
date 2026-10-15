import type { MailMessage } from "../config.js";
import { minutesText } from "./email-otp-mail.js";

/**
 * What the proof mail builder of a settings page gets (plan 12a). Core sends
 * each mail to `email`, whatever `to` the builder answers.
 */
export type AccountMailInput =
  | { kind: "reauth_code"; email: string; code: string; ttlMinutes: number; appName: string }
  | { kind: "email_change_link"; email: string; link: string; ttlMinutes: number; appName: string }
  | { kind: "email_change_code"; email: string; code: string; ttlMinutes: number; appName: string }
  | { kind: "email_change_taken"; email: string; appName: string };

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
  }
}
