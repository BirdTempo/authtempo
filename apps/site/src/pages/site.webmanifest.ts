import type { APIRoute } from "astro";
import { parseTokens } from "../../scripts/lib/tokens.ts";
import { HOME } from "../data/home.ts";
import tokensCss from "../styles/tokens.css?raw";

/** The manifest of brand spec 13: the name, the two PNG icons, and the paper color of tokens.css. */
export const GET: APIRoute = () => {
  const paper = parseTokens(tokensCss).light.get("--at-paper") ?? "";
  const manifest = {
    name: HOME.title,
    short_name: HOME.title,
    description: HOME.description,
    start_url: "/",
    display: "browser",
    background_color: paper,
    theme_color: paper,
    icons: [
      { src: "/favicon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
  return new Response(`${JSON.stringify(manifest, null, 2)}\n`, {
    headers: { "content-type": "application/manifest+json" },
  });
};
