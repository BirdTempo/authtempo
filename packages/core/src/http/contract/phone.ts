import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { OkAnswer, SentAnswer, SignedInAnswer, TwoFactorChallenge } from "./shapes.js";
import type { RouteContract } from "./types.js";

// The engine checks E.164 and the regions; these caps only bound the input.
const typedPhone = z.string().max(32);
const typedCode = z.string().max(16);

export const requestBody = z.strictObject({ phone: typedPhone });
export const verifyBody = z.strictObject({
  phone: typedPhone,
  code: typedCode,
  // A native app's trust token (plan 12c); a browser sends the cookie.
  trustDevice: z.string().max(64).optional(),
});
export const addBody = z.strictObject({ phone: typedPhone });
export const addVerifyBody = z.strictObject({ code: typedCode });
export const removeBody = z.strictObject({});

/** The contract of `routes/phone.ts` (plan 12i Task 5). */
export const PHONE_CONTRACT = {
  "POST /phone/request": {
    body: { schema: requestBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SentAnswer },
  },
  "POST /phone/verify": {
    body: { schema: verifyBody, media: ["json"], parsedBy: "zod" },
    // The session, or the challenge of a user with the second factor on.
    answer: { kind: "json", schema: z.union([SignedInAnswer, TwoFactorChallenge]) },
  },
  "POST /phone/add": {
    body: { schema: addBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: SentAnswer },
  },
  "POST /phone/add/verify": {
    body: { schema: addVerifyBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: z.strictObject({ phone: z.string() }) },
  },
  "POST /phone/remove": {
    body: { schema: removeBody, media: ["json"], parsedBy: "zod" },
    answer: { kind: "json", schema: OkAnswer },
  },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
