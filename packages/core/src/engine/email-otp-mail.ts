import type { MailMessage } from "../config.js";

/** What an email code mail builder gets (plan 9e). */
export interface EmailOtpMailInput {
  email: string;
  code: string;
  ttlMinutes: number;
  appName: string;
}

/** "1 minute" for one, "N minutes" otherwise. */
export function minutesText(n: number): string {
  return n === 1 ? "1 minute" : `${n} minutes`;
}

/** The default sign-in code mail. `emailOtp.mail` replaces it. */
export function defaultEmailOtpMail(input: EmailOtpMailInput): MailMessage {
  return {
    to: input.email,
    subject: `Your sign-in code for ${input.appName}`,
    text: `Your code is ${input.code}. It is valid for ${minutesText(input.ttlMinutes)}. If you did not ask for it, ignore this message.`,
  };
}

/** The default reset code mail. `emailOtp.resetMail` replaces it. */
export function defaultResetOtpMail(input: EmailOtpMailInput): MailMessage {
  return {
    to: input.email,
    subject: `Your password reset code for ${input.appName}`,
    text: `Your password reset code for ${input.appName} is ${input.code}. It is valid for ${minutesText(input.ttlMinutes)}.`,
  };
}
