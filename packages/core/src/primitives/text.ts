// biome-ignore lint/suspicious/noControlCharactersInRegex: the class names the control characters it refuses.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** True when the string holds a C0 control character or DEL. A CR or LF in a mail subject would inject a header. */
export function hasControlChar(s: string): boolean {
  return CONTROL_RE.test(s);
}
