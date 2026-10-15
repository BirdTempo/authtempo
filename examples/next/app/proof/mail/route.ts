import { proofMail, proofMailOn } from "../../../lib/auth";

// For proof/next-start.mjs only: 404 unless AUTHTEMPO_PROOF_MAIL=1. Delete it when you copy the example.
export const dynamic = "force-dynamic";

export function GET(): Response {
  if (!proofMailOn()) return new Response("not found", { status: 404 });
  const m = proofMail();
  return m ? Response.json({ text: m.text }) : new Response("no mail", { status: 404 });
}
