import { authHandle } from "@authtempo/sveltekit";
import { getAuth } from "$lib/server/auth";

// Every route of core under /auth, the session of every page in locals.session,
// and /account for a signed-in person only.
export const handle = authHandle({
  auth: getAuth,
  protect: (pathname) => pathname.startsWith("/account"),
  signInPath: "/sign-in",
});
