import { PROVIDER_NAME_RE } from "../social/provider.js";

/**
 * A provider route as ROUTES writes it: one template for every provider,
 * except Apple's POST callback (plan 11a). The provider segment is read with
 * `PROVIDER_NAME_RE` on its own, so the name rule has one source. Any other
 * path is its own key.
 */
export function routeKeyOf(method: string, path: string): string {
  const [head, social, provider, step, ...rest] = path.split("/");
  const providerStep =
    rest.length === 0 &&
    head === "" &&
    social === "social" &&
    provider !== undefined &&
    PROVIDER_NAME_RE.test(provider) &&
    (step === "start" || step === "callback" || step === "link");
  // Apple's POST callback is its own entry; its link is not.
  if (providerStep && !(method === "POST" && provider === "apple" && step === "callback"))
    return `${method} /social/:provider/${step}`;
  return `${method} ${path}`;
}
