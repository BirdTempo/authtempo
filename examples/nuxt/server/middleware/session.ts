import { authSessionHandler } from "@authtempo/vue/nuxt";
import { getAuth } from "../utils/auth";

// The session of every request in event.context.session, and /account for a signed-in person only.
export default authSessionHandler({
  auth: getAuth,
  protect: (pathname) => pathname.startsWith("/account"),
  signInPath: "/sign-in",
});
