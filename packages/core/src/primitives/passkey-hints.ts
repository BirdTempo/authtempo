/**
 * The `PublicKeyCredentialHint` values of WebAuthn Level 3 (read 2026-10-14,
 * plan 12i). A hint is advice to the browser, not a filter. So the engine
 * writes `hints` into the options JSON after the seam answers, and never
 * sets `authenticatorAttachment` for a hint (ruling 1 of plan 12i). This file
 * imports nothing, so the route contracts read it without the WebAuthn library.
 */
export const PASSKEY_HINTS = ["security-key", "client-device", "hybrid"] as const;
export type PasskeyHint = (typeof PASSKEY_HINTS)[number];
