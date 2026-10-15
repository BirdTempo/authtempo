import { lastMailedLink, testMode } from "$lib/server/auth";

// TEST_MODE only: the last mailed link. Without TEST_MODE it answers 404.
export const GET = () =>
  testMode()
    ? Response.json({ link: lastMailedLink() })
    : new Response("not found", { status: 404 });
