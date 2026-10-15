import { authRouteHandlers } from "@authtempo/tanstack-start";
import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "../lib/auth";

// Every route of core under /auth, the default basePath.
export const Route = createFileRoute("/auth/$")({
  server: { handlers: authRouteHandlers(getAuth) },
});
