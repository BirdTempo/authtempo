import { DEMO_LIMITS, type GateLimit } from "../facts.js";
import { html } from "../html.js";
import { utcTime } from "./layout.js";

/** Each refusal of the Worker that a browser can meet on a page view. */
export type Refusal = GateLimit | "requestsPerIpPerMinute" | "cross_site";

/** The title and the paragraphs of the page of one refusal. `retryAt` is in ms since the epoch. */
export function refusedText(refusal: Refusal, retryAt: number): { title: string; lines: string[] } {
  const again = `Try again after ${utcTime(retryAt)}.`;
  switch (refusal) {
    case "sandboxesPerIp":
      return {
        title: "The demo limit is reached",
        lines: [
          `This address made ${DEMO_LIMITS.sandboxesPerIp} sandboxes in the last hour. That is the limit sandboxesPerIp.`,
          "A shared address, as of an office or a phone network, counts as one visitor.",
          again,
        ],
      };
    case "sandboxesTotal":
      return {
        title: "The demo limit is reached",
        lines: [
          `All visitors made ${DEMO_LIMITS.sandboxesTotal} sandboxes in the last hour. That is the limit sandboxesTotal.`,
          again,
        ],
      };
    case "requestsPerIpPerMinute":
      return {
        title: "The demo limit is reached",
        lines: [
          `This address sent more than ${DEMO_LIMITS.requestsPerIpPerMinute} requests in one minute. That is the limit requestsPerIpPerMinute.`,
          again,
        ],
      };
    case "cross_site":
      return {
        title: "The demo did not start again",
        lines: [
          "Another site sent this request, so the demo refused it.",
          "To start again, use the Start again button of a demo page.",
        ],
      };
  }
}

/**
 * The page of a refused view (final review Low 3 of plan 11b). A refusal has
 * no sandbox, so the page has the style sheets and the title, and no page list.
 */
export function refusedPage(status: number, refusal: Refusal, retryAt: number): Response {
  const { title, lines } = refusedText(refusal, retryAt);
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - authtempo demo</title>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/demo.css">
</head>
<body>
<header class="top"><a class="brand" href="/">authtempo demo</a></header>
<main>
<h1>${title}</h1>
${lines.map((line) => html`<p>${line}</p>`)}
</main>
</body>
</html>
`;
  return new Response(doc.__html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
