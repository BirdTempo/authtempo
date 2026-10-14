import { authProxy } from "@authtempo/next";

// A request to /account with no session cookie goes to /sign-in?next=/account.
// The page reads the session itself; the proxy checks only that the cookie is present.
export const proxy = authProxy({
  protect: (pathname) => pathname.startsWith("/account"),
  signInPath: "/sign-in",
});

export const config = { matcher: ["/account/:path*"] };
