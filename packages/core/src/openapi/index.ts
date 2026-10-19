/**
 * The entry `@authtempo/core/openapi` (plan 11g). It exports the contract of
 * every route and the types that a client holds its own types to. It also
 * exports the generator of the OpenAPI document.
 */
export {
  type AnswerOf,
  type BodyOf,
  type QueryOf,
  ROUTE_CONTRACT,
} from "../http/contract/index.js";
export type { AnswerKind, RouteContract } from "../http/contract/types.js";
export { deploymentOptions, type OpenApiOptions } from "./deployment.js";
export { type OpenApiDoc, openApiDocument, openApiJson } from "./document.js";
export { FEATURE_INFO, featuresOf } from "./features.js";
export { openApiOptionsFrom, openApiReferenceOptions } from "./options.js";
