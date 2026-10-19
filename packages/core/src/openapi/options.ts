import { DEFAULT_BASE_PATH } from "../bindings.js";
import type { ResolvedConfig } from "../config.js";
import { BUILT_IN_SCOPES } from "../engine/oauth-result.js";
import { ROUTE_FEATURES } from "../http/route-list.js";
import { coreRoutes } from "../http/routes/index.js";
import { DEFAULT_COOKIE_NAME } from "../primitives/credentials.js";
import { VERSION } from "../version.js";
import { deploymentOptions, type OpenApiOptions } from "./deployment.js";
import { featuresOf, keyedRoutes } from "./features.js";

export type { OpenApiOptions } from "./deployment.js";

/** The input of the document of a config: its deployment keys and the features of the routes that it mounts. */
export function openApiOptionsFrom(config: ResolvedConfig): OpenApiOptions {
  return { ...deploymentOptions(config), features: featuresOf(keyedRoutes(coreRoutes(config))) };
}

/**
 * The input of the site's document: every feature, the default `basePath` and
 * `cookieName`, the built-in scopes, and `VERSION`, with no server. The site
 * file and its byte check both read it, so the compare has one input.
 */
export function openApiReferenceOptions(): OpenApiOptions {
  return {
    basePath: DEFAULT_BASE_PATH,
    cookieName: DEFAULT_COOKIE_NAME,
    features: new Set(ROUTE_FEATURES),
    scopes: BUILT_IN_SCOPES,
    version: VERSION,
  };
}
