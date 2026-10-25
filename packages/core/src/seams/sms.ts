/**
 * The send-only SMS port (plan 12i, spec 32 item 4). The supplier sends
 * text. Core keeps every promise about a code (plan 12i Global
 * Constraints): it makes the code, keys its hash, binds it to its number
 * and purpose, counts each guess, and counts every send against the daily
 * cap. So a change of supplier cannot break a limit that core promises.
 */
export interface SmsPort {
  /** Sends text. Never makes, checks, or limits a code. A throw counts as "unavailable". */
  send(input: { to: string; text: string }): Promise<"sent" | "unavailable">;
}
