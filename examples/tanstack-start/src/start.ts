import { authRequestServer } from "@authtempo/tanstack-start";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { getAuth } from "./lib/auth";

// The session of every request in the context, and /account for a signed-in person only.
const session = createMiddleware({ type: "request" }).server(
  authRequestServer({
    auth: getAuth,
    protect: (pathname) => pathname.startsWith("/account"),
    signInPath: "/sign-in",
  }),
);

export const startInstance = createStart(() => ({ requestMiddleware: [session] }));
