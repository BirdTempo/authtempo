// Vite's `?raw` import: a file's text (plan 12a fix wave, fresh-list.test.ts).
// Core's tests have no Node types, so they read another package's file this way.
declare module "*?raw" {
  const text: string;
  export default text;
}
