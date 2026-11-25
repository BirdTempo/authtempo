import type { MailMessage } from "@authtempo/core";
import { createWorker, type Env } from "../../src/index";

// The Worker of src/index.ts with a mail port that keeps each mail. The test
// runs on Node and this Worker runs in workerd, so the route `/__mail` gives
// the kept mails to the test. The route `/__runtime` gives the user agent of
// the runtime, which is "Cloudflare-Workers" in workerd and not on Node.
// Only the test config of this folder uses this file.
const sent: MailMessage[] = [];
const app = createWorker({
  async send(m) {
    sent.push(m);
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__mail") return Response.json(sent);
    if (pathname === "/__runtime") return Response.json({ userAgent: navigator.userAgent });
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
