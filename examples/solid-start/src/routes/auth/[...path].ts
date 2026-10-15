import { authRouteHandlers } from "@authtempo/solid/start";
import { getAuth } from "../../lib/auth";

// Every route of core under /auth, the default basePath. Each method is its
// own named export: the file router of Solid Start reads the export names.
const handlers = authRouteHandlers(getAuth);
export const GET = handlers.GET;
export const POST = handlers.POST;
export const OPTIONS = handlers.OPTIONS;
