import { defineConfig } from "vitest/config";

// The Node tests of authtempo-release (plan 12j): each release check as a pure
// function over fixture workspaces, and its entry over the real tree. The
// limits cover a git call on a loaded machine.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
