// biome-ignore lint/suspicious/noControlCharactersInRegex: the class names the control characters it refuses.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** True when the string holds a C0 control character or DEL. A CR or LF in a mail subject would inject a header. */
export function hasControlChar(s: string): boolean {
  return CONTROL_RE.test(s);
}

/**
 * The characters that a name or an operator text must not hold (plan 12a
 * Task 7, review L4). Other people see the text, for example in a member
 * list or an audit row. A control character (C0, DEL, C1) or a line or
 * paragraph separator can break a line or a header. A format character,
 * such as a bidi override or a zero-width space, can make one text read as
 * another. A lone surrogate is half of a pair, which is no code point
 * (plan 12f Task 9 review m2). Postgres refuses it in a jsonb value, and
 * stores U+FFFD for it in a text column, so one input would get two
 * answers. The zero-width non-joiner (U+200C) and joiner (U+200D) pass:
 * Persian names and joined emoji carry them (the lead's ruling, 2026-10-15).
 *
 * This one class holds for the user name, the passkey name, the operator
 * reason, and so the ban reason. It holds for the proof reference and the
 * strip of the audit user agent too (plan 12f, final review m5).
 */
const REFUSED_RE = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/u;
// The class of REFUSED_RE, with the global flag, so the test and the strip cannot drift.
const REFUSED_ALL_RE = new RegExp(REFUSED_RE.source, "gu");

/** True when the string holds a character of the refused class (`REFUSED_RE`). */
export function hasRefusedChar(s: string): boolean {
  return REFUSED_RE.test(s);
}

/** The string with each character of `hasRefusedChar` removed (plan 12f: the user agent of an audit row). */
export function removeRefusedChars(s: string): string {
  return s.replace(REFUSED_ALL_RE, "");
}
