import type { ConnectionInput } from "@authtempo/core";

/**
 * An Okta app integration of the kind "OIDC - OpenID Connect" as an OIDC
 * connection. The issuer is the org authorization server of the Okta org.
 * Okta gives a new app the method `client_secret_basic`. Pass
 * `client_secret_post` for an app that you set to that method.
 */
export function oktaOidc(input: {
  organizationId: string;
  oktaDomain: string;
  clientId: string;
  clientSecret: string;
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post";
}): ConnectionInput {
  return {
    organizationId: input.organizationId,
    kind: "oidc",
    label: "Sign in with Okta",
    issuer: `https://${input.oktaDomain}`,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? "client_secret_basic",
  };
}

/**
 * An Okta app integration of the kind "SAML 2.0" as a SAML connection, with
 * the sign-in URL, the issuer, and the certificate that "View SAML setup
 * instructions" of the "Sign On" tab shows.
 */
export function oktaSaml(input: {
  organizationId: string;
  ssoUrl: string;
  issuer: string;
  certificatePem: string;
}): ConnectionInput {
  return {
    organizationId: input.organizationId,
    kind: "saml",
    label: "Sign in with Okta",
    idpEntityId: input.issuer,
    ssoUrl: input.ssoUrl,
    certificates: [input.certificatePem],
    // The attribute statement with the name email.
    attributes: { email: "email", name: null },
  };
}
