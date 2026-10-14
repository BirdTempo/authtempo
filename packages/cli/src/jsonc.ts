/** The index after the closing quote of the string that starts at `i`. A backslash skips the next character. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === "\\" ? 2 : 1;
  return j + 1;
}

/**
 * Parses JSON with comments and trailing commas: the form of wrangler.jsonc
 * (plan 11c). Our own code, so no parser library joins the CLI. A comment
 * mark or a comma inside a string stays part of the string. It imports no
 * Node.js module.
 */
export function parseJsonc(text: string): unknown {
  // Pass 1: the comments outside strings go.
  let plain = "";
  for (let i = 0; i < text.length; ) {
    const c = text.charAt(i);
    if (c === '"') {
      const end = stringEnd(text, i);
      plain += text.slice(i, end);
      i = end;
    } else if (c === "/" && text.charAt(i + 1) === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i++;
    } else if (c === "/" && text.charAt(i + 1) === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      plain += c;
      i++;
    }
  }
  // Pass 2: a comma whose next mark is a closing bracket or brace goes.
  let out = "";
  for (let i = 0; i < plain.length; ) {
    const c = plain.charAt(i);
    if (c === '"') {
      const end = stringEnd(plain, i);
      out += plain.slice(i, end);
      i = end;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < plain.length && /\s/.test(plain.charAt(j))) j++;
      if (plain.charAt(j) !== "}" && plain.charAt(j) !== "]") out += c;
    } else out += c;
    i++;
  }
  return JSON.parse(out);
}
