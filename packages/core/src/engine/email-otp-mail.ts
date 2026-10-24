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

/**
 * The default mail of the sign-up code (plan 12i Task 20). The text starts
 * with the code, as the phone text does. `password.verifyCodeMail` replaces it.
 */
export function defaultVerifyCodeMail(input: EmailOtpMailInput): MailMessage {
  return {
    to: input.email,
    subject: `Confirm your email for ${input.appName}`,
    text: `${input.code} is your ${input.appName} code to confirm your address. It expires in ${minutesText(input.ttlMinutes)}.\n\nIf you did not create an account, ignore this message.`,
  };
}

/** The default mail of a second-factor email code (plan 12c). `totp.emailMail` replaces it. */
export function defaultSecondFactorMail(input: EmailOtpMailInput): MailMessage {
  return {
    to: input.email,
    subject: `Your sign-in code for ${input.appName}`,
    text: `Your second-factor code for ${input.appName} is ${input.code}. It is valid for ${minutesText(input.ttlMinutes)}. If you did not sign in just now, change your password.`,
  };
}
