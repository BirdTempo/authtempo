/**
 * The phone number (plan 12i, spec 32 item 4). Core takes E.164 only and
 * carries no phone library. Task 3 reads the form at the password sign-in.
 * Task 4 adds the SMS port, the regions, and the code to this file.
 */

/** E.164: a plus, a first digit that is not 0, and 8 to 15 digits in all. */
export const PHONE_RE = /^\+[1-9][0-9]{7,14}$/;
