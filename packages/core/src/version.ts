/**
 * The version of core. Two readers import this module, never the package
 * barrel: `GET /operator/info` answers it (plan 11c2), and the OpenAPI
 * generator writes it (plan 11g), so the document reads no barrel and no
 * config value.
 */
export const VERSION = "0.0.0";
