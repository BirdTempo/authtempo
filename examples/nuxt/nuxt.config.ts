import { defineNuxtConfig } from "nuxt/config";

export default defineNuxtConfig({
  compatibilityDate: "2026-10-01",
  // The build runs offline after the install: no telemetry and no devtools.
  telemetry: false,
  devtools: { enabled: false },
  // The session middleware reads the path as it came, decoded once. Vue Router
  // matches a path in any case by default, so "/ACCOUNT" would render the page
  // of "/account" past a protect rule that reads "/account" (probed 2026-10-15).
  // A case-sensitive router renders a page only for the path the gate read.
  router: { options: { sensitive: true } },
});
