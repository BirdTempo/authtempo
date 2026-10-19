// The API after the move of the guide "From WorkOS".
import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailPort,
  type StorageAdapter,
} from "@authtempo/core";

/**
 * WorkOS exports no password hash (owner decision 1 of 2026-10-14). A moved
 * user signs in by a magic link, or sets a password by a reset.
 */
export function createWorkosAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    magicLink: {
      // The default link, written out: it opens the confirm page of the API.
      linkBuilder: (token) =>
        `https://api.example.com/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    },
    password: {
      // No hash moves, so no legacy seam: every password is a new PBKDF2 hash.
      hash: createPbkdf2PasswordHash(),
    },
    // The organizations and the members of the WorkOS export.
    organizations: {},
  });
}
