/**
 * The Worker's input: input/import.local.json in wrangler, the sample
 * input/import.json in the D1 tests (the aliases in worker/wrangler.jsonc and
 * vitest.d1.config.ts). Unknown here, so the Worker must check it.
 */
declare module "authtempo-import-input" {
  const input: unknown;
  export default input;
}
