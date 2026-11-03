import { defineConfig } from "vitest/config";

// The Node tests of authtempo-release (plan 12j): each release check as a pure
// function over fixture workspaces, and its entry over the real tree. The
// limits cover a git call on a loaded machine.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The folder test of check-pack.test.ts counts the private folders of its
    // own pid. A threads pool shares one pid across files, so each file runs in
    // its own fork (ruling 10 of plan 12m).
    pool: "forks",
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
