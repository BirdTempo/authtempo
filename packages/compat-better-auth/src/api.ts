// `better-auth/api` under the alias (plan 9b). The one name the owner's apps
// import from it that tempo-auth keeps is `APIError`. `createAuthMiddleware`,
// `getSessionFromCtx`, and the hook helpers need hooks (plan 9d), so they are
// not here, and an import of one fails at build with the missing name.
export { APIError } from "./errors.js";
