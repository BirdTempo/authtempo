export interface SignInPageInput {
  /** The path prefix of the auth routes, for the page's fetch calls and links. */
  basePath: string;
  /** The path the browser visits after any sign-in completes; carries the handoff id. */
  continuePath: string;
  /** Which methods the config enables. */
  methods: { magicLink: true; google: boolean; apple: boolean; passkey: boolean };
  /** The script nonce the policy header names. */
  nonce: string;
}

/** Task 5 of plan 5a replaces this with the real page. */
export function defaultSignInPage(_input: SignInPageInput): string {
  return "<!doctype html><title>Sign in</title>";
}
