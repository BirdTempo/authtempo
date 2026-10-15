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
          // React Router matches a path without case unless the route says so.
          // The binding folds case for protect, so "/ACCOUNT" still needs a
          // session; with this option it is a 404. Set it on every protected route.
          caseSensitive: true,
          loader: ({ context }) => {
            onLoad("account");
            return { email: getSession(context)?.user.email ?? null };
          },
        },
        {
          // The splat route of the account area. The prefix rule of protect
          // covers it: an exact rule would miss "/account/x", and "/account/.."
          // of a data request, which this route matches too.
          id: "account-rest",
          path: "account/*",
          caseSensitive: true,
          loader: ({ params, context }) => {
            onLoad("account-rest");
            return { path: params["*"] ?? "", email: getSession(context)?.user.email ?? null };
          },
        },
      ],
    },
  ];
}
