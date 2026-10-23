import type { ConnectionInput } from "@authtempo/core";

/**
 * An Entra ID app registration as an OIDC connection. The issuer holds the
 * "Directory (tenant) ID" in GUID form, because the discovery document of
 * the tenant names that issuer, and core needs the two to be equal.
 */
export function entraOidc(input: {
  organizationId: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
}): ConnectionInput {
  return {
    organizationId: input.organizationId,
    kind: "oidc",
    label: "Sign in with Microsoft",
    issuer: `https://login.microsoftonline.com/${input.tenantId}/v2.0`,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  };
}

/**
 * An Entra ID enterprise app as a SAML connection, from the "Set up" section:
 * the "Login URL", the "Microsoft Entra Identifier", and the Base64 certificate.
 */
export function entraSaml(input: {
  organizationId: string;
  loginUrl: string;
  entraIdentifier: string;
  certificatePem: string;
}): ConnectionInput {
  return {
    organizationId: input.organizationId,
    kind: "saml",
    label: "Sign in with Microsoft",
    idpEntityId: input.entraIdentifier,
    ssoUrl: input.loginUrl,
    certificates: [input.certificatePem],
    // The claim that you add in "Attributes & Claims" with the name email.
    attributes: { email: "email", name: null },
  };
}
