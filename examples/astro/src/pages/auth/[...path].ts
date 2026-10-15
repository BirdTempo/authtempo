import { authRoute } from "@authtempo/astro";
import { getAuth } from "../../lib/auth";

// Every route of core under /auth, the default basePath.
export const ALL = authRoute(getAuth);
export const prerender = false;
