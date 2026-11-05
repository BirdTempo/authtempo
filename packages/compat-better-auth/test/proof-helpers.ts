/**
 * The cookie of core's sign-up proof that a sign-up answer set (ruling 11 of
 * plan 12q), as a `cookie` header value. A confirm that carries it keeps the
 * sign-up's password. A confirm without it deletes that password.
 */
export function proofOf(res: Response): string {
  const pair = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-tempo_signup="))
    ?.split(";")[0];
  if (!pair) throw new Error(`the sign-up answered ${res.status} with no proof cookie`);
  return pair;
}

/** The proof cookie of a server sign-up's answer (plan 12q): the cookie that the app sets. */
export const proofCookieOf = (answer: { signUpProof: string }) =>
  `__Host-tempo_signup=${answer.signUpProof}`;
