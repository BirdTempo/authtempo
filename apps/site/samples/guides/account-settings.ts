import { type Clock, createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/**
 * A settings page needs no config key: its routes exist in every deployment.
 * `session.freshMinutes` sets the fresh window. The default is 1440, one day.
 * A shorter window asks the person to prove it again sooner before a change.
 */
export function createAccountAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
  /** Tests move the time. An app leaves it out. */
  clock?: Clock;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    // One hour: a session older than this proves it again before a change.
    session: { freshMinutes: 60 },
    // On by default. `delete: false` removes POST /user/delete.
    // `notices: false` turns the notice mails off.
    account: { delete: true },
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
}
