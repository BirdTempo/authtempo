import { authRouteHandlers } from "@authtempo/next";
import { getAuth } from "../../../lib/auth";

// Every route of core under /auth, the default basePath.
export const { GET, POST, OPTIONS } = authRouteHandlers(getAuth);
