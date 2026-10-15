import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// Every page renders on demand: the middleware reads the session per request.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
});
