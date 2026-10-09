import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

const BASE = "https://example.test";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const start = (redirect: string) =>
  SELF.fetch(
    `${BASE}/auth/handoff/start?challenge=${CHALLENGE}&redirect=${encodeURIComponent(redirect)}`,
  );

it("admits the Expo Go redirect that DEV_REDIRECT_PATTERN names", async () => {
  const res = await start("exp://192.168.1.20:8081/--/auth");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('data-continue="/auth/handoff/continue?h=hs_');
});

it("refuses an Expo Go redirect on another address", async () => {
  const res = await start("exp://10.0.0.9:8081/--/auth");
  expect(res.status).toBe(400);
});
