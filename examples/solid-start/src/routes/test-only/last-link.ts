import { lastMailedLink, testMode } from "../../lib/auth";

// TEST_MODE only: the last mailed link. Without TEST_MODE it answers 404.
export function GET() {
  return testMode()
    ? Response.json({ link: lastMailedLink() })
    : new Response("not found", { status: 404 });
}
