import type { ResolvedConfig } from "../../config.js";
import { acsUrl, spEntityId } from "../../engine/sso/connections.js";
import { ssoCallbackUrl } from "../../engine/sso/oidc.js";
import { entra } from "./entra.js";
import { genericOidc } from "./generic-oidc.js";
import { genericSaml } from "./generic-saml.js";
import { googleWorkspace } from "./google-workspace.js";
import { okta } from "./okta.js";

/**
 * The IdP guides of plan 13a (spec 6.3). One typed record per provider. The
 * setup pages and the docs site read the same record, so a guide has one
 * source. The IdP is a supplier of identity only: if its admin UI changes,
 * only a guide text goes stale, and the `checkedOn` release check of Task 13
 * (180 days) finds it. Write "admin UI" here, not the lowercase "c" word:
 * the source rule of plan 12h Task 3 reads that word as a call.
 */

/** An SP value that the IT admin copies into the IdP. */
export type SpField = "acsUrl" | "entityId" | "redirectUri" | "scimBaseUrl" | "scimToken";

/** One instruction. `value` names the SP value that the page shows beside it. */
export type GuideStep = { text: string; value?: SpField };

export interface IdpGuide {
  id: string;
  name: string;
  kinds: ("oidc" | "saml")[];
  /** The date (YYYY-MM-DD) that a person read the provider's current docs. */
  checkedOn: string;
  /** The provider's label for each SP value. An empty text: the provider has no field for it. */
  fields: Record<SpField, string>;
  steps: GuideStep[];
  /** How the provider's app tile opens `/sso/<id>/start`, or the gap (it starts with "Gap: "). */
  launch: string;
  /** How the provider sends SCIM, or null when it does not. */
  directory: string | null;
}

export const GUIDES: readonly IdpGuide[] = [okta, entra, googleWorkspace, genericSaml, genericOidc];

/** The guide of one id, or null. */
export function guideOf(id: string): IdpGuide | null {
  return GUIDES.find((g) => g.id === id) ?? null;
}

/** A step with the real value of one connection. */
export interface FilledStep {
  text: string;
  field: SpField | null;
  /** The real value, or null: no field, or the SCIM token (shown once at its mint, never held here). */
  value: string | null;
}

/** A guide with the real values of one connection, for a setup page. */
export interface FilledGuide {
  guide: IdpGuide;
  steps: FilledStep[];
  /** `launch` with `/sso/<id>/start` replaced by the real start URL. */
  launch: string;
}

/** The start route in a guide text. The fill puts the real URL in its place. */
const START_ROUTE = "/sso/<id>/start";

/** The real value of each SP field of a connection. */
function spValues(config: ResolvedConfig, connectionId: string): Record<SpField, string | null> {
  return {
    acsUrl: acsUrl(config, connectionId),
    entityId: spEntityId(config, connectionId),
    redirectUri: ssoCallbackUrl(config, connectionId),
    // The SCIM routes live under `<basePath>/scim/v2` (route-list.ts); the base is one per deployment.
    scimBaseUrl: `${config.baseURL}${config.basePath}/scim/v2`,
    scimToken: null,
  };
}

/** Fills a guide with the real values of one connection. */
export function fillGuide(
  config: ResolvedConfig,
  guide: IdpGuide,
  connectionId: string,
): FilledGuide {
  const values = spValues(config, connectionId);
  const start = `${config.baseURL}${config.basePath}/sso/${connectionId}/start`;
  return {
    guide,
    steps: guide.steps.map((s) => ({
      text: s.text,
      field: s.value ?? null,
      value: s.value === undefined ? null : values[s.value],
    })),
    launch: guide.launch.replaceAll(START_ROUTE, start),
  };
}
