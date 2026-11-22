import type { SamlStep } from "../../saml/assertion.js";
import type { OidcStep } from "./steps.js";

/**
 * The help line of each step that a test run can fail at (plan 13a Task 7). The line is fixed
 * text, so the page never shows a raw message of the IdP or a part of an assertion. A provider
 * guide may add its own lines later. These lines hold for each provider. A step added to a
 * union and not listed here fails the compile.
 */
const HELP: Readonly<Record<OidcStep | SamlStep, string>> = {
  discovery:
    "Core could not read the settings of the IdP. Check that the issuer address is correct.",
  discovery_host: "The IdP gave an address that core does not call. Use a public https address.",
  secret: "Core could not open the client secret. Enter the client secret again.",
  state: "The test sign-in expired or was used twice. Start the test again.",
  state_connection: "The test sign-in belongs to another connection. Start the test again.",
  binding: "The browser that returned is not the browser that started the test. Start it again.",
  code: "The IdP sent no code. Check the redirect address and the access of the app in the IdP.",
  exchange:
    "The IdP refused the code. Check the client ID, the client secret, and the redirect address.",
  id_token:
    "The ID token did not pass. Check the issuer, the client ID, and the signing keys of the IdP.",
  nonce: "The ID token did not answer this test. Start the test again.",
  subject:
    "The IdP sent no usable subject for the person. Check the attribute that names the person.",
  form: "The IdP sent no usable form. Check that the IdP posts the SAML response to the ACS address.",
  request: "The response does not answer this test. Start the test again from this page.",
  parse: "The SAML response is not valid XML. Check the settings of the IdP.",
  wrapping: "The SAML response has an unexpected shape. Check the settings of the IdP.",
  signature_shape:
    "The signature of the SAML response has an unexpected shape. Check the IdP signing settings.",
  algorithm: "The IdP signs with an algorithm that core does not accept. Use RSA-SHA256 or ECDSA.",
  reference: "The signature does not cover the assertion. Sign the assertion in the IdP.",
  digest: "The digest of the assertion does not match. Check that nothing changes the response.",
  signature:
    "The signature does not match the certificate. Upload the current signing certificate.",
  status: "The IdP did not report success. Check that the person has access to the app in the IdP.",
  destination: "The response names another ACS address. Set the ACS address of the IdP as shown.",
  issuer: "The issuer of the response differs from the entity ID of the IdP. Check the entity ID.",
  conditions: "The time limits of the assertion are not valid now. Check the clock of the IdP.",
  audience:
    "The audience of the assertion differs from the entity ID of the service. Set it as shown.",
  subject_confirmation:
    "The assertion does not confirm the person for this request. Start the test again.",
  authn_statement:
    "The sign-in statement of the assertion is not valid. Check the settings of the IdP.",
  request_spent: "The test sign-in was used before. Start the test again.",
  replay: "The assertion was used before. Start the test again.",
  address: "The IdP sent no email address. Map the email attribute in the IdP.",
};

/** The help line of a step, or a general line for a name that is not a step. */
export function stepHelp(step: string): string {
  return (
    (HELP as Readonly<Record<string, string | undefined>>)[step] ??
    "The test did not pass. Start the test again."
  );
}
