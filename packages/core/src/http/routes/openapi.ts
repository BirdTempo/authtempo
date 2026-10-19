import type { ResolvedConfig } from "../../config.js";
import { deploymentOptions } from "../../openapi/deployment.js";
import { openApiDocument, openApiJson } from "../../openapi/document.js";
import { featuresOf, keyedRoutes } from "../../openapi/features.js";
import { JSON_HEADERS } from "../json.js";
import type { Route } from "../router.js";

/**
 * `GET /openapi.json` (plan 11g), when the config sets `openapi: true`. The
 * route builds the document at its first call and keeps the text.
 * `mounted` answers every route that the router mounts, this one too.
 */
export function openApiRoutes(config: ResolvedConfig, mounted: () => readonly Route[]): Route[] {
  if (!config.openapi) return [];
  let text: string | undefined;
  return [
    {
      method: "GET",
      path: "/openapi.json",
      key: "GET /openapi.json",
      async handler() {
        // The features are those of the mounted routes, read by key, so the document and the
        // router cannot disagree. The answer is public data with no secret; the router's CORS
        // rule applies, as to every route.
        text ??= openApiJson(
          openApiDocument({
            ...deploymentOptions(config),
            features: featuresOf(keyedRoutes(mounted())),
          }),
        );
        return new Response(text, { headers: { ...JSON_HEADERS } });
      },
    },
  ];
}
