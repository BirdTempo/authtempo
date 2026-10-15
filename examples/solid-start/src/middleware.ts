import { authOnRequest } from "@authtempo/solid/start";
import { createMiddleware } from "@solidjs/start/middleware";
import { getAuth } from "./lib/auth";

// The session of every request in locals.session, and /account for a signed-in person only.
export default createMiddleware({
  onRequest: [
    authOnRequest({
      auth: getAuth,
      protect: (pathname) => pathname.startsWith("/account"),
      signInPath: "/sign-in",
    }),
  ],
});
