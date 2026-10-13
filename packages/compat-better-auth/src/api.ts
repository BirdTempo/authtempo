// `better-auth/api` under the alias (plan 9b). The one name the owner's apps
// import from it that authtempo keeps is `APIError`, in both of its
// constructor forms (plan 9d). Core has no request hooks (plan 9d), so
// `createAuthMiddleware` and `getSessionFromCtx` are not here, and an import
// of one fails at build with the missing name: wrap the handler instead
// (README, "Request hooks").
export { APIError } from "./errors.js";
