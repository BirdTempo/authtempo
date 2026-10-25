import { type AccountMailInput, defaultAccountMail, type MailMessage } from "@authtempo/core";

/**
 * The account mails of the app. Only the invitation changes here: the other
 * kinds keep the default text. Core sends each mail to the address of the
 * input. The link is the only copy of the token: no answer holds it.
 */
export function inviteMail(input: AccountMailInput): MailMessage {
  if (input.kind !== "user_invite") return defaultAccountMail(input);
  const life = input.ttlHours === 1 ? "1 hour" : `${input.ttlHours} hours`;
  return {
    to: input.email,
    subject: `Your ${input.appName} account is ready`,
    text: [
      `Our support team made an account on ${input.appName} for this address.`,
      `Open this link to sign in. It works once, for ${life}.`,
      "",
      input.link,
      "",
      "Our support team cannot see this link. If you did not ask for an account, ignore this mail.",
    ].join("\n"),
  };
}
