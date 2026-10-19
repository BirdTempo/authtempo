// A Node builtin with no node: prefix.
// biome-ignore lint/style/useNodejsImportProtocol: the copy must fail a builtin with no prefix too.
import { readFileSync } from "fs";

export const read = readFileSync;
