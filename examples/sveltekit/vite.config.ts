import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// SvelteKit 3 reads its config from the plugin; it refuses a svelte.config.js file.
// adapter-node 6.0.0 reads no ORIGIN at run time: it writes paths.origin into
// the build. Unset, the origin is https:// plus the Host header, which fits a
// deploy behind TLS. The proof runs over plain HTTP, so its build sets ORIGIN;
// without it the sign-in redirect would go to https://127.0.0.1.
const origin = process.env.ORIGIN;

export default defineConfig({
  plugins: [sveltekit({ adapter: adapter(), ...(origin ? { paths: { origin } } : {}) })],
});
