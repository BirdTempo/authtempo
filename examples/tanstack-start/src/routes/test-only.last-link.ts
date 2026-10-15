import { createFileRoute } from "@tanstack/react-router";
import { lastMailedLink, testMode } from "../lib/auth";

// TEST_MODE only: the last mailed link. Without TEST_MODE it answers 404.
export const Route = createFileRoute("/test-only/last-link")({
  server: {
    handlers: {
      GET: () =>
        testMode()
          ? Response.json({ link: lastMailedLink() })
          : new Response("not found", { status: 404 }),
    },
  },
});
