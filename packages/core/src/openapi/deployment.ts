import type { ResolvedConfig } from "../config.js";
import { BUILT_IN_SCOPES } from "../engine/oauth-result.js";
import type { RouteFeature } from "../http/route-list.js";
import { VERSION } from "../version.js";

/**
 * The input of the OpenAPI document (plan 11g, spec 25 item 5): six keys, and
 * no secret. A test fails when a known secret of a config reaches it.
 */
export interface OpenApiOptions {
  /** The origin of the deployment. With none, the document has a server variable. */
  serverUrl?: string;
  basePath: string;
  cookieName: string;
  features: ReadonlySet<RouteFeature>;
  /** The scope names and their consent texts, the built-in scopes first. */
  scopes: ReadonlyMap<string, string>;
  version: string;
}

/**
 * The five keys of a deployment that the document reads, and nothing else of
 * the config. This module imports no route module, so the opt-in route can
 * import it with no import cycle.
 */
export function deploymentOptions(config: ResolvedConfig): Omit<OpenApiOptions, "features"> {
  return {
    serverUrl: config.baseURL,
    basePath: config.basePath,
    cookieName: config.cookieName,
    scopes: config.oauth?.scopes ?? BUILT_IN_SCOPES,
    version: VERSION,
  };
}
