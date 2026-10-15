import { authMiddleware } from "@authtempo/astro";
import { getAuth } from "./lib/auth";

// The session of every page in Astro.locals.session, and /account for a signed-in person only.
export const onRequest = authMiddleware({
  auth: getAuth,
  protect: (pathname) => pathname.startsWith("/account"),
  signInPath: "/sign-in",
});
