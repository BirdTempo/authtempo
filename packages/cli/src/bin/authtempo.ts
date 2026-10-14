#!/usr/bin/env node
import { nodeIo } from "../io.js";
import { main } from "../main.js";

// exitCode, not exit(): on macOS a pipe is asynchronous, and exit() can drop
// the last lines of a long output. Every command closes its own clients.
main(process.argv.slice(2), nodeIo()).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // main catches every error of a command; this is a fault of main itself.
    // Only the name prints: a message can quote a secret.
    console.error(`stopped: ${e instanceof Error ? e.name : "error"}`);
    process.exitCode = 2;
  },
);
