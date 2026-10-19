// A browser cannot load a Node module.
import { readFileSync } from "node:fs";

export const read = readFileSync;
