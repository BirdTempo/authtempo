import { describe, expect, it } from "vitest";
import { API, APP, codeIn, harness } from "../support/harness.ts";
import { createCodeProofAuth } from "./verify-by-code.ts";

const post = (path: string, body: unknown) =>
  new Request(`${API}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify(body),
  });

describe("prove the address at sign-up by a code", () => {
  it("mails a code, and the code opens the session", async () => {
    const h = harness();
    const auth = createCodeProofAuth(h);
    const work: Promise<unknown>[] = [];
    // The code goes out after the answer: give handle the waitUntil of your host.
    const up = await auth.handle(
      post("/password/sign-up", { email: "ada@example.com", password: "correct horse battery" }),
      { waitUntil: (p) => void work.push(p) },
    );
    // A native app keeps the sign-up proof and sends it with the code, so the password stays.
    const { signUpProof } = (await up.json()) as { sent: true; signUpProof: string };
    await Promise.all(work);
    const code = codeIn(h, "ada@example.com");
    const res = await auth.handle(
      post("/password/verify/code", { email: "ada@example.com", code, signUpProof }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passwordKept: true });
    expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-tempo_session=/);
  });

  it("answers invalid_code for a wrong code and for an address with no code", async () => {
    const auth = createCodeProofAuth(harness());
    const res = await auth.handle(
      post("/password/verify/code", { email: "nobody@example.com", code: "123456" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_code" });
  });
});
