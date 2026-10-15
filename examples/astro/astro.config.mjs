import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// Every page renders on demand: the middleware reads the session per request.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  security: {
    // Astro takes the request's host from the Host header only for a host in
    // this list; for any other host the origin is localhost:<port>. The gate
    // builds the sign-in redirect from that origin, and Astro's origin check
    // refuses a form post from the app's own host. List the host of your
    // deploy here. 127.0.0.1:8794 is the host of the example's proof.
    allowedDomains: [{ protocol: "http", hostname: "127.0.0.1", port: "8794" }],
  },
});
