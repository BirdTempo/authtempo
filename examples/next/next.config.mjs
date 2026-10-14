/**
 * Next 16.4.0 type-checks a build with the `typescript` package. The repo pins
 * TypeScript 7.0.2, which has no JavaScript API, so the build skips the step,
 * and `pnpm typecheck` runs tsc on this app as on every package (plan 11d).
 * @type {import("next").NextConfig}
 */
const config = {
  typescript: { ignoreBuildErrors: true },
};

export default config;
