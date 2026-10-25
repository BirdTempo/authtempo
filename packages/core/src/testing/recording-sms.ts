import type { SmsPort } from "../seams/sms.js";

/** A recording SMS port: what it sent, and a switch that turns it down. */
export interface RecordingSms extends SmsPort {
  /** Each text that the port sent, in order. A send while down is not here. */
  readonly sent: { to: string; text: string }[];
  /** `true`: each send answers "unavailable" and records nothing. `false`: it sends again. */
  down(on: boolean): void;
}

/**
 * An SMS port for tests (plan 12i). It sends nothing: it records each text,
 * so a test reads the code from `sent`. It names no supplier.
 */
export function createRecordingSms(): RecordingSms {
  const sent: { to: string; text: string }[] = [];
  let isDown = false;
  return {
    sent,
    down(on) {
      isDown = on;
    },
    async send(input) {
      if (isDown) return "unavailable";
      sent.push({ to: input.to, text: input.text });
      return "sent";
    },
  };
}
