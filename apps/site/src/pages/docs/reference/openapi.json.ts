// The OpenAPI document of every feature (plan 11g, spec 25 item 5). The build
// writes it as the file dist/docs/reference/openapi.json. check-openapi holds
// its bytes to the same call, so the site has one input and one generator.
import { openApiDocument, openApiJson, openApiReferenceOptions } from "@authtempo/core/openapi";

export const prerender = true;

export function GET(): Response {
  return new Response(openApiJson(openApiDocument(openApiReferenceOptions())), {
    headers: { "content-type": "application/json" },
  });
}
