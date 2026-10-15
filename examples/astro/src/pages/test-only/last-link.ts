import type { APIRoute } from "astro";
import { lastMailedLink, testMode } from "../../lib/auth";

// TEST_MODE only: the last mailed link. Without TEST_MODE it answers 404.
export const GET: APIRoute = () =>
  testMode()
    ? Response.json({ link: lastMailedLink() })
    : new Response("not found", { status: 404 });
export const prerender = false;
