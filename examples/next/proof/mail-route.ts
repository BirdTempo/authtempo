// The proof's mail sink (proof/next-start.mjs). The proof copies this file to
// app/proof/mail/route.ts for its own build and deletes it after, so the
// example app never ships it. It answers 404 unless AUTHTEMPO_PROOF_MAIL=1,
// which only the proof sets. Its first call makes the app's one auth instance
// with a mail port that keeps the last mail, so the proof calls it first.
import type { Auth, MailMessage } from "@authtempo/core";
import { createAppAuth } from "../../../lib/auth";

export const dynamic = "force-dynamic";

const shared = globalThis as typeof globalThis & { __myAppAuth?: Auth; __proofMail?: MailMessage };

export function GET(): Response {
  if (process.env.AUTHTEMPO_PROOF_MAIL !== "1") return new Response("not found", { status: 404 });
  let armed = false;
  if (!shared.__myAppAuth) {
    shared.__myAppAuth = createAppAuth({
      baseURL: process.env.BASE_URL ?? "",
      secret: process.env.AUTH_SECRET ?? "",
      mail: {
        async send(m) {
          shared.__proofMail = m;
        },
      },
    });
    armed = true;
  }
  return Response.json({ armed, text: shared.__proofMail?.text ?? null });
}
