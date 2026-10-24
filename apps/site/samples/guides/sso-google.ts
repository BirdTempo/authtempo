import type { ConnectionInput } from "@authtempo/core";

/**
 * A Google Cloud OAuth client of the type "Web application" as an OIDC
 * connection. Any Google account can sign in to such a client, so core
 * refuses each address outside the verified domains of the organization.
 */
export function googleOidc(input: {
  organizationId: string;
  clientId: string;
  clientSecret: string;
}): ConnectionInput {
  return {
    organizationId: input.organizationId,
    kind: "oidc",
    label: "Sign in with Google",
    issuer: "https://accounts.google.com",
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  };
}

/**
 * A custom SAML app of Google Workspace as a SAML connection, from "Google
 * Identity Provider details": the "SSO URL", the "Entity ID", and the
 * certificate. Its "Download IDP metadata" file goes in `idpMetadata` in
 * place of the three fields.
 */
export function googleSaml(input: {
  organizationId: string;
  ssoUrl: string;
  entityId: string;
  certificatePem: string;
}): ConnectionInput {
  return {
    organizationId: input.organizationId,
    kind: "saml",
    label: "Sign in with Google",
    idpEntityId: input.entityId,
    ssoUrl: input.ssoUrl,
    certificates: [input.certificatePem],
    // The app attribute that "Add mapping" maps from the primary email.
    attributes: { email: "email", name: null },
  };
}
