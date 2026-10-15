import type { Auth } from "@authtempo/core";
import { authMiddleware, authRouteModule, getSession } from "@authtempo/react-router";
import type { RouteObject } from "react-router";

/**
 * The routes of the app as data routes, in the shape of a framework app: the
 * root route is the parent of every route. In a framework app, each object is
 * a route module: `app/root.tsx` exports `middleware`, and `app/routes/auth.$.ts`
 * exports `loader` and `action` of authRouteModule.
 */
export function createRoutes(
  getAuth: () => Auth,
  // Called at each run of a page loader, with the route id: for a log, or for a test.
  onLoad: (routeId: string) => void = () => {},
): RouteObject[] {
  const auth = authRouteModule(getAuth);
  return [
    {
      id: "root",
      path: "/",
      // The session of every page, and /account for a signed-in person only.
      // The middleware also runs for the routes of core, and reads no session there.
      middleware: [
        authMiddleware({
          auth: getAuth,
          protect: (pathname) => pathname.startsWith("/account"),
          signInPath: "/sign-in",
        }),
      ],
      children: [
        // Every route of core under /auth, the default basePath: a resource route.
        { id: "auth", path: "auth/*", loader: auth.loader, action: auth.action },
        {
          id: "account",
          path: "account",
          // React Router matches a path without case unless the route says so:
          // without this, "/ACCOUNT" runs this loader, and the gate's rule sees
          // "/ACCOUNT", not "/account". Set it on every protected route.
          caseSensitive: true,
          loader: ({ context }) => {
            onLoad("account");
            return { email: getSession(context)?.user.email ?? null };
          },
        },
      ],
    },
  ];
}
