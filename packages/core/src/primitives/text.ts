// biome-ignore lint/suspicious/noControlCharactersInRegex: the class names the control characters it refuses.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// The class of CONTROL_RE, with the global flag, so the two rules cannot drift.
const CONTROL_ALL_RE = new RegExp(CONTROL_RE.source, "g");

/** True when the string holds a C0 control character or DEL. A CR or LF in a mail subject would inject a header. */
export function hasControlChar(s: string): boolean {
  return CONTROL_RE.test(s);
}

/** The string with each character of `hasControlChar` removed (plan 12f: the user agent of an audit row). */
export function removeControlChars(s: string): string {
  return s.replace(CONTROL_ALL_RE, "");
}
