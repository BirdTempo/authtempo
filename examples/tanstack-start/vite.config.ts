import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";

// The JSX of the root route: vite 8.3.3's Oxc with the automatic runtime.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  plugins: [tanstackStart()],
});
