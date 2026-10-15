import { defineEventHandler } from "h3";
import { lastMailedLink, testMode } from "../../utils/auth";

// TEST_MODE only: the last mailed link. Without TEST_MODE it answers 404.
export default defineEventHandler(() =>
  testMode()
    ? Response.json({ link: lastMailedLink() })
    : new Response("not found", { status: 404 }),
);
