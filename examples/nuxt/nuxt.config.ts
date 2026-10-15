import { defineNuxtConfig } from "nuxt/config";

export default defineNuxtConfig({
  compatibilityDate: "2026-10-01",
  // The build runs offline after the install: no telemetry and no devtools.
  telemetry: false,
  devtools: { enabled: false },
});
