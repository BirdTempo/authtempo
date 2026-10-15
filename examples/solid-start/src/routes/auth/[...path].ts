import { authRouteHandlers } from "@authtempo/solid/start";
import { getAuth } from "../../lib/auth";

// Every route of core under /auth, the default basePath. Each method is its
// own named export: the file router of Solid Start reads the export names.
// Export every method: a method with no export falls through to the pages,
// and a catch-all page would run with no session. HEAD falls back to GET.
const handlers = authRouteHandlers(getAuth);
export const GET = handlers.GET;
export const POST = handlers.POST;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
export const DELETE = handlers.DELETE;
export const OPTIONS = handlers.OPTIONS;
